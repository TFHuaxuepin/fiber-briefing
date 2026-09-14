#!/usr/bin/env node
/**
 * 化纤行业每日信息简报（网页采集版）
 * 流程：华瑞CCF登录 -> 抓取快讯/晨报/日报/视点正文 -> DeepSeek整合为分析师风格简报 -> 渲染HTML -> 发布
 * 在 GitHub Actions 中运行，无需本机开机。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { fetchCCFArticles } = require('./ccf.js');
const CCF_USER = process.env.CCF_USERNAME || '';
const CCF_PASS = process.env.CCF_PASSWORD || '';
const DATA_SOURCE = CCF_USER ? '华瑞CCF化纤信息网' : '无（请配置CCF_USERNAME/CCF_PASSWORD）';
const SITE_DIR = path.join(__dirname, '..', 'site');
const NODE_MODULES = 'C:/Users/24428/.workbuddy/binaries/node/workspace/node_modules';
let cheerio = null;
try { cheerio = require(path.join(NODE_MODULES, 'cheerio')); } catch { try { cheerio = require('cheerio'); } catch {} }

const LLM_API_KEY = process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || '';
const LLM_BASE = process.env.LLM_BASE_URL || 'https://token.chinaunicomglobal.com';
const LLM_MODEL = process.env.LLM_MODEL || 'deepseek-v4-pro';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

// ===== 工具 =====
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function nowBeijing() { return new Date(Date.now() + 8 * 60 * 60 * 1000); }
function beijingStr(d) { const p = n => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`; }
function beijingDateStr(d) { const p = n => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())}`; }
function parseBeijing(datetime) { const m = datetime.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/); if (!m) return null; return new Date(Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5]) - 8*60*60*1000); }
function isFresh(a, cutoff){ const dt = parseBeijing(a.datetime||''); return dt!==null && dt.getTime()>=cutoff; }
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
// 去除大模型可能夹带的 HTML 标签
function stripTags(s){ return String(s||'').replace(/<[^>]*>/g,'').replace(/&nbsp;/g,' ').trim(); }
// 对已转义的文本中的涨跌数字着色（+红色 / -绿色，遵循 A 股习惯）
function colorize(escaped){
  return String(escaped||'')
    .replace(/\+\s?\d[\d,]*(?:\.\d+)?\s?%?/g, m=>`<span class="up">${m}</span>`)
    .replace(/(?<![\d\w])-\s?\d[\d,]*(?:\.\d+)?\s?%?/g, m=>`<span class="down">${m}</span>`);
}
// 标签文案映射
function tagLabel(tag){
  const t=String(tag||'').trim();
  const l=t.toLowerCase();
  if(l==='up'||t==='涨') return '涨';
  if(l==='down'||t==='跌') return '跌';
  if(l==='stable'||t==='稳'||t==='稳定'||t==='持平') return '稳';
  return t||'资讯';
}

function decompress(buffer, encoding){ if(!encoding) return buffer; const e=String(encoding).toLowerCase(); try{ if(e.includes('gzip')) return zlib.gunzipSync(buffer); if(e.includes('deflate')) return zlib.inflateSync(buffer); if(e.includes('br')) return zlib.brotliDecompressSync(buffer); }catch{} return buffer; }
function request(url, headers, timeoutMs=20000){
  return new Promise((resolve,reject)=>{
    const u=new URL(url);
    const lib=u.protocol==='http:'?require('http'):https;
    const req=lib.request({hostname:u.hostname,protocol:u.protocol,path:u.pathname+u.search,headers,method:'GET'},res=>{
      const chunks=[]; res.on('data',c=>chunks.push(c)); res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:decompress(Buffer.concat(chunks),res.headers['content-encoding'])}));
    });
    req.on('error',reject); req.setTimeout(timeoutMs,()=>{req.destroy();reject(new Error('timeout'));}); req.end();
  });
}
function extractRedirect(html){
  const meta=html.match(/<meta[^>]*http-equiv=["']refresh["'][^>]*content=["']\d+;\s*url=([^"']+)["']/i); if(meta) return meta[1];
  const js=html.match(/location\.href\s*=\s*["']([^"']+)["']/i)||html.match(/window\.location\s*=\s*["']([^"']+)["']/i); if(js) return js[1];
  const parts=[]; for(const m of html.matchAll(/url\s*\+=\s*'([^']*)'/g)) parts.push(m[1]); for(const m of html.matchAll(/url\s*\+=\s*"([^"]*)"/g)) parts.push(m[1]);
  if(parts.length){ const j=parts.join(''); if(j.includes('mp.weixin.qq.com')) return j; }
  return null;
}
async function resolveRealUrl(sogouUrl){
  try{
    const resp=await request(sogouUrl,{'User-Agent':UA,'Accept':'text/html,*/*;q=0.8','Accept-Encoding':'identity','Accept-Language':'zh-CN,zh;q=0.9','Cookie':'ABTEST=0|1|v1; IPLOC=CN5101; ariaDefaultTheme=default; ariaFixed=true; ariaReadtype=1; ariaStatus=false'});
    if(resp.status>=300&&resp.status<400&&resp.headers.location) return resp.headers.location;
    if(resp.status===200){ const r=extractRedirect(resp.body.toString('utf-8')); if(r) return r; }
  }catch{}
  return null;
}
async function fetchWechatArticle(url){
  const resp=await request(url,{'User-Agent':UA,'Accept':'text/html,*/*;q=0.8','Accept-Encoding':'identity','Accept-Language':'zh-CN,zh;q=0.9'});
  const html=resp.body.toString('utf-8');
  if(!cheerio) return { text:'', length:0 };
  const $=cheerio.load(html);
  const title=($('#activity-name').text()||$('h1').first().text()||'').trim();
  const el=$('#js_content').length?$('#js_content'):$('.rich_media_content');
  el.find('script,style').remove();
  const text=el.text().replace(/[ \t\u00a0]+/g,' ').replace(/\n\s*\n\s*\n+/g,'\n\n').trim();
  return { title, text, length:text.length };
}

