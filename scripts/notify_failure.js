#!/usr/bin/env node
/**
 * 失败告警：当每日简报生成流程失败时，通过 Server酱推一条微信提醒，
 * 避免「早上没收到简报却没人知道」。
 *
 * 读取环境变量：
 *   SERVERCHAN_KEY        必填，与 notify.js 共用
 *   FAIL_STEP             失败步骤名（由 workflow 注入 github.job / step）
 *   SITE_BASE             选填，用于附上历史页地址
 *   GITHUB_RUN_URL        选填，Actions 运行详情地址
 */
const https = require('https');
const querystring = require('querystring');
const fs = require('fs');
const path = require('path');

const SENDKEY = (process.env.SERVERCHAN_KEY || '').trim();
const STEP = process.env.FAIL_STEP || '未知步骤';
const SITE_BASE = (process.env.SITE_BASE || '').replace(/\/$/, '');
const RUN_URL = process.env.GITHUB_RUN_URL || '';

// 上一步（build_briefing.js）失败时落盘的具体原因
function readFailReason() {
  try { return fs.readFileSync(path.join(__dirname, '..', 'failure_reason.txt'), 'utf-8').trim(); }
  catch { return ''; }
}
// 按原因给出可执行的处置建议，避免只收到「失败了」却不知道要做什么
function advice(reason) {
  const r = String(reason || '');
  if (/正文为空|会话未真正登录|风控拦截|登录失败|uid/.test(r)) {
    return ['**最可能：CCF_COOKIE 已过期**（服务端会话失效）。', '处置：浏览器登录 huarui.ccf.com.cn → 开发者工具 Copy as cURL / 复制完整 Cookie → 更新仓库 Secret `CCF_COOKIE`（必须含 PHPSESSID）→ 重新触发工作流。'];
  }
  if (/LLM 全部尝试失败|内容为空|推理/.test(r)) {
    return ['**大模型网关侧问题**（推理超限/超时/鉴权）。', '处置：确认 `LLM_API_KEY`/`LLM_BASE_URL`/`LLM_MODEL` 有效，必要时重跑一次；代码已内置 max_tokens 自适应倍增。'];
  }
  if (/0 篇有内容|无可用文章/.test(r)) {
    return ['**素材为空**：采集到文章但正文全部拿不到，常见于会话失效或站点改版。', '处置：先按 Cookie 过期处理，持续复现需检查站点结构变化。'];
  }
  return [];
}

function bjNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = typeof body === 'string' ? body : querystring.stringify(body);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + (u.search || ''), method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  if (!SENDKEY) { console.log('未配置 SERVERCHAN_KEY，跳过失败告警'); return; }

  const date = bjNow().slice(0, 10);
  const title = `⚠️ 化纤简报生成失败 ${date}`;
  const reason = readFailReason();
  const lines = [
    `**失败时间**：${bjNow()}（北京时间）`,
    `**失败环节**：${STEP}`,
  ];
  if (reason) lines.push(`**具体原因**：${reason.slice(0, 300)}`);
  const tips = advice(reason);
  lines.push('', ...(tips.length ? tips : [
    '今天的简报没有生成，请检查。常见原因：',
    '- CCF 登录被拦截 / Cookie 过期（会员会话失效）',
    '- 大模型网关超时或鉴权失败',
    '- GitHub Actions 自身异常',
  ]));
  if (RUN_URL) lines.push('', `[查看运行日志](${RUN_URL})`);
  if (SITE_BASE) lines.push(`[历史简报](${SITE_BASE}/)`);

  const r = await post(`https://sctapi.ftqq.com/${SENDKEY}.send`, { title, desp: lines.join('\n') });
  try {
    const j = JSON.parse(r.raw);
    console.log(j.code === 0 ? '失败告警已发送 ✓' : `失败告警发送异常: ${r.raw.slice(0, 200)}`);
  } catch (e) {
    console.log(`失败告警响应非 JSON: ${r.status} ${r.raw.slice(0, 200)}`);
  }
})();
