#!/usr/bin/env node
/**
 * 休刊日闸门（云端 workflow 专用，2026-09-24 上线）
 *
 * 命中 config/off_days.json 里 dates 的当天（北京时间）→ 向 GITHUB_ENV 写入 SKIP_TODAY=1，
 * 后续构建、发布、推送步骤全部跳过；未命中则原样放行。
 *
 * 用途：法定长假（中秋/国庆等）期间 CCF 停更、Cookie 过期无法续期（不在报备网络）、
 *       LLM 配额受限，定时任务照跑只会产出低质量降级版——宁可休刊，不发烂稿。
 *
 * 注意：手动 repush（补推模式）不受此闸门限制，仍可用于假期里补发最后一期完整简报。
 */
const fs = require('fs');
const path = require('path');

// workflow 里已设 TZ=Asia/Shanghai，本地时间方法拿到的就是北京日期
const d = new Date();
const pad = n => String(n).padStart(2, '0');
const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

let dates = [];
try {
  dates = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'off_days.json'), 'utf8')).dates || [];
} catch (e) {
  console.log('休刊日配置缺失或不可读，按无休刊处理：' + e.message);
}

if (dates.includes(today)) {
  console.log(`::notice::今天是休刊日（${today}，见 config/off_days.json）：跳过构建、发布与全部推送`);
  if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, 'SKIP_TODAY=1\n');
} else {
  console.log(`休刊日检查通过：${today} 不在休刊列表（共配置 ${dates.length} 天）`);
}
