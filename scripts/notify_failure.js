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

const SENDKEY = (process.env.SERVERCHAN_KEY || '').trim();
const STEP = process.env.FAIL_STEP || '未知步骤';
const SITE_BASE = (process.env.SITE_BASE || '').replace(/\/$/, '');
const RUN_URL = process.env.GITHUB_RUN_URL || '';

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
  const lines = [
    `**失败时间**：${bjNow()}（北京时间）`,
    `**失败环节**：${STEP}`,
    '',
    '今天的简报没有生成，请检查。常见原因：',
    '- CCF 登录被拦截（会员账号/IP 风控）',
    '- 大模型网关超时',
    '- GitHub Actions 自身异常',
  ];
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
