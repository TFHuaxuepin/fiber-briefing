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
// 每个栏目都是独立列表页（list-<id>.shtml），需要单独请求。
// windowHours：该栏目的时间回溯窗口。快讯为日频用 24h；日报/市场速递内容更结构化，但
//   周末不更新、且列表页不给出精确时分（默认 09:00），故回溯 72h 以覆盖周五→周一。
// maxArticles：该栏目最多抓多少篇正文，用于控制请求量与 429 风险。
const COLUMNS = [
  { id: '110000', name: 'CCF快讯',   windowHours: 24, maxArticles: 40 },
  { id: '140000', name: 'CCF日报',   windowHours: 72, maxArticles: 24 },
  { id: '340000', name: '市场速递', windowHours: 72, maxArticles: 5 },
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

// 带重试的请求：遇 429/5xx/超时自动退避重试
async function requestWithRetry(options, retries = 3) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await request(options);
      if (resp.status === 429 || resp.status >= 500) {
        lastErr = new Error(`HTTP ${resp.status}`);
        if (i < retries) {
          const wait = 5000 * (i + 1) + Math.random() * 3000;
          console.log(`    [重试] HTTP ${resp.status}，等待 ${Math.round(wait / 1000)}s 后重试 (${i + 1}/${retries})`);
          await sleep(wait);
          continue;
        }
      }
      return resp;
    } catch (e) {
      lastErr = e;
      if (i < retries) {
        const wait = 4000 * (i + 1);
        console.log(`    [重试] ${e.message}，等待 ${Math.round(wait / 1000)}s 后重试 (${i + 1}/${retries})`);
        await sleep(wait);
        continue;
      }
    }
  }
  throw lastErr || new Error('request failed');
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
  // 逃生通道：CCF_COOKIE 直接提供已登录的 Cookie 串（形如 "PHPSESSID=...; uid=...; values=...; identity=..."），
  // 用于账号密码登录被目标站风控拦截时临时顶替。注意 PHPSESSID 服务端会话会过期，属临时方案。
  const manual = (process.env.CCF_COOKIE || '').trim();
  if (manual) {
    console.log('[CCF] 使用人工提供的 CCF_COOKIE（跳过账号密码登录）');
    loggedInCookies = manual;
    return manual;
  }
  if (!username || !password) throw new Error('需要 CCF_USERNAME 和 CCF_PASSWORD 环境变量');
  console.log('[CCF] 登录...');

  // 登录偶发失败（服务端抖动 / 风控），重试 2 轮
  const MAX_ATTEMPTS = 3;
  let lastDiag = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let cookies = '';
    try {
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
      if (uidMatch && uidMatch[1] !== '0' && uidMatch[1] !== '0%3D' && uidMatch[1].length >= 10) {
        console.log(attempt > 1 ? `[CCF] 登录成功（第 ${attempt} 次尝试）` : '[CCF] 登录成功');
        loggedInCookies = cookies;
        return cookies;
      }

      // 说明：uid cookie 是登录成功的**必要**判据。曾观察到「响应页面看似已登录、但没有 uid」
      // 的情况，实测这种会话抓到的正文其实是「会员可见」的拦截页 —— 所以这里必须严格。
      // 拦截页由 fetchContent 的 gate 检测兜底（双保险），避免产出只有标题的空简报。

      // 失败：记录诊断信息，便于在 CI 日志里定位原因
      let diag = '';
      try {
        const raw = decodeGBK(s2.body, s2.headers);
        const text = raw
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        // 优先抽取与失败有关的片段
        const kw = text.match(/.{0,60}(密码|验证码|错误|失败|不正确|锁定|冻结|异地|频繁|限制|验证).{0,80}/);
        diag = `可见文本=${text.slice(0, 400)}`
          + (kw ? ` || 关键提示=${kw[0]}` : '')
          + ` || body长度=${raw.length}`;
      } catch (e) { diag = `(解析响应失败 ${e.message})`; }
      lastDiag = `第 ${attempt} 次：POST HTTP ${s2.status} | location=${s2.headers.location || '(无)'} | POST set-cookie=${JSON.stringify(s2.headers['set-cookie'] || []).slice(0, 160)} | 首页 HTTP ${s1.status} set-cookie=${JSON.stringify(s1.headers['set-cookie'] || []).slice(0, 160)} | ${diag}`;
      console.error(`[CCF] 登录未拿到 uid cookie（${lastDiag}）`);
    } catch (e) {
      lastDiag = `第 ${attempt} 次：请求异常 ${e.message}`;
      console.error(`[CCF] 登录请求异常（${lastDiag}）`);
    }
    if (attempt < MAX_ATTEMPTS) {
      const wait = 4000 * attempt;
      console.log(`[CCF] ${Math.round(wait / 1000)}s 后重试登录 (${attempt + 1}/${MAX_ATTEMPTS})`);
      await sleep(wait);
    }
  }
  throw new Error(`CCF 登录失败（已重试 ${MAX_ATTEMPTS} 轮）：${lastDiag}`);
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
  try { resp = await requestWithRetry({url, headers: {Cookie: cookies}}); }
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

