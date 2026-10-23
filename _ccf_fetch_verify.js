/**
 * 临时取数脚本（2026-10-23）：为《纤化业务2027年经营计划》核实数据
 * 在 GitHub Actions 云端运行，用 CCF_COOKIE（办公室网络刷新的会话）访问 CCF，
 * 取 2026 年 1—9 月关键序列 + 9 月月报，结果直接写回仓库 _ccf_verify/ 目录。
 *
 * 只读取，不修改任何业务数据。
 */
const fs = require('fs');
const https = require('https');
const zlib = require('zlib');
const iconv = require('iconv-lite');

const OUT_DIR = '_ccf_verify';
const START = '2026/01/01';
const END = '2026/09/30';
const BASE = 'https://huarui.ccf.com.cn';

// 只取本次核实用到的序列
const PRODUCTS = [
  ['效益', 'xjl-7', '涤纶POY加工差'],
  ['效益', 'xjl-8', '涤纶FDY加工差'],
  ['效益', 'xjl-6', '涤纶DTY加工差'],
  ['价格', 'zs-10', 'POY 150D/48F'],
  ['价格', 'zs-12', 'FDY 150D/96F'],
  ['价格', 'zs-9', 'DTY 150D/48F低弹'],
  ['价格', 'zs-3', 'PTA内盘'],
  ['负荷', 'fh-220000', '聚酯负荷'],
  ['负荷', 'fh-230000', '直纺长丝负荷'],
  ['负荷', 'fh-240000', '直纺短纤负荷'],
  ['负荷', 'fh-430000', '锦纶民用纤维负荷'],
  ['负荷', 'fh-510000', '氨纶负荷'],
  ['下游', 'xy-150000', '江浙加弹开机率'],
  ['下游', 'xy-110000', '江浙织机开机率'],
  ['库存', 'kc-292000', '涤纶POY库存'],
  ['库存', 'kc-290000', '涤纶FDY库存'],
  ['库存', 'kc-291000', '涤纶DTY库存'],
  ['原油', 'zs-43', 'Brent原油期货'],
  ['原油', 'zs-1', 'WTI原油期货'],
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function req(url, headers, method, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const h = Object.assign({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    }, headers || {});
    if (body) {
      h['Content-Type'] = 'application/x-www-form-urlencoded';
      h['Content-Length'] = Buffer.byteLength(body);
    }
    const r = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: method || 'GET', headers: h }, res => {
      const c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) }));
    });
    r.on('error', reject);
    r.setTimeout(40000, () => { r.destroy(); reject(new Error('timeout')); });
    if (body) r.write(body);
    r.end();
  });
}

function dec(buf, h) {
  const e = String(h['content-encoding'] || '').toLowerCase();
  try {
    if (e.includes('gzip')) buf = zlib.gunzipSync(buf);
    else if (e.includes('deflate')) buf = zlib.inflateSync(buf);
    else if (e.includes('br')) buf = zlib.brotliDecompressSync(buf);
  } catch (err) {}
  return iconv.decode(buf, 'gbk');
}

function parseSeries(html) {
  const i = html.indexOf('series :');
  if (i < 0) return [];
  const s = html.slice(i);
  const start = s.indexOf('[');
  let depth = 0, end = -1;
  for (let k = start; k < s.length; k++) {
    if (s[k] === '[') depth++;
    else if (s[k] === ']') { depth--; if (depth === 0) { end = k; break; } }
  }
  if (end < 0) return [];
  try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { return []; }
}

// 登录：优先用 CCF_COOKIE，其次账号密码
async function getCookie() {
  const manual = (process.env.CCF_COOKIE || '').trim();
  if (manual) return { cookie: manual, mode: 'COOKIE' };
  const ccf = require('./scripts/ccf.js');
  const c = await ccf.login(process.env.CCF_USERNAME, process.env.CCF_PASSWORD);
  return { cookie: c, mode: 'PASSWORD' };
}

function stat(points) {
  const vs = points.map(p => p[1]).filter(v => Number.isFinite(v));
  if (!vs.length) return null;
  const sum = vs.reduce((a, b) => a + b, 0);
  return {
    n: vs.length,
    min: Math.min.apply(null, vs),
    max: Math.max.apply(null, vs),
    avg: +(sum / vs.length).toFixed(2),
    first: vs[0],
    last: vs[vs.length - 1],
  };
}

