#!/usr/bin/env node
/**
 * 数据回流：把每日简报里沉淀的「行业价格 / 事件信号」抽取成结构化条目，
 * 追加写入本地知识库纵向卡 `D:/工作/4市场/_卡片/行业价格信号与事件演进.md`。
 *
 * 设计目标（接上「关键数字演进」卡片方法论）：
 *   - 让简报从「抓→推→完」升级为「抓→推→回流」，价格脉络可纵向回查
 *     （如「过去半年锦纶 6 的价格信号脉络」）。
 *   - 信号卡按「品种」分栏，每条记「日期 + 方向 + 数值 + 来源」，长期累积成时间线。
 *   - 幂等：以「日期锚点」判重，同一天已写入则跳过，绝不重复追加。
 *
 * 数据源（三选一，按优先级）：
 *   1) 环境变量 BRIEFING_DATE → 读 data/<日期>.json 的 highpoints/sections
 *   2) 命令行参数 <日期>（如 node backfill_signals.js 2026-10-14）
 *   3) 缺省 → 读仓库根 notify.json 的 date（当日简报）
 *
 * 运行方式（GitHub Actions 内，每日构建/推送之后）：
 *   node scripts/backfill_signals.js
 * 环境变量：
 *   LLM_API_KEY / LLM_BASE_URL / LLM_MODEL  与 build_briefing.js 完全一致（复用 callLLM）
 *   SIGNALS_CARD_PATH  信号卡绝对路径，缺省 = D:/工作/4市场/_卡片/行业价格信号与事件演进.md
 *                        （本机为 Windows 盘符路径；Actions 里本脚本只生成 repo 内快照，
 *                         真正的本机写卡由「本地同步」环节完成——见 workflow 注释。）
 *   REPO_SIGNALS_SNAPSHOT  Actions 内落盘的快照路径（相对仓库根），缺省 data/signals_snapshot.json
 */
const fs = require('fs');
const path = require('path');

// ===== 复用 build_briefing 的 LLM 能力 =====
const { callLLM } = require('./build_briefing.js');

const REPO_ROOT = path.join(__dirname, '..');
const CARD_DEFAULT = 'D:/工作/4市场/_卡片/行业价格信号与事件演进.md';
const CARD_PATH = process.env.SIGNALS_CARD_PATH || CARD_DEFAULT;
const SNAPSHOT = process.env.REPO_SIGNALS_SNAPSHOT || 'data/signals_snapshot.json';

// ===== 取当日简报数据 =====
function loadBriefing() {
  const argDate = process.argv[2];
  const envDate = process.env.BRIEFING_DATE;
  const date = argDate || envDate || '';
  if (date) {
    const p = path.join(REPO_ROOT, 'data', `${date}.json`);
    if (!fs.existsSync(p)) throw new Error(`指定日期简报不存在: ${p}`);
    const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return { date, data: d, sourcePath: p };
  }
  // 缺省：读 notify.json 的 date
  const np = path.join(REPO_ROOT, 'notify.json');
  if (!fs.existsSync(np)) throw new Error('notify.json 不存在，且未指定日期');
  const n = JSON.parse(fs.readFileSync(np, 'utf-8'));
  const dp = path.join(REPO_ROOT, 'data', `${n.date}.json`);
  if (!fs.existsSync(dp)) throw new Error(`notify.json 指向的简报不存在: ${dp}`);
  return { date: n.date, data: JSON.parse(fs.readFileSync(dp, 'utf-8')), sourcePath: dp };
}

// ===== 把简报内容压成一段给 LLM 抽取的文本 =====
function flatten(data) {
  const parts = [];
  const hp = data.highpoints || data.points || [];
  for (const h of hp) {
    const tag = h.tag ? `【${h.tag}】` : '';
    parts.push(`${tag}${h.text}`);
  }
  const secs = data.sections || [];
  for (const s of secs) {
    if (s.title) parts.push(`## ${s.title}`);
    for (const p of (s.paragraphs || [])) parts.push(p);
  }
  const notes = data.notes || '';
  if (notes) parts.push(`备注：${notes}`);
  return parts.join('\n');
}