// 从 startIdx 处提取配对的 <div>...</div>（正确处理嵌套）
function extractBalancedDiv(html, startIdx) {
  const openRe = /<div\b/gi;
  const closeRe = /<\/div>/gi;
  openRe.lastIndex = startIdx;
  const firstOpen = openRe.exec(html);
  if (!firstOpen) return '';
  let depth = 1;
  let pos = firstOpen.index + firstOpen[0].length;
  while (depth > 0 && pos < html.length) {
    closeRe.lastIndex = pos;
    const nextClose = closeRe.exec(html);
    if (!nextClose) break;
    // 统计 pos 到 nextClose 之间的 <div
    const segment = html.slice(pos, nextClose.index);
    const opens = (segment.match(/<div\b/gi) || []).length;
    depth += opens;
    depth -= 1;
    pos = nextClose.index + nextClose[0].length;
  }
  return html.slice(firstOpen.index + firstOpen[0].length, pos - 6);
}

// ===== 正文抓取 =====

async function fetchContent(cookies, url) {
  let resp;
  try { resp = await requestWithRetry({url, headers: {Cookie: cookies}}); }
  catch (e) { console.error(`  [CCF] 正文请求失败: ${e.message}`); return ''; }
  if (resp.status !== 200) return '';
  const html = decodeGBK(resp.body, resp.headers);

  // 优先定位 #newscontent，用配对 div 提取（防止嵌套 div 截断）
  const ncIdx = html.search(/<div[^>]*id=["']?newscontent["']?/i);
  if (ncIdx >= 0) {
    const inner = extractBalancedDiv(html, ncIdx);
    const text = cleanText(inner);
    if (text.length > 0) return isGateText(text) ? '' : text;
  }
  // fallback: 非贪婪匹配
  const ncMatch = html.match(/<div[^>]*id=["']?newscontent["']?[^>]*>([\s\S]*?)<\/div>/i);
  if (ncMatch) { const t = cleanText(ncMatch[1]); return isGateText(t) ? '' : t; }
  // 再 fallback: newsviewtext 容器
  const nvMatch = html.match(/<td[^>]*class=["'][^"']*newsviewtext[^"']*["'][^>]*>([\s\S]*?)<\/td>/i);
  if (nvMatch) { const t = cleanText(nvMatch[1]); return isGateText(t) ? '' : t; }
  return '';
}

// 「会员可见 / 请登录」拦截页识别（非登录态下正文区返回的就是这类文案）。
// 命中即视为「无正文」，避免把拦截页当正文送去整合，产出只有标题的空简报。
function isGateText(text) {
  if (!text) return true;
  if (/请登录或注册会员|只对正式会员和试用会员开放|会员登录|登录名\s*密\s*码/.test(text)) return true;
  // 极短且只含「CCF会员」之类提示
  if (text.length < 40 && /CCF\s*会员|会员可见|请登录/.test(text)) return true;
  return false;
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

// 北京时间（用 UTC getter 读即得北京时间墙上钟）
function beijingNow() { return new Date(Date.now() + 8 * 3600 * 1000); }
function bjDateStr(d) { const p = n => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`; }

async function fetchCCFArticles(username, password) {
  const cookies = await login(username, password);
  const now = beijingNow();
  const all = [];
  const seen = new Set();

  // ① 逐栏目抓列表，按各栏目的时间窗过滤后限量取用
  for (const col of COLUMNS) {
    console.log(`  [CCF] 采集 ${col.name}（list-${col.id}，回溯 ${col.windowHours}h）...`);
    await sleep(2000 + Math.random() * 2000);
    let arts = [];
    try { arts = await fetchList(cookies, col.id, col.name); }
    catch (e) { console.error(`    [CCF] ${col.name} 列表失败: ${e.message}`); }

    const from = bjDateStr(new Date(now.getTime() - col.windowHours * 3600 * 1000));
    const to = bjDateStr(now);
    const inWindow = arts.filter(a => { const d = (a.datetime || '').slice(0, 10); return d >= from && d <= to; });
    let picked = inWindow.slice(0, col.maxArticles);
    console.log(`    -> 列表 ${arts.length} 篇，窗口内 ${inWindow.length} 篇，采用 ${picked.length} 篇`);
    // 窗口内为 0 是异常信号：多半是列表页被 CDN 缓存成旧快照（常见于会话失效时），
    // 打印列表里的日期分布，便于一眼判断是「站点真没更新」还是「拿到旧页面」。
    if (arts.length > 0 && inWindow.length === 0) {
      const dates = [...new Set(arts.map(a => (a.datetime || '?').slice(0, 10)))].sort();
      console.log(`    [警告] ${col.name} 列表无窗口内文章（窗口 ${from} ~ ${to}），列表内日期：${dates.join(', ')}`);
    }

    for (const a of picked) {
      if (seen.has(a.url)) continue;
      seen.add(a.url);
      a.windowHours = col.windowHours;   // 供下游做时间窗判断
      all.push(a);
    }
  }

  console.log(`[CCF] 合计 ${all.length} 篇待采集正文`);

  // ② 逐篇抓正文（限流保护：每篇间隔 1.5~2.5s）
  const enriched = [];
  let contentOk = 0;
  for (let i = 0; i < all.length; i++) {
    const a = all[i];
    await sleep(1500 + Math.random() * 1000);
    a.content = await fetchContent(cookies, a.url);
    if (a.content) { contentOk++; console.log(`  [CCF正文] ${a.source}: ${a.title.slice(0, 30)} (${a.content.length}字)`); }
    enriched.push(a);
    // 快速失败：首篇正文就为空 → 会话未真正登录（或被风控），立即报错，省下几十次无用请求
    if (i === 0 && !a.content) {
      throw new Error(`CCF 首篇正文为空（${a.url}）——会话未真正登录，或被目标站风控拦截`);
    }
    if ((i + 1) % 5 === 0) console.log(`  [CCF] 正文进度 ${i + 1}/${all.length}（成功 ${contentOk}）`);
  }

  // 护栏：有文章却一篇正文都拿不到，说明会话其实未登录（或被风控），
  // 直接报错退出，避免上游拿着空数据生成一份空简报。
  if (all.length > 0 && contentOk === 0) {
    throw new Error(`CCF 正文全部抓取失败（共 ${all.length} 篇，0 篇有内容）——会话很可能未真正登录，或被目标站风控拦截`);
  }
  console.log(`[CCF] 正文抓取完成：${contentOk}/${all.length} 篇有内容`);

  return enriched;
}

module.exports = { fetchCCFArticles, login, fetchCCFArticles, COLUMNS, fetchList, fetchContent };