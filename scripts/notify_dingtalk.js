#!/usr/bin/env node
/**
 * 钉钉推送：简报生成后，把「今日要点 + 链接」推送到钉钉
 *
 * 支持两种通道，按配置自动选择（两条都配了就都推）：
 *
 *  1) 群机器人（自定义机器人 Webhook）—— 推到群里，可 @ 指定人
 *     DINGTALK_WEBHOOK      必填，可逗号分隔多个（同时推多个群）
 *     DINGTALK_SECRET       选填，机器人安全设置选「加签」时填
 *     DINGTALK_AT_MOBILES   选填，要 @ 的手机号，逗号分隔
 *
 *  2) 企业机器人单聊 —— 直接私聊发给指定的人（需钉钉开放平台企业内部应用）
 *     DINGTALK_APP_KEY / DINGTALK_APP_SECRET / DINGTALK_ROBOT_CODE / DINGTALK_USER_IDS
 *
 * 读取仓库根目录 notify.json（由 build_briefing.js 生成）。
 * 本地预览：node scripts/notify_dingtalk.js --dry-run
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const WEBHOOKS = (process.env.DINGTALK_WEBHOOK || '').split(',').map(s => s.trim()).filter(Boolean);
const SECRET = (process.env.DINGTALK_SECRET || '').trim();
const AT_MOBILES = (process.env.DINGTALK_AT_MOBILES || '').split(',').map(s => s.trim()).filter(Boolean);
const APP_KEY = (process.env.DINGTALK_APP_KEY || '').trim();
const APP_SECRET = (process.env.DINGTALK_APP_SECRET || '').trim();
const ROBOT_CODE = (process.env.DINGTALK_ROBOT_CODE || '').trim();
const USER_IDS = (process.env.DINGTALK_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const SITE_BASE = (process.env.SITE_BASE || '').replace(/\/$/, '');
const DRY_RUN = process.argv.includes('--dry-run');

// ===== 通用请求 =====
function postJSON(url, obj, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(obj);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + (u.search || ''),
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      }, headers || {}),
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

// ===== 文案 =====
// 标签着色：涨=红、跌=绿（国内习惯），其余原样
function renderTag(tag) {
  const t = String(tag || '').trim();
  const l = t.toLowerCase();
  if (l === 'up' || t.includes('涨')) return '<font color=#D93025>【涨】</font>';
  if (l === 'down' || t.includes('跌')) return '<font color=#1A7F37>【跌】</font>';
  if (l === 'stable' || t.includes('稳')) return '<font color=#B7791F>【稳】</font>';
  return `【${t || '资讯'}】`;
}

function buildMessage(n) {
  const title = `化纤行业简报 ${n.date}`;
  const todayUrl = SITE_BASE ? `${SITE_BASE}/${n.date}.html` : '';
  const indexUrl = SITE_BASE ? `${SITE_BASE}/` : '';

  let text = `## ${title}\n\n`;
  text += `**统计区间**：${n.range}（北京时间）\n\n`;
  if (n.degraded) text += `> 本期智能整合降级，详见网页版\n\n`;

  if (Array.isArray(n.points) && n.points.length) {
    text += `**今日要点**\n\n`;
    for (const p of n.points) text += `${renderTag(p.tag)}${p.text}\n\n`;
  }
  if (Array.isArray(n.sections) && n.sections.length) {
    text += `**本期板块**：${n.sections.join(' · ')}\n\n`;
  }
  text += `**信息来源**：${n.sources} 篇\n\n`;
  if (todayUrl) text += `[👉 查看完整简报](${todayUrl})\n\n`;
  if (indexUrl) text += `[📚 历史简报目录](${indexUrl})\n`;

  // markdown 消息里 @某人，正文必须出现 @手机号
  if (AT_MOBILES.length) text += `\n${AT_MOBILES.map(m => '@' + m).join(' ')}\n`;

  return { title, text };
}

// 钉钉错误码 → 可操作的排查提示
function hintFor(json) {
  if (!json) return '';
  const code = json.errcode;
  const msg = String(json.errmsg || '');
  if (code === 310000) {
    if (msg.includes('签名')) return '→ 加签密钥（DINGTALK_SECRET）与该 Webhook 不配对。请重新复制【同一个机器人】的加签密钥；或把机器人安全设置改为「自定义关键词」（关键词填「化纤」），然后删掉 DINGTALK_SECRET。';
    if (msg.includes('关键词')) return '→ 消息未包含机器人配置的关键词，请把关键词设为「化纤」或「简报」。';
    return '→ 安全设置校验未通过：检查加签密钥是否正确，或改用自定义关键词。';
  }
  if (code === 300001) return '→ Webhook 地址无效或已失效，请重新复制完整的 access_token。';
  if (code === 130101 || code === 400013) return '→ 发送过于频繁，钉钉限制每机器人每分钟 20 条。';
  if (code === 310001) return '→ 机器人已被停用或移出群，请在群内重新添加。';
  return '';
}

// ===== 通道 1：群机器人 Webhook =====
function withSign(webhook, secret) {
  const ts = Date.now();
  const sign = crypto.createHmac('sha256', secret).update(`${ts}\n${secret}`).digest('base64');
  return webhook + (webhook.includes('?') ? '&' : '?') + `timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
}

async function sendGroup(webhook, payload) {
  // 先按配置发送；若因签名校验失败，自动退回「不带加签」再试一次
  // （覆盖：机器人安全设置其实是「自定义关键词」、或密钥与 Webhook 不配对的情况）
  const attempts = SECRET ? [{ mode: '加签', url: withSign(webhook, SECRET) }, { mode: '无加签', url: webhook }] : [{ mode: '无加签', url: webhook }];

  let last = null;
  for (const a of attempts) {
    const r = await postJSON(a.url, payload);
    if (r.json && r.json.errcode === 0) {
      if (a.mode === '无加签' && SECRET) console.log('  (已自动退回「无加签」模式发送成功 —— 建议删除 DINGTALK_SECRET)');
      return { ok: true };
    }
    last = { status: r.status, raw: r.raw, json: r.json, mode: a.mode };
    // 非签名类错误无需换模式重试
    if (!(r.json && r.json.errcode === 310000)) break;
  }
  const hint = hintFor(last.json);
  return { ok: false, msg: `[${last.mode}] ${last.status} ${last.raw.slice(0, 300)}${hint ? '\n  ' + hint : ''}` };
}

// ===== 通道 2：企业机器人单聊 =====
async function getAccessToken() {
  const r = await postJSON('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    appKey: APP_KEY, appSecret: APP_SECRET,
  });
  const token = r.json && r.json.accessToken;
  if (!token) throw new Error(`获取 accessToken 失败: ${r.status} ${r.raw.slice(0, 200)}`);
  return token;
}

async function sendOto(token, title, text) {
  const r = await postJSON('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
    robotCode: ROBOT_CODE,
    userIds: USER_IDS,
    msgKey: 'sampleMarkdown',
    msgParam: JSON.stringify({ title, text }),
  }, { 'x-acs-dingtalk-access-token': token });
  if (r.status === 200 && !r.json?.code) return { ok: true, key: r.json?.processQueryKey };
  return { ok: false, msg: `${r.status} ${r.raw.slice(0, 200)}` };
}

// ===== 主流程 =====
async function main() {
  const p = path.join(__dirname, '..', 'notify.json');
  if (!fs.existsSync(p)) { console.error('notify.json 不存在，跳过推送'); return; }
  const n = JSON.parse(fs.readFileSync(p, 'utf-8'));
  const { title, text } = buildMessage(n);

  if (DRY_RUN) {
    console.log('===== 预览：钉钉消息内容 =====');
    console.log('标题: ' + title);
    console.log('---');
    console.log(text);
    console.log('==============================');
    return;
  }

  if (!WEBHOOKS.length && !(APP_KEY && APP_SECRET && ROBOT_CODE && USER_IDS.length)) {
    console.log('未配置 DINGTALK_WEBHOOK 或企业机器人凭据，跳过钉钉推送');
    return;
  }

  const errors = [];

  // 通道 1：群机器人
  if (WEBHOOKS.length) {
    const payload = {
      msgtype: 'markdown',
      markdown: { title, text },
      at: { atMobiles: AT_MOBILES, isAtAll: false },
    };
    for (let i = 0; i < WEBHOOKS.length; i++) {
      try {
        const r = await sendGroup(WEBHOOKS[i], payload);
        if (r.ok) console.log(`钉钉群推送成功 ✓ (第 ${i + 1} 个群)`);
        else { console.error(`钉钉群推送失败 (第 ${i + 1} 个群): ${r.msg}`); errors.push(r.msg); }
      } catch (e) {
        console.error(`钉钉群推送异常 (第 ${i + 1} 个群): ${e.message}`);
        errors.push(e.message);
      }
    }
  }

  // 通道 2：企业机器人单聊
  if (APP_KEY && APP_SECRET && ROBOT_CODE && USER_IDS.length) {
    try {
      const token = await getAccessToken();
      const r = await sendOto(token, title, text);
      if (r.ok) console.log(`钉钉单聊推送成功 ✓ (${USER_IDS.length} 人)`);
      else { console.error(`钉钉单聊推送失败: ${r.msg}`); errors.push(r.msg); }
    } catch (e) {
      console.error(`钉钉单聊推送异常: ${e.message}`);
      errors.push(e.message);
    }
  }

  if (errors.length) process.exit(1);
}

if (require.main === module) main().catch(e => { console.error('钉钉推送异常:', e.message); process.exit(1); });
module.exports = { buildMessage, renderTag };