// ===== Bing 转载源搜索（微信正文被反爬拦截时的补充渠道） =====
let bingCookie='';
async function bingEnsureCookie(){
  if(bingCookie) return;
  try{
    // cn.bing.com 直接访问；跟随重定向并累积 cookie
    let resp=await request('https://cn.bing.com/',{'User-Agent':UA,'Accept':'text/html,application/xhtml+xml','Accept-Language':'zh-CN,zh;q=0.9'});
    bingCookie=mergeCookies(bingCookie, resp.headers['set-cookie']);
    if(resp.status>=300 && resp.status<400 && resp.headers.location){
      const r2=await request(resp.headers.location,{'User-Agent':UA,'Accept-Language':'zh-CN,zh;q=0.9','Cookie':bingCookie});
      bingCookie=mergeCookies(bingCookie, r2.headers['set-cookie']);
    }
    console.log(`  [bing] cookie 初始化: status=${resp.status}, ${bingCookie.length} 字节`);
  }catch(e){ console.error(`  [bing] cookie 失败: ${e.message}`); }
}
function mergeCookies(base, setCookieArr){
  const map={};
  for(const c of String(base||'').split(';')){ const k=c.split('=')[0].trim(); if(k) map[k]=c.trim(); }
  for(const c of (setCookieArr||[])){ const p=String(c).split(';')[0].trim(); const k=p.split('=')[0]; if(k) map[k]=p; }
  return Object.values(map).join('; ');
}
async function bingSearch(q){
  await bingEnsureCookie();
  // 参数用 setmkt 而非 mkt，避免再次触发区域重定向
  const url='https://cn.bing.com/search?q='+encodeURIComponent(q)+'&count=10&setmkt=zh-CN&setlang=zh-cn';
  let resp;
  try{
    resp=await request(url,{'User-Agent':UA,'Accept':'text/html,application/xhtml+xml','Accept-Language':'zh-CN,zh;q=0.9','Cookie':bingCookie,'Referer':'https://cn.bing.com/'});
  }catch(e){ console.error(`  [bing] 请求失败: ${e.message}`); return []; }
  // 跟随重定向（最多2次），每次合并 cookie
  for(let i=0;i<2 && resp.status>=300 && resp.status<400 && resp.headers.location;i++){
    try{
      const r2=await request(resp.headers.location,{'User-Agent':UA,'Accept-Language':'zh-CN,zh;q=0.9','Cookie':bingCookie});
      bingCookie=mergeCookies(bingCookie, r2.headers['set-cookie']);
      resp=r2;
    }catch(e){ break; }
  }
  if(resp.status!==200){ console.error(`  [bing] "${q}" 状态: ${resp.status}`); return []; }
  const html=resp.body.toString('utf-8');
  const out=[];
  for(const m of html.matchAll(/<li class="b_algo"[^>]*>[\s\S]*?<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)){
    out.push({url:m[1], title:m[2].replace(/<[^>]+>/g,'').trim()});
  }
  console.log(`  [bing] "${q}" 命中 ${out.length} 条`);
  return out;
}
function titleOverlap(a,b){
  const na=String(a||'').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g,'');
  const nb=String(b||'').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g,'');
  if(!na||!nb) return 0;
  for(let len=Math.min(na.length,20);len>=6;len--){
    for(let i=0;i+len<=na.length;i++){
      if(nb.includes(na.slice(i,i+len))) return len;
    }
  }
  return 0;
}
function extractReadableText(html){
  if(!cheerio) return '';
  const $=cheerio.load(html);
  $('script,style,noscript,nav,header,footer,aside,iframe').remove();
  const text=$('body').text()||'';
  return text.replace(/[ \t\u00a0]+/g,' ').replace(/\n\s*\n\s*\n+/g,'\n\n').trim();
}

