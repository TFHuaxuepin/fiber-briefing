#!/usr/bin/env node
/**
 * 仅补推模式：不重新构建、不调用大模型，直接从已发布的 site/<date>.html 反推 notify.json。
 *
 * 用途：某天的定时运行因故未推送（被取消 / 推送步骤失败 / 大模型额度耗尽），
 *       而当日页面本身是完整的，此时用它把推送补发出去。
 *
 * 用法：node scripts/notify_from_site.js [YYYY-MM-DD]
 *       省略日期时自动取 site 目录中最新的那期。
 *
 * 生成 notify.json 后，由 scripts/notify.js 完成实际推送。
 */
const fs = require('fs');
const path = require('path');

const SITE_DIR = path.join(__dirname, '..', 'site');

function decode(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}
function stripTags(s) { return decode(String(s || '').replace(/<[^>]+>/g, '')).trim(); }

function pickDate(arg) {
  if (arg && /^\d{4}-\d{2}-\d{2}$/.test(arg)) return arg;
  if (!fs.existsSync(SITE_DIR)) throw new Error('site 目录不存在：' + SITE_DIR);
  const dates = fs.readdirSync(SITE_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.html$/.test(f))
    .map(f => f.replace('.html', ''))
    .sort();
  if (!dates.length) throw new Error('site 目录下没有历史简报页面');
  return dates[dates.length - 1];
}

function main() {
  const dateStr = pickDate(process.argv[2]);
  const file = path.join(SITE_DIR, `${dateStr}.html`);
  if (!fs.existsSync(file)) throw new Error(`找不到当日页面：${file}`);

  const html = fs.readFileSync(file, 'utf-8');

  // 统计区间
  let range = '';
  const mRange = /快讯统计区间：([^<（(]*)/.exec(html);
  if (mRange) range = mRange[1].trim();

  // 今日要点：summary-box 内每个 li = flag 标签 + 正文
  const points = [];
  const boxMatch = /<div class="summary-box"><ul>([\s\S]*?)<\/ul>/.exec(html);
  if (boxMatch) {
    const liRe = /<li>([\s\S]*?)<\/li>/g;
    let m;
    while ((m = liRe.exec(boxMatch[1])) !== null) {
      const inner = m[1];
      const fm = /<span class="flag[^"]*">([\s\S]*?)<\/span>/.exec(inner);
      const tag = fm ? stripTags(fm[1]) : '资讯';
      const text = stripTags(fm ? inner.replace(fm[0], '') : inner);
      if (text) points.push({ tag, text });
    }
  }

  // 板块标题：所有 h2 去掉固定栏目
  const FIXED = new Set(['今日要点', '本期信息来源']);
  const sections = [];
  const h2Re = /<h2>([\s\S]*?)<\/h2>/g;
  let h;
  while ((h = h2Re.exec(html)) !== null) {
    const t = stripTags(h[1]);
    if (t && !FIXED.has(t) && !sections.includes(t)) sections.push(t);
  }

  // 信息来源条数：本期信息来源表格的数据行数
  let sources = 0;
  const srcMatch = /<h2>本期信息来源<\/h2>([\s\S]*?)<\/table>/.exec(html);
  if (srcMatch) {
    const trs = srcMatch[1].match(/<tr>/g);
    sources = trs ? Math.max(0, trs.length - 1) : 0; // 减去表头
  }

  // 是否降级版：出现「标题列表」栏目，或说明文字含降级/未配置字样
  const noteMatch = /<p class="note">([\s\S]*?)<\/p>/.exec(html);
  const note = noteMatch ? stripTags(noteMatch[1]) : '';
  const degraded = sections.includes('标题列表')
    || /仅展示原文列表|智能整合失败|未配置大模型|未配置/.test(note);

  const payload = {
    date: dateStr,
    range: range || `${dateStr}（未能解析统计区间）`,
    sources,
    degraded,
    points: points.slice(0, 5),
    sections,
  };

  fs.writeFileSync(path.join(__dirname, '..', 'notify.json'), JSON.stringify(payload, null, 2), 'utf-8');

  console.log(`[补推] 数据源：site/${dateStr}.html`);
  console.log(`[补推] 日期 ${dateStr}｜区间 ${payload.range}｜要点 ${payload.points.length} 条｜板块 ${sections.length} 个｜来源 ${sources} 篇｜降级 ${degraded}`);
  if (!points.length) {
    console.warn('[补推] 警告：未解析到要点，推送内容将只有标题与链接。');
  }
}

try {
  main();
} catch (e) {
  console.error('[补推] 失败：' + e.message);
  process.exit(1);
}
