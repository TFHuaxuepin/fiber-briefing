# 化纤行业每日信息简报

每日北京时间 08:40 由**本机** WorkBuddy 流程登录华瑞信息 CCF 化纤信息网采集当日快讯正文，由**本机大模型**整合为分析师风格简报（落地为 `data/<日期>.json`），随后外送 GitHub；云端 Actions 只负责**渲染页面 + 发布 GitHub Pages + 推微信/钉钉**，**不产简报内容**。

> ⚠️ **架构要点（2026-10-15 定论）**：**简报由本机生成，云端不产内容**。
> 云端 LLM（联通云 `deepseek-v4-pro`）已失效（`Model is disabled`），旧「云端采集+云端整合」方案**已废弃**；`data/<日期>.json` 是**唯一产路**，由本机当天产出。

## 工作原理

**本机段（每日 08:40，WorkBuddy 自动化）**
1. 登录 `huarui.ccf.com.cn`（仅办公室报备网可登），续期 Cookie
2. 抓取「CCF 快讯 / 日报 / 市场速递」，逐篇取正文（GBK 解码，内置 429/5xx 退避重试）
3. 本机大模型交叉整合 → 写 `data/<日期>.json`（highpoints/sections/notes）
4. 经 GitHub Contents API 把 `data/<日期>.json` 外送到仓库

**云端段（GitHub Actions）**
5. Actions 触发后，检测到当日 `data/<日期>.json` 存在 ⇒ **直接渲染**（日志 `[LOCAL] 采用本地生成内容`），不再调用任何 LLM
6. 生成当日 HTML + 历史目录页，发布到 GitHub Pages
7. 推微信（Server酱）+ 推钉钉（按配置）

## 必须配置的仓库 Secrets（Settings → Secrets and variables → Actions）

| Secret 名 | 值 | 说明 |
|---|---|---|
| `CCF_USERNAME` | CCF 会员账号 | **必填**，华瑞信息网登录账号 |
| `CCF_PASSWORD` | CCF 会员密码 | **必填** |
| `CCF_COOKIE` | CCF 会话 Cookie | **必填**（云端自采拿 sources 用；由本机续期任务写回，寿命 <24h） |
| `SERVERCHAN_KEY` | Server酱 SendKey | 选填，配置后推送微信通知 |
| `DINGTALK_WEBHOOK` | 钉钉群机器人 Webhook | 选填，配置后推送钉钉群 |
| `DINGTALK_SECRET` | 钉钉机器人加签密钥 | 选填，安全设置选「加签」时必填 |
| `DINGTALK_AT_MOBILES` | 要 @ 的手机号，逗号分隔 | 选填 |
| `DINGTALK_APP_KEY` / `DINGTALK_APP_SECRET` / `DINGTALK_ROBOT_CODE` / `DINGTALK_USER_IDS` | 企业内部应用机器人凭据 | 选填，用于**私聊推给指定的人** |

> 注：`LLM_API_KEY` 属**旧云端方案遗留，已不再使用**（云端 LLM 已失效）；云端遇到降级内容会被发布闸门拦下，不再发布降级版。

## 钉钉推送

简报生成后，`scripts/notify_dingtalk.js` 读取 `notify.json`，把「今日要点 + 简报链接」以 markdown 卡片推送到钉钉。两种通道按配置自动启用：

**通道 1 · 群机器人**（推荐，5 分钟搞定）
钉钉群 → 群设置 → 智能群助手 → 添加机器人 → 自定义 → 安全设置选「加签」→ 复制 Webhook 与加签密钥，分别存入 `DINGTALK_WEBHOOK` 和 `DINGTALK_SECRET`。想 @ 谁就把手机号填进 `DINGTALK_AT_MOBILES`。

**通道 2 · 私聊指定人**（需企业内部应用）
钉钉开放平台 → 创建企业内部应用 → 添加「机器人」→ 发布后拿到 AppKey / AppSecret / RobotCode，配上接收人的 userId（`DINGTALK_USER_IDS`，通讯录里查）。

本地预览推送文案（不实际发送）：

```bash
node scripts/notify_dingtalk.js --dry-run
```

## 启用 GitHub Pages

仓库 Settings → Pages → Source 选择 `gh-pages` 分支、`/(root)` 目录。首次运行 workflow 后该分支会自动创建。

## 手动触发

Actions 页面 → Daily Fiber Briefing → Run workflow

## 数据源说明

- 站点：`https://huarui.ccf.com.cn`（华瑞信息 · 化纤信息网）
- 该子站无需浏览器安全验证，但**正文需会员登录**后可见
- 页面为 GBK 编码，依赖 `iconv-lite` 解码
- 列表页：`/newscenter/list-110000.shtml`（当日全部快讯，约 28 篇/日）
- 正文容器：`<div id=newscontent>`
- 限流：短时间高频请求会触发 HTTP 429，脚本已内置指数退避重试

## 目录结构

```
scripts/
  ccf.js                  CCF 采集模块（登录 / 列表 / 正文）
  build_briefing.js       主流程（采集 → 整合 → 渲染 HTML）
  sync_signals_local.py   本机信号写卡（纯本地：读 data/ → 写知识库卡片，零 LLM/网络）
  notify.js               Server酱微信推送
  notify_dingtalk.js      钉钉推送（群机器人 / 企业机器人单聊）
auto-sync-card.bat        本机信号写卡入口（调 sync_signals_local.py）
.github/workflows/
  daily.yml               云端定时任务定义（渲染 + 发布 + 推送）
```

## 注意事项

- CCF 网页对高频请求有限流，脚本已内置重试
- 文章正文为会员内容，仅用于内部参考，请勿外传
- **简报内容由本机生成**（本机大模型），云端不调用任何 LLM，故无云端大模型费用
