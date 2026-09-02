#!/usr/bin/env node
/**
 * 微信推送（Server酱）：简报生成后，把要点和链接推送到用户微信
 * 在 GitHub Actions 中运行，读取仓库根目录 notify.json（由 build_briefing.js 生成）
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const SENDKEY = process.env.SERVERCHAN_KEY || process.env.SERVERCHAN_SENDKEY || '';
const SITE_BASE = (process.env.SITE_BASE || '').replace(/\/$/, '');

function post(url, data) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(data).toString();
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + (u.search || ''), method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        let j = null; try { j = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, json: j, raw });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

async function main() {
  if (!SENDKEY) { console.log('未配置 SERVERCHAN_KEY，跳过推送'); return; }
  const p = path.join(__dirname, '..', 'notify.json');
  if (!fs.existsSync(p)) { console.error('notify.json 不存在，跳过推送'); return; }
  const n = JSON.parse(fs.readFileSync(p, 'utf-8'));

  const todayUrl = SITE_BASE ? `${SITE_BASE}/${n.date}.html` : '';
  const indexUrl = SITE_BASE ? `${SITE_BASE}/` : '';

  const title = `化纤行业简报 ${n.date}`;
  let desp = `**化纤行业信息简报 · ${n.date}**\n\n`;
  desp += `统计区间：${n.range}（北京时间）\n\n`;
  if (n.degraded) desp += `> ⚠️ 本期智能整合降级，详见网页版\n\n`;
  if (Array.isArray(n.points) && n.points.length) {
    desp += `**今日要点：**\n\n`;
    for (const h of n.points) desp += `- **【${h.tag}】** ${h.text}\n`;
    desp += `\n`;
  }
  if (Array.isArray(n.sections) && n.sections.length) {
    desp += `**本期板块：** ${n.sections.join(' · ')}\n\n`;
  }
  desp += `信息来源：${n.sources} 篇推文\n\n`;
  if (todayUrl) desp += `👉 [点击查看完整简报](${todayUrl})\n\n`;
  if (indexUrl) desp += `📚 [历史简报目录](${indexUrl})\n`;

  const resp = await post(`https://sctapi.ftqq.com/${SENDKEY}.send`, { title, desp });
  if (resp.status === 200 && resp.json && resp.json.code === 0) {
    console.log('微信推送成功 ✓');
  } else {
    console.error(`微信推送失败: ${resp.status} ${resp.raw.slice(0, 300)}`);
    process.exit(1);
  }
}

main().catch(e => { console.error('推送异常:', e.message); process.exit(1); });