// ===== LLM 抽取结构化信号 =====
const EXTRACT_PROMPT = (date, text) => `你是化纤行业情报分析员。请从下面这份「${date} 化纤行业简报」中抽取**可纵向追踪的行业信号**，输出严格 JSON。

只抽取三类信号，逐条给出：
1. **价格**：品种价格变动（原油/石脑油/PTA/MEG/涤纶长丝POY-DTY/切片/涤短/锦纶6/己内酰胺/瓶片等），含数值、单位、涨跌方向。
2. **加工差/利润**：PTA加工费、POY/DTY加工差、产销率、基差等。
3. **事件/政策**：涨价/降价、停产/检修/复产、产能投放、政策、进出口、地缘等非纯价格信号。

每条信号格式（JSON 数组元素）：
{
  "kind": "价格" | "加工差" | "事件",
  "品种": "如 锦纶6 / PTA / 涤纶长丝POY / 原油",
  "方向": "涨" | "跌" | "稳" | "事件",
  "数值": "如 7285元/吨（+60）",
  "信号": "一句话概括（30字内）",
  "来源": "CCF快讯/CCF日报/市场速递/综合"
}

要求：
- 宁缺毋滥：只抽**有明确数值或明确事件**的信号，空泛描述跳过。
- 品种名统一（锦纶6 不要写成 PA6/尼龙6 混用，统一「锦纶6」）。
- 方向列只用「涨/跌/稳/事件」四个字之一，不要加任何 emoji 或符号。
- 输出必须是合法 JSON，形如 {"signals":[...]}，不要任何多余文字。

简报内容：
${text}`;

async function extractSignals(date, data) {
  const text = flatten(data);
  if (!text.trim()) return [];
  if (!process.env.LLM_API_KEY) {
    console.log('未配置 LLM_API_KEY，跳过信号抽取（仅做空跑）');
    return [];
  }
  const raw = await callLLM(EXTRACT_PROMPT(date, text));
  try {
    const j = JSON.parse(raw);
    const arr = Array.isArray(j) ? j : (j.signals || []);
    return arr.filter(s => s && s.信号);
  } catch (e) {
    console.error('信号抽取结果非 JSON，跳过本次回流:', String(raw).slice(0, 200));
    return [];
  }
}

// ===== 写卡（幂等：日期锚点判重） =====
function appendToCard(cardPath, date, signals) {
  const lines = [];
  for (const s of signals) {
    // 方向列用纯文字（涨/跌/稳/事件），避免 emoji 在不同系统/编码下乱码
    const dir = (s.方向 && s.方向.trim()) || '—';
    lines.push(`| ${date} | ${dir} | ${s.品种 || '—'} | ${s.数值 || '—'} | ${s.信号} | ${s.来源 || '综合'} |`);
  }
  return lines.join('\n');
}

function writeSnapshot(date, signals) {
  const sp = path.join(REPO_ROOT, SNAPSHOT);
  let store = {};
  if (fs.existsSync(sp)) { try { store = JSON.parse(fs.readFileSync(sp, 'utf-8')); } catch {} }
  store[date] = signals;
  fs.writeFileSync(sp, JSON.stringify(store, null, 2), 'utf-8');
  return sp;
}

function writeCard(cardPath, date, signals) {
  // 本机写卡：若卡文件在本地存在则追加；不存在则初始化。
  // 幂等：读卡里是否已有当日锚点 `<!-- 信号锚点: <date> -->`。
  let content = fs.existsSync(cardPath) ? fs.readFileSync(cardPath, 'utf-8') : '';
  const anchor = `<!-- 信号锚点: ${date} -->`;
  if (content.includes(anchor)) {
    return { wrote: false, reason: `卡片已含 ${date} 信号，跳过` };
  }
  const block = `\n${anchor}\n| 日期 | 方向 | 品种 | 数值 | 信号 | 来源 |\n|---|---|---|---|---|---|\n${appendToCard(cardPath, date, signals)}\n`;
  // 追加到卡片末尾（纵向时间线，最新在底部）
  fs.writeFileSync(cardPath, content.trimEnd() + '\n' + block, 'utf-8');
  return { wrote: true, reason: `已写入 ${signals.length} 条信号` };
}

// ===== 主流程 =====
(async () => {
  const { date, data } = loadBriefing();
  console.log(`[backfill] 处理简报 ${date}（${data.highpoints?.length || data.points?.length || 0} 要点 / ${(data.sections || []).length} 板块）`);

  const signals = await extractSignals(date, data);
  if (!signals.length) {
    console.log('[backfill] 未抽到信号，本次无回流');
    return;
  }
  console.log(`[backfill] 抽取到 ${signals.length} 条信号`);

  // 1) 仓库内快照（Actions 内永远可写，供后续本地同步/备份）
  const sp = writeSnapshot(date, signals);
  console.log(`[backfill] 信号快照已写: ${sp}`);

  // 2) 本机写卡（本机运行时卡路径可达；Actions 内 D:/ 不可达则静默跳过）
  try {
    const r = writeCard(CARD_PATH, date, signals);
    console.log(`[backfill] ${r.reason}（卡: ${CARD_PATH}）`);
  } catch (e) {
    console.log(`[backfill] 本机写卡跳过（${e.message}）——云端运行仅落快照，本机卡由同步环节更新`);
  }
})().catch(e => { console.error('[backfill] 失败:', e.message); process.exit(1); });
