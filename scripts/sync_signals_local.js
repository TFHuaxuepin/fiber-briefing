#!/usr/bin/env node
/**
 * 本地同步：把云端 fiber-briefing 仓库里累积的信号快照（data/signals_snapshot.json）
 * 补写进本机知识库纵向卡 `D:/工作/4市场/_卡片/行业价格信号与事件演进.md`。
 *
 * 与 backfill_signals.js 的分工：
 *   - backfill_signals.js 在「云端 Actions」跑：抽取当日信号 → 落仓库快照 + commit。
 *   - 本脚本在「本机」跑：git pull 拉最新快照 → 把快照里尚未写入卡片的日期补写进去。
 *
 * 幂等：按 `<!-- 信号锚点: <date> -->` 判重，已存在的日期跳过，绝不重复写。
 * 顺序：快照里按日期升序补写，保证卡片时间线从旧到新。
 *
 * 用法（本机）：
 *   node scripts/sync_signals_local.js            # 先 git pull 再补写
 *   node scripts/sync_signals_local.js --no-pull  # 跳过 git pull（离线/已手动 pull）
 *   node scripts/sync_signals_local.js --dry-run  # 只预览，不写卡
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const CARD_PATH = process.env.SIGNALS_CARD_PATH || 'D:/工作/4市场/_卡片/行业价格信号与事件演进.md';
const SNAPSHOT = process.env.REPO_SIGNALS_SNAPSHOT || 'data/signals_snapshot.json';

const args = process.argv.slice(2);
const NO_PULL = args.includes('--no-pull');
const DRY_RUN = args.includes('--dry-run');

// 已存在于卡片中的日期锚点集合
function existingAnchors(cardContent) {
  const re = /<!-- 信号锚点: (\d{4}-\d{2}-\d{2}) -->/g;
  const set = new Set();
  let m;
  while ((m = re.exec(cardContent))) set.add(m[1]);
  return set;
}

// 读快照：{ "<date>": [ {signal...} ] }
function loadSnapshot() {
  const p = path.join(REPO_ROOT, SNAPSHOT);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch (e) { console.error(`快照解析失败: ${e.message}`); return null; }
}

// 按方向纯文字渲染一行
function renderRow(date, s) {
  const dir = (s.方向 && s.方向.trim()) || '—';
  return `| ${date} | ${dir} | ${s.品种 || '—'} | ${s.数值 || '—'} | ${s.信号} | ${s.来源 || '综合'} |`;
}

// 把快照里某日期的信号渲染成带锚点的块
function renderBlock(date, signals) {
  const header = `\n<!-- 信号锚点: ${date} -->\n| 日期 | 方向 | 品种 | 数值 | 信号 | 来源 |\n|---|---|---|---|---|---|`;
  const rows = signals.map(s => renderRow(date, s)).join('\n');
  return `${header}\n${rows}\n`;
}

function main() {
  // 0) git pull（可选）
  if (!NO_PULL) {
    try {
      console.log('[sync] git pull 拉取最新快照...');
      execSync('git pull --ff-only', { cwd: REPO_ROOT, stdio: 'inherit' });
    } catch (e) {
      console.error('[sync] git pull 失败（可能无网络或需先提交本地改动），继续用本地已有快照...');
    }
  }

  // 1) 读快照
  const snap = loadSnapshot();
  if (!snap) {
    console.log('[sync] 无快照文件（云端尚未运行过回流，或尚未 commit）。请先在云端跑一次 backfill 后再同步。');
    return;
  }
  const dates = Object.keys(snap).sort(); // 升序，保证时间线从旧到新
  console.log(`[sync] 快照共 ${dates.length} 个日期: ${dates.join(', ') || '(空)'}`);

  // 2) 读卡片 + 已有锚点
  let card = fs.existsSync(CARD_PATH) ? fs.readFileSync(CARD_PATH, 'utf-8') : '';
  const done = existingAnchors(card);

  // 3) 找出待补写日期
  const todo = dates.filter(d => !done.has(d));
  if (!todo.length) {
    console.log('[sync] 卡片已是最新，无需补写。');
    return;
  }

  // 4) 补写（追加到卡片末尾，日期升序）
  const blocks = todo.map(d => renderBlock(d, snap[d] || []));
  const toAppend = blocks.join('');

  if (DRY_RUN) {
    console.log(`[sync][dry-run] 将补写 ${todo.length} 个日期: ${todo.join(', ')}`);
    console.log('----- 预览 -----');
    console.log(toAppend);
    console.log('----------------');
    return;
  }

  fs.writeFileSync(CARD_PATH, card.trimEnd() + '\n' + toAppend, 'utf-8');
  console.log(`[sync] 已补写 ${todo.length} 个日期到卡片: ${todo.join(', ')}`);
  console.log(`[sync] 卡片: ${CARD_PATH}`);
}

main();