// ===== 抓取 =====
async function fetchAll(){
  const all=[], seen=new Set();
  for(const {kw,n} of KEYWORDS){
    let arts=[];
    for(let attempt=1;attempt<=3;attempt++){
      try{ console.log(`搜索: "${kw}"（第${attempt}次）...`); arts=await searchWechatArticles(kw,n,false); console.log(`  -> ${arts.length} 条`); }catch(e){ console.error(`失败: ${e.message}`); }
      if(arts.length>0) break;
      if(attempt<3) await sleep(8000*attempt+Math.random()*4000);
    }
    for(const a of arts){ const k=(a.title||'')+'|'+(a.source||''); if(!k.trim()||seen.has(k)) continue; seen.add(k); all.push(a); }
    await sleep(2000+Math.random()*2000);
  }
  return all;
}

async function enrichArticles(list){
  const out=[];
  for(const a of list){
    let content='';
    let realUrl=a.url;
    let contentFrom='weixin';
    try{
      if(a.url.includes('mp.weixin.qq.com')) realUrl=a.url;
      else realUrl=await resolveRealUrl(a.url);
      if(realUrl && realUrl.includes('mp.weixin.qq.com')){
        await sleep(800);
        const art=await fetchWechatArticle(realUrl);
        content=art.text||'';
      }
    }catch(e){ console.error(`抓取正文失败: ${e.message}`); }
    // 微信正文拿不到时，通过 cn.bing.com 找该文章的转载源（财经网站等）
    if(!content){
      try{
        const results=await bingSearch(a.title.slice(0,38));
        for(const r of results.slice(0,4)){
          if(/mp\.weixin\.qq\.com|weixin\.sogou\.com/.test(r.url)) continue;
          if(titleOverlap(a.title,r.title)<6) continue;
          await sleep(600);
          try{
            const resp=await request(r.url,{'User-Agent':UA,'Accept':'text/html,*/*;q=0.8','Accept-Encoding':'identity','Accept-Language':'zh-CN,zh;q=0.9'});
            if(resp.status>=300 && resp.status<400 && resp.headers.location){
              try{ const r2=await request(resp.headers.location,{'User-Agent':UA,'Accept-Language':'zh-CN,zh;q=0.9'}); if(r2.status===200) resp=r2; }catch{}
            }
            if(resp.status!==200) continue;
            const text=extractReadableText(resp.body.toString('utf-8'));
            console.log(`    转载候选 [${titleOverlap(a.title,r.title)}字符] ${r.url.slice(0,60)} → 正文 ${text.length} 字`);
            if(text.length>500){ content=text.slice(0,3000); contentFrom=new URL(r.url).hostname; break; }
          }catch(e){ console.error(`    转载抓取失败: ${e.message}`); }
        }
      }catch(e){ console.error(`  Bing 兜底失败: ${e.message}`); }
    }
    out.push({ ...a, realUrl:realUrl||a.url, content, contentFrom });
    console.log(`  [${a.source}] 正文 ${content.length} 字${content?`（来源:${contentFrom}）`:''}`);
  }
  return out;
}

