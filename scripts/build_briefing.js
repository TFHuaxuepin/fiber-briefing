#!/usr/bin/env node
/**
 * 化纤行业公众号每日信息简报（云端版）
 * 流程：多关键词搜索 -> 抓取文章正文 -> 调用 DeepSeek 整合为分析师风格简报 -> 渲染 HTML -> 发布
 * 在 GitHub Actions 中运行，无需本机开机。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { searchWechatArticles } = require('./search_wechat.js');

// ===== 配置 =====
// 账号别名匹配：华瑞信息的实际公众号名为"华瑞CCF化纤信息网"，需用别名覆盖
const ACCOUNTS = ['化纤头条', '华瑞CCF', '华瑞信息', 'CCFEI', '化纤邦', '中国化学纤维工业协会'];
// 关键词矩阵：搜狗按相关性排序且无账号级检索，只能靠关键词广撒网提升召回
const KEYWORDS = [
  { kw: '化纤', n: 50 },
  { kw: '化学纤维', n: 30 },
  { kw: '纤维', n: 30 },
  { kw: '涤纶', n: 30 },
  { kw: '长丝', n: 20 },
  { kw: 'PTA', n: 20 },
  { kw: '乙二醇', n: 20 },
  { kw: '聚酯', n: 20 },
  { kw: '锦纶', n: 15 },
  { kw: '氨纶', n: 15 },
  { kw: '粘胶', n: 15 },
  { kw: '短纤', n: 15 },
  { kw: '瓶片', n: 15 },
  { kw: '化纤头条', n: 30 },
  { kw: '化纤邦', n: 30 },
  { kw: '华瑞', n: 30 },
  { kw: '中国化学纤维工业协会', n: 20 },
];
const EXT_KEYWORDS = ['化纤', '纤维', '涤纶', 'PTA', '锦纶', '氨纶', '粘胶', '腈纶', '长丝', '聚酯'];
const SITE_DIR = path.join(__dirname, '..', 'site');
const NODE_MODULES = 'C:/Users/24428/.workbuddy/binaries/node/workspace/node_modules';
let cheerio = null;
try { cheerio = require(path.join(NODE_MODULES, 'cheerio')); } catch { try { cheerio = require('cheerio'); } catch {} }

const LLM_API_KEY = process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || '';
const LLM_BASE = process.env.LLM_BASE_URL || 'https://api.deepseek.com';
const LLM_MODEL = process.env.LLM_MODEL || 'deepseek-chat';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

// ===== 工具 =====
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function nowBeijing() { return new Date(Date.now() + 8 * 60 * 60 * 1000); }
function beijingStr(d) { const p = n => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`; }
function beijingDateStr(d) { const p = n => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())}`; }
function parseBeijing(datetime) { const m = datetime.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/); if (!m) return null; return new Date(Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5]) - 8*60*60*1000); }
function isAccountMatch(s){ return s && ACCOUNTS.some(a => s.includes(a)); }
function isFresh(a, cutoff){ const dt = parseBeijing(a.datetime||''); return dt!==null && dt.getTime()>=cutoff; }
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

function decompress(buffer, encoding){ if(!encoding) return buffer; const e=String(encoding).toLowerCase(); try{ if(e.includes('gzip')) return zlib.gunzipSync(buffer); if(e.includes('deflate')) return zlib.inflateSync(buffer); if(e.includes('br')) return zlib.brotliDecompressSync(buffer); }catch{} return buffer; }
function request(url, headers, timeoutMs=20000){
  return new Promise((resolve,reject)=>{
    const u=new URL(url);
    const req=https.request({hostname:u.hostname,path:u.pathname+u.search,headers,method:'GET'},res=>{
      const chunks=[]; res.on('data',c=>chunks.push(c)); res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
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
    try{
      if(a.url.includes('mp.weixin.qq.com')) realUrl=a.url;
      else realUrl=await resolveRealUrl(a.url);
      if(realUrl && realUrl.includes('mp.weixin.qq.com')){
        await sleep(800);
        const art=await fetchWechatArticle(realUrl);
        content=art.text||'';
      }
    }catch(e){ console.error(`抓取正文失败: ${e.message}`); }
    out.push({ ...a, realUrl:realUrl||a.url, content });
    console.log(`  [${a.source}] 正文 ${content.length} 字`);
  }
  return out;
}

// ===== DeepSeek 整合 =====
async function callLLM(prompt){
  const body=JSON.stringify({ model:LLM_MODEL, messages:[{role:'user',content:prompt}], temperature:0.4, max_tokens:5000, response_format:{type:'json_object'} });
  const result=await new Promise((resolve,reject)=>{
    const u=new URL(LLM_BASE.replace(/\/$/,'')+'/chat/completions');
    const req=https.request({hostname:u.hostname,path:u.pathname+(u.search||''),method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${LLM_API_KEY}`,'Content-Length':Buffer.byteLength(body)}},res=>{
      const chunks=[]; res.on('data',c=>chunks.push(c)); res.on('end',()=>{ const raw=Buffer.concat(chunks).toString('utf-8'); resolve({status:res.statusCode,raw}); });
    });
    req.on('error',reject); req.setTimeout(90000,()=>{req.destroy();reject(new Error('LLM timeout'));}); req.write(body); req.end();
  });
  console.log(`LLM 状态: ${result.status}`);
  if(result.status!==200) throw new Error('LLM 调用失败: '+result.raw.slice(0,200));
  const data=JSON.parse(result.raw);
  return data.choices?.[0]?.message?.content||'';
}

function buildLLMPrompt(articles, dateStr, rangeStr){
  const mats=articles.map((a,i)=>`\n【素材${i+1}】来源:${a.source} | 标题:${a.title} | 时间:${a.datetime}\n正文:\n${(a.content||a.summary||'').slice(0,2800)}\n链接:${a.url}`).join('\n');
  return `你是资深化纤行业分析师。请根据以下今日（${dateStr}）采集到的化纤行业微信公众号推文素材，梳理整合为一份精炼的行业信息简报。

${mats}

要求：
1. 不要简单罗列推文，要跨文章交叉整合，提炼数据和判断；
2. 严禁编造素材中没有的数据；某条素材正文为空时只能依据标题/摘要，并在简报中标注"原文暂无法获取"；
3. 涨用红色、跌用绿色（在 tag 中用 "up"/"down" 标记数字）；
4. 严格输出如下 JSON（只输出 JSON，不要前后多余文字）：
{
  "highpoints": [{"tag":"核心/价格/产业/展望", "text":"带数据和判断的一句话要点"}],
  "sections": [{"title":"板块名", "paragraphs":["段落文本…"], "table":{"headers":["指标","数值","同比","解读"],"rows":[["…","…","…","…"]]} }],
  "notes":"数据核实与免责说明"
}
板块按当天实际内容组织（如行业运行数据、价格动态、企业动向、产业活动、趋势研判等），不硬凑。`;
}

function safeParseJSON(text){
  let t=text.trim();
  const fence=t.match(/```(?:json)?\s*([\s\S]*?)```/i); if(fence) t=fence[1].trim();
  const s=t.indexOf('{'), e=t.lastIndexOf('}'); if(s>=0&&e>s) t=t.slice(s,e+1);
  return JSON.parse(t);
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
    // 简易着色：含"涨/增/升/+"的数字不强行改色，仅按 up/down 标记
    h+=`<p>${esc(p)}</p>`;
  }
  if(sec.table){
    h+=`<table><tr>`+sec.table.headers.map(x=>`<th>${esc(x)}</th>`).join('')+`</tr>`;
    for(const row of sec.table.rows){ h+=`<tr>`+row.map(x=>`<td>${esc(x)}</td>`).join('')+`</tr>`; }
    h+=`</table>`;
  }
  h+=`</div>`; return h;
}
function renderDaily(dateStr,rangeStr,data,sources){
  const hp=(data.highpoints||[]).map(h=>`<li><span class="flag ${h.tag==='价格'?'hot':'mid'}">${esc(h.tag)}</span>${esc(h.text)}</li>`).join('');
  const secs=(data.sections||[]).map(renderSection).join('');
  const srcRows=sources.map(s=>`<tr><td>${esc(s.source)}</td><td><a href="${esc(s.url)}" target="_blank">${esc(s.title)}</a></td><td>${esc((s.datetime||'').slice(0,16))}</td></tr>`).join('');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>化纤行业信息简报 · ${dateStr}</title><style>${CSS}</style></head><body><div class="container">
<div class="header"><div class="badge">每日信息简报 · 内容整合版</div><h1>化纤行业信息简报</h1><div class="meta">${dateStr} · 统计区间：${rangeStr}（过去24小时，北京时间）</div></div>
<div class="card"><h2>今日要点</h2><div class="summary-box"><ul>${hp}</ul></div></div>
${secs}
<div class="card"><h2>本期信息来源</h2><table><tr><th>公众号</th><th>标题</th><th>发布时间</th></tr>${srcRows}</table><p class="note">${esc(data.notes||'')}</p></div>
<div class="footer">化纤行业信息简报 · 由 GitHub Actions + DeepSeek 每日自动整合 · ${dateStr}<br>采集方式：搜狗微信搜索关键词矩阵（覆盖指定公众号及行业相关来源），受搜索引擎索引覆盖所限，个别推文可能未被收录</div>
</div></body></html>`;
}
function renderIndex(briefings){
  const items=briefings.map(b=>`<div class="index-item"><a href="${b.file}">化纤行业信息简报 · ${b.date}</a><span class="date">${b.date}</span></div>`).join('');
  const latest=briefings.length?`<div class="summary-box">最新一期：<a href="${briefings[0].file}">${briefings[0].date} 简报 >></a></div>`:'<div class="index-item">暂无简报</div>';
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>化纤行业信息简报 · 目录</title><style>${CSS}</style></head><body><div class="container">
<div class="header"><div class="badge">每日信息简报</div><h1>化纤行业信息简报</h1><div class="meta">追踪公众号：${ACCOUNTS.join('、')} · 每日 9:00（北京时间）由 GitHub Actions + DeepSeek 自动整合</div></div>
${latest}<div>${items}</div><div class="footer">由 GitHub Actions 自动生成并发布</div></div></body></html>`;
}

// ===== 主流程 =====
async function main(){
  const now=nowBeijing(), cutoff=new Date(now.getTime()-24*60*60*1000);
  const dateStr=beijingDateStr(now), rangeStr=`${beijingStr(cutoff).slice(0,16)} — ${beijingStr(now).slice(0,16)}`;
  console.log(`生成日期: ${dateStr}，区间: ${rangeStr}`);

  const all=await fetchAll();
  console.log(`合计 ${all.length} 条`);
  const matched=[], extCand=[];
  for(const a of all){
    if(!isFresh(a,cutoff.getTime())) continue;
    if(isAccountMatch(a.source)) matched.push(a);
    else if(EXT_KEYWORDS.some(k=>(a.title||'').includes(k)||(a.summary||'').includes(k))) extCand.push(a);
  }
  const ext=extCand.sort((x,y)=>String(y.datetime).localeCompare(String(x.datetime))).slice(0,5);
  const selected=[...matched, ...ext];
  console.log(`选定 ${selected.length} 篇（指定 ${matched.length} + 延伸 ${ext.length}）`);

  // 抓正文
  const enriched=await enrichArticles(selected);
  try{ fs.writeFileSync(path.join(__dirname,'..','debug_last.json'), JSON.stringify(enriched,null,2),'utf-8'); }catch{}

  let data;
  if(LLM_API_KEY && selected.length>0){
    console.log('调用 DeepSeek 整合...');
    try{
      const resp=await callLLM(buildLLMPrompt(enriched,dateStr,rangeStr));
      data=safeParseJSON(resp);
      console.log('整合完成，要点 '+(data.highpoints||[]).length+' 条，板块 '+(data.sections||[]).length+' 个');
    }catch(e){
      console.error('LLM 失败，降级为标题列表: '+e.message);
      data={ highpoints:[{tag:'提示',text:'本期智能整合失败，已降级为推文列表。'}], sections:[{title:'推文列表',paragraphs:enriched.map(a=>`${a.source}：${a.title}（${a.datetime}）`)}], notes:'智能整合失败，仅展示原文列表。' };
    }
  }else{
    console.log('未配置 LLM_API_KEY，生成简单列表版');
    data={ highpoints:enriched.slice(0,4).map(a=>({tag:'资讯',text:`${a.source}：${a.title}`})), sections:[{title:'推文列表',paragraphs:enriched.map(a=>`${a.source}：${a.title}（${a.datetime}）`)}], notes:'未配置大模型 API，仅展示原文列表；配置 LLM_API_KEY 后将自动整合为内容简报。' };
  }

  fs.mkdirSync(SITE_DIR,{recursive:true});
  const sources=enriched.map(a=>({source:a.source,title:a.title,datetime:a.datetime,url:a.url}));
  fs.writeFileSync(path.join(SITE_DIR,`${dateStr}.html`), renderDaily(dateStr,rangeStr,data,sources),'utf-8');
  const briefings=fs.readdirSync(SITE_DIR).filter(f=>/^\d{4}-\d{2}-\d{2}\.html$/.test(f)).map(f=>({file:f,date:f.replace('.html','')})).sort((a,b)=>b.date.localeCompare(a.date));
  fs.writeFileSync(path.join(SITE_DIR,'index.html'), renderIndex(briefings),'utf-8');
  console.log(`完成，共 ${briefings.length} 期简报`);

  // 输出推送摘要（供 notify.js 使用）
  try{
    fs.writeFileSync(path.join(__dirname,'..','notify.json'), JSON.stringify({
      date: dateStr,
      range: rangeStr,
      sources: sources.length,
      degraded: !LLM_API_KEY || selected.length===0 || String(data.notes||'').includes('智能整合失败') || String(data.notes||'').includes('未配置'),
      points: (data.highpoints||[]).map(h=>({tag:h.tag,text:h.text})).slice(0,5),
      sections: (data.sections||[]).map(s=>s.title),
    },null,2),'utf-8');
  }catch{}
}

main().catch(e=>{ console.error('失败:',e); process.exit(1); });