// 按月切片统计
function byMonth(points) {
  const m = {};
  for (const [d, v] of points) {
    const key = String(d).slice(0, 7);
    (m[key] = m[key] || []).push(v);
  }
  const out = {};
  for (const k of Object.keys(m).sort()) out[k] = stat(m[k].map(v => ['', v]));
  return out;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const log = [];
  const say = s => { log.push(s); console.log(s); };

  const { cookie, mode } = await getCookie();
  say('LOGIN_MODE=' + mode + ' cookie_len=' + String(cookie).length);
  if (!mode || String(cookie).length < 20) throw new Error('未取得有效 cookie');

  // 先验证 cookie 是否真的能读到正文
  const probe = await req(BASE + '/newscenter/detail-170000-2026100500004.shtml', { Cookie: cookie });
  const probeTxt = dec(probe.body, probe.headers);
  say('PROBE status=' + probe.status + ' len=' + probeTxt.length + ' 含月报=' + /月报/.test(probeTxt) + ' 含登录框=' + /会员登录|请先登录/.test(probeTxt));

  const out = { fetched: new Date().toISOString(), start: START, end: END, mode, series: [] };
  const lines = [];
  let ok = 0, fail = 0;

  for (const [group, id, name] of PRODUCTS) {
    const body = [
      'prodNames=' + encodeURIComponent(id),
      'startdate=' + encodeURIComponent(START),
      'enddate=' + encodeURIComponent(END),
      'axes=1', 'types=line', 'type=1', 'skin=default', 'page=index.php', 'days=', 'chartName=',
    ].join('&');
    try {
      const r = await req(BASE + '/datacenter/index.php', {
        Cookie: cookie,
        Referer: BASE + '/datacenter/index.php',
        Origin: BASE,
      }, 'POST', body);
      const html = dec(r.body, r.headers);
      const arr = parseSeries(html);
      const mine = arr.filter(o => o && o.id === id);
      const target = mine.length ? mine[0] : (arr.length === 1 ? arr[0] : null);
      if (!target || !Array.isArray(target.data) || !target.data.length) {
        fail++;
        lines.push('[空] ' + group + ' | ' + name + ' (' + id + ')');
      } else {
        const pts = target.data.map(p => [String(p[0]).slice(0, 10), Number(p[1])]);
        out.series.push({ group, id, name, ccfName: target.name, points: pts });
        ok++;
        const s = stat(pts);
        const bm = byMonth(pts);
        lines.push('[' + s.n + '点] ' + name + ' (' + id + ') 均' + s.avg +
          ' 区间' + s.min + '~' + s.max + ' 首' + s.first + ' 末' + s.last +
          ' | 9月均' + (bm['2026-09'] ? bm['2026-09'].avg : 'NA') +
          ' 9月低' + (bm['2026-09'] ? bm['2026-09'].min : 'NA') +
          ' 9月高' + (bm['2026-09'] ? bm['2026-09'].max : 'NA'));
      }
    } catch (e) {
      fail++;
      lines.push('[失败] ' + name + ' (' + id + '): ' + e.message);
    }
    await sleep(1200 + Math.random() * 800);
  }

  out.summary = lines;
  fs.writeFileSync(OUT_DIR + '/ccf_series.json', JSON.stringify(out), 'utf-8');
  fs.writeFileSync(OUT_DIR + '/ccf_summary.txt', 'OK=' + ok + ' FAIL=' + fail + '\n' + lines.join('\n') + '\n', 'utf-8');
  say('SERIES_DONE ok=' + ok + ' fail=' + fail);

  // 抓 9 月涤纶长丝月报 PDF（含产能/产量）
  const PDFS = [
    ['polyester_09', BASE + '/newscenter/detail-170000-2026100800439.shtml'],
    ['nylon_09', BASE + '/newscenter/detail-170000-2026100500004.shtml'],
  ];
  for (const [name, url] of PDFS) {
    try {
      const r = await req(url, { Cookie: cookie, Accept: '*/*' });
      let buf = r.body;
      const head = buf.slice(0, 5).toString('latin1');
      if (head.startsWith('%PDF')) {
        fs.writeFileSync(OUT_DIR + '/' + name + '.pdf', buf);
        say('PDF_OK ' + name + ' bytes=' + buf.length);
      } else {
        // 可能是 HTML 页面里嵌了 PDF 链接，抽出链接再取
        const html = dec(buf, r.headers);
        const m = html.match(/(https?:\/\/[^"'\s]+\.pdf|\/upload[^"'\s]+\.pdf)/i);
        say('PDF_HTML ' + name + ' html_len=' + html.length + ' 发现链接=' + (m ? m[1] : '无'));
        if (m) {
          const u2 = m[1].startsWith('http') ? m[1] : BASE + m[1];
          const r2 = await req(u2, { Cookie: cookie, Accept: '*/*' });
          const h2 = r2.body.slice(0, 5).toString('latin1');
          if (h2.startsWith('%PDF')) {
            fs.writeFileSync(OUT_DIR + '/' + name + '.pdf', r2.body);
            say('PDF_OK2 ' + name + ' bytes=' + r2.body.length);
          } else {
            fs.writeFileSync(OUT_DIR + '/' + name + '.html', html, 'utf-8');
            say('PDF_FAIL ' + name);
          }
        } else {
          fs.writeFileSync(OUT_DIR + '/' + name + '.html', html, 'utf-8');
        }
      }
    } catch (e) {
      say('PDF_ERR ' + name + ': ' + e.message);
    }
    await sleep(1500);
  }

  fs.writeFileSync(OUT_DIR + '/run.log', log.join('\n') + '\n', 'utf-8');
})().catch(e => {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_DIR + '/run.log', 'TOP_ERR: ' + e.message + '\n' + e.stack + '\n', 'utf-8');
  } catch (e2) {}
  console.error('TOP_ERR', e.message);
  process.exit(1);
});
