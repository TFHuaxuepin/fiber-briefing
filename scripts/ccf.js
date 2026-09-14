/**
 * CCF 华瑞信息网化纤信息采集模块
 * 从 huarui.ccf.com.cn 抓取快讯/晨报/日报/视点评论等栏目内容
 * 用于替代微信公众号采集，作为化纤简报的主要数据源
 */
const https = require('https');
const zlib = require('zlib');
const iconv = require('iconv-lite');
const querystring = require('querystring');

// 栏目配置
// 经实测：list-110000.shtml 是"全部"列表（约28篇），会同时返回快讯/评论/要闻等各栏目文章。
// 为避免重复请求触发 429 限流，只保留一个主列表，用文章 URL 里的 colId 区分栏目。
const COLUMNS = [
  { id: '110000', name: 'CCF快讯', priority: 1 },
];

const BASE = 'https://huarui.ccf.com.cn';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let loggedInCookies = '';

// ===== 工具函数 =====

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function request(options) {
  return new Promise((resolve, reject) => {
    const u = new URL(options.url);
    const hdrs = {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      ...(options.headers || {}),
    };
    const req = https.request({hostname: u.hostname, path: u.pathname + u.search, method: options.method || 'GET', headers: hdrs}, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)}));
    });
    req.on('error', reject);
    req.setTimeout(options.timeout || 25000, () => { req.destroy(); reject(new Error('timeout')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

function mergeCookies(base, arr) {
  const map = {};
  for (const c of String(base || '').split(';')) { const k = c.split('=')[0].trim(); if (k) map[k] = c.trim(); }
  for (const c of (arr || [])) { const p = String(c).split(';')[0].trim(); const k = p.split('=')[0]; if (k) map[k] = p; }
  return Object.values(map).join('; ');
}

function decodeGBK(buf, headers) {
  const enc = String(headers['content-encoding'] || '').toLowerCase();
  try {
    if (enc.includes('gzip')) buf = zlib.gunzipSync(buf);
    else if (enc.includes('deflate')) buf = zlib.inflateSync(buf);
    else if (enc.includes('br')) buf = zlib.brotliDecompressSync(buf);
  } catch (e) {}
  return iconv.decode(buf, 'gbk');
}

// ===== 登录 =====

async function login(username, password) {
  if (!username || !password) throw new Error('需要 CCF_USERNAME 和 CCF_PASSWORD 环境变量');
  console.log('[CCF] 登录...');
  let cookies = '';

  // Step1: 获取 session
  const s1 = await request({url: `${BASE}/`});
  cookies = mergeCookies(cookies, s1.headers['set-cookie']);

  // Step2: POST 登录
  const body = querystring.stringify({
    custlogin: '1',
    action: 'login',
    url: '/',
    lng: '-1',
    lat: '-1',
    s: '',
    username,
    password,
    savecookie: '1',
    'imageField.x': '12',
    'imageField.y': '8',
  });
  const s2 = await request({
    url: `${BASE}/member/member.php`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookies,
      'Origin': BASE,
      'Referer': `${BASE}/`,
    },
    body,
  });
  cookies = mergeCookies(cookies, s2.headers['set-cookie']);

  // 验证登录：检查是否有 uid cookie（非 0 值表示登录成功）
  const uidMatch = cookies.match(/uid=([^;]+)/);
  if (!uidMatch || uidMatch[1] === '0' || uidMatch[1] === '0%3D' || uidMatch[1].length < 10) {
    throw new Error(`CCF 登录失败: 未获取到有效 uid cookie，请检查账号密码。cookie=${cookies.slice(0, 80)}`);
  }
  console.log('[CCF] 登录成功');
  loggedInCookies = cookies;
  return cookies;
}

// ===== 列表页抓取 =====

function parseListHtml(html, colName, basePath) {
  const articles = [];
  // 匹配详情页链接: detail-XXXXXX-YYYYMMDDXXXX.shtml
  const linkPattern = /<a[^>]*href=["']([^"']*detail-(\d{6,8})-(\d{8})(\d{4,6})\.shtml)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkPattern.exec(html)) !== null) {
    const href = m[1];
    const colId = m[2];
    const dateStr = m[3]; // YYYYMMDD
    const title = m[5].replace(/<[^>]+>/g, '').trim();
    if (!title || title.length < 4) continue;
    // 构造完整 URL
    let url = href;
    if (url.startsWith('/')) url = BASE + url;
    else if (!url.startsWith('http')) url = `${basePath}/${url}`;
    // 日期
    const y = dateStr.slice(0, 4);
    const mo = dateStr.slice(4, 6);
    const d = dateStr.slice(6, 8);
    const datetime = `${y}-${mo}-${d} 09:00`;
    articles.push({title, url, datetime, source: colName, colId});
  }
  return articles;
}

async function fetchList(cookies, colId, colName) {
  const url = `${BASE}/newscenter/list-${colId}.shtml`;
  let resp;
  try { resp = await request({url, headers: {Cookie: cookies}}); }
  catch (e) { console.error(`  [CCF] 列表 ${colName} 请求失败: ${e.message}`); return []; }
  if (resp.status !== 200) { console.error(`  [CCF] 列表 ${colName} HTTP ${resp.status}`); return []; }
  const html = decodeGBK(resp.body, resp.headers);
  const articles = parseListHtml(html, colName, `${BASE}/newscenter`);
  // 补充：从链接附近的日期文本获取更精确的时间
  // 格式: "08:17" → 今天的 HH:MM；"09/12" → YYYY/MM/DD
  for (const a of articles) {
    const idx = html.indexOf(a.title);
    if (idx > 0) {
      const ctx = html.slice(Math.max(0, idx - 100), idx);
      const tm = ctx.match(/(\d{1,2}):(\d{2})/);
      if (tm) {
        const h = String(tm[1]).padStart(2, '0');
        const m = tm[2];
        const d = a.datetime.slice(0, 10);
        a.datetime = `${d} ${h}:${m}`;
      }
    }
  }
  return articles;
}

// ===== 正文抓取 =====

async function fetchContent(cookies, url) {
  let resp;
  try { resp = await request({url, headers: {Cookie: cookies}}); }
  catch (e) { console.error(`  [CCF] 正文请求失败: ${e.message}`); return ''; }
  if (resp.status !== 200) return '';
  const html = decodeGBK(resp.body, resp.headers);

  // 提取 #newscontent 里的正文
  const ncMatch = html.match(/<div[^>]*id=["']?newscontent["']?[^>]*>([\s\S]*?)<\/div>/i);
  if (!ncMatch) {
    // fallback: 提取 newsviewtext
    const nvMatch = html.match(/<td[^>]*class=["'][^"']*newsviewtext[^"']*["'][^>]*>([\s\S]*?)<\/td>/i);
    if (!nvMatch) return '';
    return cleanText(nvMatch[1]);
  }
  return cleanText(ncMatch[1]);
}

function cleanText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

// ===== 主入口 =====

async function fetchCCFArticles(username, password) {
  const cookies = await login(username, password);
  const all = [];
  const seen = new Set();

  // 只抓一个主列表（所有栏目合并），避免多页重复请求触发限流
  const col = COLUMNS[0];
  console.log(`  [CCF] 采集 ${col.name}...`);
  await sleep(2000 + Math.random() * 2000);
  const articles = await fetchList(cookies, col.id, col.name);
  console.log(`    -> ${articles.length} 篇`);
  for (const a of articles) {
    const k = a.url;
    if (seen.has(k)) continue;
    seen.add(k);
    all.push(a);
  }

  console.log(`[CCF] 合计 ${all.length} 篇待采集正文`);

  // 只抓当天的文章正文（避免过多请求）
  const today = new Date(Date.now() + 8 * 3600000);
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate()); // 今天 00:00

  const enriched = [];
  for (let i = 0; i < all.length; i++) {
    const a = all[i];
    const dtStr = a.datetime.slice(0, 10);
    const shouldFetch = dtStr >= cutoff.toISOString().slice(0, 10);
    if (shouldFetch) {
      await sleep(1500 + Math.random() * 1000); // 增加间隔防429
      a.content = await fetchContent(cookies, a.url);
      if (a.content) console.log(`  [CCF正文] ${a.source}: ${a.title.slice(0,30)} (${a.content.length}字)`);
    } else {
      a.content = '';
    }
    enriched.push(a);
    if ((i + 1) % 5 === 0 && shouldFetch) console.log(`  [CCF] 正文进度 ${i + 1}/${all.length}`);
  }

  return enriched;
}

module.exports = { fetchCCFArticles, login, fetchCCFArticles };