// ===== 大模型整合 =====
function llmEndpoints(){
  const base=LLM_BASE.replace(/\/+$/,'');
  // 若 base 已含具体端点，直接用
  if(/\/chat\/completions$/.test(base)) return [base];
  // 若 base 已含 /v1，则只试 /chat/completions
  if(/\/v1$/.test(base)) return [base+'/chat/completions'];
  // 否则先试 /v1/chat/completions（多数网关），再回退 /chat/completions（DeepSeek 原生）
  return [base+'/v1/chat/completions', base+'/chat/completions'];
}
// 模型候选：默认模型优先，其次环境变量指定的模型（去重）
function llmModels(){
  return [...new Set(['deepseek-v4-pro', LLM_MODEL].filter(Boolean))];
}
function postJSON(url, body){
  return new Promise((resolve,reject)=>{
    const u=new URL(url);
    const lib=u.protocol==='http:'?require('http'):https;
    const req=lib.request({hostname:u.hostname,protocol:u.protocol,path:u.pathname+(u.search||''),method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${LLM_API_KEY}`,'Content-Length':Buffer.byteLength(body)}},res=>{
      const chunks=[]; res.on('data',c=>chunks.push(c)); res.on('end',()=>resolve({status:res.statusCode,raw:Buffer.concat(chunks).toString('utf-8')}));
    });
    req.on('error',reject); req.setTimeout(120000,()=>{req.destroy();reject(new Error('LLM timeout'));}); req.write(body); req.end();
  });
}
async function callLLM(prompt){
  const urls=llmEndpoints(), models=llmModels();
  // 展开为扁平的尝试列表，顺序清晰：模型 → 端点 → json模式
  const attempts=[];
  for(const model of models){
    for(const url of urls){
      attempts.push({model,url,jsonMode:true});
      attempts.push({model,url,jsonMode:false});
    }
  }
  const deadUrls=new Set();
  const deadModels=new Set();
  let lastErr='';
  for(const a of attempts){
    if(deadUrls.has(a.url)||deadModels.has(a.model)) continue;
    const body=JSON.stringify(Object.assign(
      { model:a.model, messages:[{role:'user',content:prompt}], temperature:0.4, max_tokens:8000 },
      a.jsonMode?{response_format:{type:'json_object'}}:{}
    ));
    let r;
    try{ r=await postJSON(a.url, body); }
    catch(e){ lastErr=`${e.message} @ ${a.url}`; console.log(`  (尝试失败: ${a.model}/${a.jsonMode?'json':'text'} → ${e.message})`); continue; }
    console.log(`LLM 尝试: model=${a.model}, url=${a.url.replace(/^https?:\/\//,'')}, json=${a.jsonMode} => HTTP ${r.status}`);
    if(r.status===200){
      let data; try{ data=JSON.parse(r.raw); }catch(e){ lastErr='响应非JSON'; continue; }
      const content=data.choices?.[0]?.message?.content||'';
      if(content) return content;
      lastErr='200 但内容为空'; continue;
    }
    lastErr=`HTTP ${r.status}: ${r.raw.slice(0,200)}`;
    if(r.status===404){ deadUrls.add(a.url); continue; }      // 端点不存在 → 后续跳过该端点
    if(/model is disabled|model not found|无此模型|模型.*(禁用|不存在)/i.test(r.raw)){ deadModels.add(a.model); continue; }
    if(r.status===401||r.status===403){ deadModels.add(a.model); continue; } // 鉴权/模型问题 → 换模型
    // 400 且带 json_mode：去掉 json_mode 后再试（下一个 attempt 已是 json=false）
  }
  throw new Error('LLM 全部尝试失败: '+lastErr);
}

function buildLLMPrompt(articles, dateStr, rangeStr){
  // 控制单篇正文长度，避免提示词过长导致输出被截断
  const mats=articles.map((a,i)=>`\n【素材${i+1}】来源:${a.source} | 标题:${a.title} | 时间:${a.datetime}\n正文:\n${(a.content||a.summary||'（正文为空）').slice(0,1500)}\n链接:${a.url}`).join('\n');
  return `你是资深化纤行业分析师。请根据以下今日（${dateStr}）采集到的化纤行业资讯素材（来自华瑞信息CCF快讯/晨报/日报/视点评论），梳理整合为一份精炼的行业信息简报。

${mats}

【行业边界】
你关注的是"化纤行业"的核心资讯：涤纶/锦纶/氨纶/粘胶/腈纶等品种的价格涨跌、PTA/乙二醇/聚酯等原料行情、产能开工率、库存变化、进出口数据、产业政策、企业动态、技术创新。以下内容不属于化纤行业简报范畴，请直接忽略：膳食纤维/食物营养、玻璃纤维生活科普与致癌辟谣、微生物纤维素学术论文、木棉纤维实验室研究等与化纤市场无关的内容。

【整合要求】
1. 你是一名分析师，不是摘要机器人。要跨文章交叉整合——把不同素材里提到同一品种/同一主题的信息合并成一条判断，而不是逐条转述每篇文章；
2. 每条要点要回答"这对市场意味着什么？"，要有分析师的判断力和洞察力；
3. 严禁编造素材中没有的具体数据；某条素材正文为空时只能依据标题/摘要做有限推断，不能编造细节；
4. **绝对禁止在 text/paragraphs/title/table 任何文本里输出 HTML 标签、CSS 或颜色样式**。涨跌方向只用 tag 字段表达：涨用 "up"、跌用 "down"、持平用 "stable"、其他主题用中文如"原料/产业/政策/展望"。正文中直接写"上涨0.63%"这样的纯文本即可，由前端负责着色；
5. 只输出 JSON，不要前后多余文字：
{
  "highpoints": [{"tag":"up/down/stable/原料/产业/政策/展望", "text":"一句话要点，带数据支撑和判断，纯文本"}],
  "sections": [{"title":"板块名", "paragraphs":["分析段落…纯文本"], "table":{"headers":["指标","数值","涨跌","解读"],"rows":[["…","…","…","…"]]} }],
  "notes":"数据核实与免责说明"
}
板块按当天实际内容组织（价格动态、原料行情、产能变化、企业动向、政策解读、趋势研判等）。全体要点不少于3条、不超过8条。板块按信息密度灵活组织，某个方面没内容就跳过，不硬凑。`;
}

// 补齐未闭合的字符串/括号
function closeAll(s){
  const stack=[]; let inStr=false, esc=false;
  for(const ch of s){
    if(inStr){ if(esc){esc=false;} else if(ch==='\\'){esc=true;} else if(ch==='"'){inStr=false;} continue; }
    if(ch==='"') inStr=true;
    else if(ch==='{') stack.push('}');
    else if(ch==='[') stack.push(']');
    else if(ch==='}'||ch===']') stack.pop();
  }
  let out=s;
  if(inStr) out+='"';
  while(stack.length) out+=stack.pop();
  return out;
}
// 健壮 JSON 解析：容忍大模型输出被 max_tokens 截断
function safeParseJSON(text){
  let t=String(text||'').trim();
  const fence=t.match(/```(?:json)?\s*([\s\S]*?)```/i); if(fence) t=fence[1].trim();
  const s=t.indexOf('{'), e=t.lastIndexOf('}');
  if(s>=0&&e>s) t=t.slice(s,e+1);
  try{ return JSON.parse(t); }catch(err){}
  // 修复：从末尾往前找完整的 } / ] 作为截断点，补齐括号后重试
  const cands=[];
  for(let i=t.length-1;i>=0 && cands.length<120;i--){ if(t[i]==='}'||t[i]===']') cands.push(i); }
  for(const p of cands){
    try{ return JSON.parse(closeAll(t.slice(0,p+1))); }catch(err){}
  }
  throw new Error('JSON 解析失败（含修复尝试）');
}

// ===== HTML 渲染 =====
const CSS=`
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:"PingFang SC","Microsoft YaHei","Hiragino Sans GB",sans-serif;background:#f5f7fa;color:#2c3e50;line-height:1.75;padding:32px 16px}
.container{max-width:880px;margin:0 auto}
.header{background:linear-gradient(135deg,#1e5799 0%,#2d72b8 60%,#3d8fd1 100%);color:#fff;border-radius:14px;padding:34px 40px;margin-bottom:24px}
.header .badge{display:inline-block;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.35);border-radius:999px;font-size:13px;padding:3px 14px;margin-bottom:12px;letter-spacing:2px}
.header h1{font-size:27px;font-weight:700}
.header .meta{margin-top:8px;font-size:13.5px;opacity:.92}
.card{background:#fff;border-radius:12px;padding:26px 30px;margin-bottom:22px;box-shadow:0 2px 8px rgba(30,87,153,.06)}
.card h2{font-size:18px;color:#1e5799;margin-bottom:14px;padding-bottom:10px;border-bottom:2px solid #eaf2fb}
.card h3{font-size:15px;color:#1e3a5c;margin:16px 0 8px}
.card p{font-size:14.5px;color:#4a5b6c;margin-bottom:10px}
.summary-box{background:linear-gradient(135deg,#f0f7ff,#eef4fb);border-left:5px solid #2d72b8;border-radius:10px;padding:18px 22px;margin-bottom:14px}
.summary-box ul{padding-left:18px}.summary-box li{font-size:14.5px;color:#2c3e50;margin-bottom:8px}
table{width:100%;border-collapse:collapse;margin:12px 0 16px;font-size:13.5px}
th{background:#f0f6fc;color:#1e5799;font-weight:600;text-align:left;padding:9px 12px;border:1px solid #e3ecf4}
td{padding:8px 12px;border:1px solid #eef2f6;color:#4a5b6c}
tr:nth-child(even) td{background:#fafcfe}
.flag{display:inline-block;font-size:12px;border-radius:4px;padding:1px 8px;margin-right:6px}
.flag.hot{background:#fdeeee;color:#c0392b}.flag.mid{background:#fff7e0;color:#8a6d1f}
.flag.up{background:#fdeeee;color:#c0392b}.flag.down{background:#e8f6ee;color:#27ae60}
.flag.stable{background:#eef2f6;color:#5b6b7a}
.up{color:#c0392b;font-weight:600}.down{color:#27ae60;font-weight:600}
.src{font-size:12.5px;color:#8b99a7;margin-top:8px}.src a{color:#2d72b8;text-decoration:none}.src a:hover{text-decoration:underline}
.note{font-size:12.5px;color:#93a3b1;margin-top:8px}
.footer{text-align:center;font-size:12.5px;color:#9aa8b5;padding:16px 0 6px}
.index-item{display:flex;align-items:center;padding:14px 16px;border:1px solid #eef2f6;border-radius:10px;margin-bottom:10px}
.index-item a{color:#1e5799;text-decoration:none;font-size:16px;font-weight:600}.index-item a:hover{text-decoration:underline}
.index-item .date{font-size:13px;color:#8b99a7;margin-left:auto;flex-shrink:0}
`;

function renderSection(sec){
  let h=`<div class="card"><h2>${esc(sec.title)}</h2>`;
  for(const p of (sec.paragraphs||[])){
    h+=`<p>${colorize(esc(stripTags(p)))}</p>`;
  }
  if(sec.table){
    h+=`<table><tr>`+sec.table.headers.map(x=>`<th>${esc(stripTags(x))}</th>`).join('')+`</tr>`;
    for(const row of sec.table.rows){ h+=`<tr>`+row.map(x=>`<td>${colorize(esc(stripTags(x)))}</td>`).join('')+`</tr>`; }
    h+=`</table>`;
  }
  h+=`</div>`; return h;
}
// 按 tag 生成彩色标签
function tagClass(tag){
  const t=String(tag||'').toLowerCase();
  if(t.includes('up')||t.includes('涨')) return 'up';
  if(t.includes('down')||t.includes('跌')) return 'down';
  if(t.includes('stable')||t.includes('稳')||t.includes('平')||t.includes('持')) return 'stable';
  return 'mid';
}
function renderDaily(dateStr,rangeStr,data,sources){
  const hp=(data.highpoints||[]).map(h=>`<li><span class="flag ${tagClass(h.tag)}">${esc(tagLabel(h.tag))}</span>${colorize(esc(stripTags(h.text)))}</li>`).join('');
  const secs=(data.sections||[]).map(renderSection).join('');
  const srcRows=sources.map(s=>`<tr><td>${esc(s.source)}</td><td><a href="${esc(s.url)}" target="_blank">${esc(s.title)}</a></td><td>${esc((s.datetime||'').slice(0,16))}</td></tr>`).join('');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>化纤行业信息简报 · ${dateStr}</title><style>${CSS}</style></head><body><div class="container">
<div class="header"><div class="badge">每日信息简报 · 内容整合版</div><h1>化纤行业信息简报</h1><div class="meta">${dateStr} · 统计区间：${rangeStr}（过去24小时，北京时间）</div></div>
<div class="card"><h2>今日要点</h2><div class="summary-box"><ul>${hp}</ul></div></div>
${secs}
<div class="card"><h2>本期信息来源</h2><table><tr><th>栏目</th><th>标题</th><th>发布时间</th></tr>${srcRows}</table><p class="note">${esc(stripTags(data.notes||''))}</p></div>
<div class="footer">化纤行业信息简报 · 由 GitHub Actions + 大模型每日自动整合 · ${dateStr}<br>数据来源：华瑞信息CCF化纤信息网（快讯/晨报/日报/视点评论），仅收录过去24小时发布的资讯</div>
</div></body></html>`;
}
function renderIndex(briefings){
  const items=briefings.map(b=>`<div class="index-item"><a href="${b.file}">化纤行业信息简报 · ${b.date}</a><span class="date">${b.date}</span></div>`).join('');
  const latest=briefings.length?`<div class="summary-box">最新一期：<a href="${briefings[0].file}">${briefings[0].date} 简报 >></a></div>`:'<div class="index-item">暂无简报</div>';
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>化纤行业信息简报 · 目录</title><style>${CSS}</style></head><body><div class="container">
<div class="header"><div class="badge">每日信息简报</div><h1>化纤行业信息简报</h1><div class="meta">数据来源：${DATA_SOURCE} · 每日 9:00（北京时间）由 GitHub Actions + DeepSeek 自动整合</div></div>
${latest}<div>${items}</div><div class="footer">由 GitHub Actions 自动生成并发布</div></div></body></html>`;
}

// ===== 主流程 =====
async function main(){
  const now=nowBeijing(), cutoff=new Date(now.getTime()-24*60*60*1000);
  const dateStr=beijingDateStr(now), rangeStr=`${beijingStr(cutoff).slice(0,16)} — ${beijingStr(now).slice(0,16)}`;
  console.log(`生成日期: ${dateStr}，区间: ${rangeStr}`);
  console.log(`配置：数据源=${DATA_SOURCE}；LLM模型候选=${llmModels().join('/')}；LLM端点=${LLM_BASE}；密钥=${LLM_API_KEY?'已配置('+LLM_API_KEY.length+'位)':'未配置'}`);

  // CCF 网页采集（登录→抓列表→抓正文）
  let enriched=[];
  if(CCF_USER && CCF_PASS){
    console.log('使用 CCF 网页源采集...');
    enriched=await fetchCCFArticles(CCF_USER, CCF_PASS);
  }else{
    console.log('未配置 CCF_USERNAME/CCF_PASSWORD，无数据源');
  }
  console.log(`采集完成，共 ${enriched.length} 篇`);

  // 只选今天的新文章；若今天暂无可解析文章，退回使用列表中最新的若干篇
  let selected=enriched.filter(a=>isFresh(a,cutoff.getTime()));
  let usingFallback=false;
  if(selected.length===0 && enriched.length>0){
    selected=enriched.slice(0,10);
    usingFallback=true;
    console.log('今日无新增文章，退回使用列表最新的 '+selected.length+' 篇');
  }
  console.log(`当日文章 ${selected.length} 篇`);

  try{ fs.writeFileSync(path.join(__dirname,'..','debug_last.json'), JSON.stringify(enriched,null,2),'utf-8'); }catch{}

  let data;
  if(LLM_API_KEY && selected.length>0){
    console.log('调用大模型整合...');
    try{
      const resp=await callLLM(buildLLMPrompt(selected,dateStr,rangeStr));
      data=safeParseJSON(resp);
      // 兜底：若解析结果缺要点或板块（例如输出被截断），用标题列表补齐
      if(!Array.isArray(data.highpoints)||data.highpoints.length===0){
        data.highpoints=selected.slice(0,5).map(a=>({tag:'资讯',text:`${a.source}：${a.title}`}));
      }
      if(!Array.isArray(data.sections)||data.sections.length===0){
        data.sections=[{title:'当日资讯列表',paragraphs:selected.map(a=>`${a.source}：${a.title}（${a.datetime.slice(11,16)}）`)}];
      }
      console.log('整合完成，要点 '+(data.highpoints||[]).length+' 条，板块 '+(data.sections||[]).length+' 个');
    }catch(e){
      console.error('LLM 失败，降级为标题列表: '+e.message);
      data={ highpoints:[{tag:'提示',text:'本期智能整合失败，已降级为标题列表。'}], sections:[{title:'标题列表',paragraphs:selected.map(a=>`${a.source}：${a.title}（${a.datetime}）`)}], notes:'智能整合失败，仅展示原文列表。原因：'+e.message };
    }
  }else{
    console.log(LLM_API_KEY?('无可用文章（采集到 '+enriched.length+' 篇）'):'未配置 LLM_API_KEY');
    data={ highpoints:selected.slice(0,4).map(a=>({tag:'资讯',text:`${a.source}：${a.title}`})), sections:[{title:'标题列表',paragraphs:selected.map(a=>`${a.source}：${a.title}（${a.datetime}）`)}], notes: LLM_API_KEY?'本期未采集到文章，仅展示标题列表。':'未配置大模型 API，仅展示原文列表；配置 LLM_API_KEY 后将自动整合为内容简报。' };
  }

  fs.mkdirSync(SITE_DIR,{recursive:true});
  const sources=selected.map(a=>({source:a.source,title:a.title,datetime:a.datetime,url:a.url}));
  fs.writeFileSync(path.join(SITE_DIR,`${dateStr}.html`), renderDaily(dateStr,rangeStr,data,sources),'utf-8');
  const briefings=fs.readdirSync(SITE_DIR).filter(f=>/^\d{4}-\d{2}-\d{2}\.html$/.test(f)).map(f=>({file:f,date:f.replace('.html','')})).sort((a,b)=>b.date.localeCompare(a.date));
  fs.writeFileSync(path.join(SITE_DIR,'index.html'), renderIndex(briefings),'utf-8');
  console.log(`完成，共 ${briefings.length} 期简报`);

  // 输出推送摘要
  try{
    fs.writeFileSync(path.join(__dirname,'..','notify.json'), JSON.stringify({
      date: dateStr, range: rangeStr, sources: sources.length,
      degraded: !LLM_API_KEY || selected.length===0 || String(data.notes||'').includes('智能整合失败') || String(data.notes||'').includes('未配置'),
      points: (data.highpoints||[]).map(h=>({tag:h.tag,text:h.text})).slice(0,5),
      sections: (data.sections||[]).map(s=>s.title),
    },null,2),'utf-8');
  }catch{}
}

if(require.main===module){ main().catch(e=>{ console.error('失败:',e); process.exit(1); }); }
module.exports={ callLLM, buildLLMPrompt, llmEndpoints, llmModels };
