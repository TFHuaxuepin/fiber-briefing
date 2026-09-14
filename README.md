# 化纤行业每日信息简报（云端自动版）

每天北京时间 09:00 由 GitHub Actions 自动运行，**无需本机开机**，登录华瑞信息 CCF 化纤信息网采集当日快讯正文，调用大模型整合为分析师风格信息简报，并发布到 GitHub Pages。

## 工作原理

1. GitHub Actions 按计划触发（cron `0 1 * * *` UTC = 北京 09:00）
2. 用 CCF 会员账号登录 `huarui.ccf.com.cn`，获取会话 cookie
3. 抓取「CCF 快讯」当日列表，逐篇抓取正文（GBK 解码，内置 429/5xx 退避重试）
4. 调用大模型（默认联通云 `deepseek-v4-pro`），把当日快讯交叉整合为带数据、表格、判断的行业简报
5. 生成当日 HTML + 历史目录页，自动发布到 GitHub Pages

## 必须配置的仓库 Secrets（Settings → Secrets and variables → Actions）

| Secret 名 | 值 | 说明 |
|---|---|---|
| `CCF_USERNAME` | CCF 会员账号 | **必填**，华瑞信息网登录账号 |
| `CCF_PASSWORD` | CCF 会员密码 | **必填** |
| `LLM_API_KEY` | 大模型 API Key | 必填，用于智能整合 |
| `LLM_BASE_URL` | `https://token.chinaunicomglobal.com` | 选填，默认即此值 |
| `LLM_MODEL` | `deepseek-v4-pro` | 选填，默认即此值 |
| `SERVERCHAN_KEY` | Server酱 SendKey | 选填，配置后推送微信通知 |

不配置 `LLM_API_KEY` 时脚本会降级为标题列表，不会报错。

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
  ccf.js              CCF 采集模块（登录 / 列表 / 正文）
  build_briefing.js   主流程（采集 → 整合 → 渲染 HTML）
  notify.js           Server酱微信推送
.github/workflows/
  daily.yml           定时任务定义
```

## 注意事项

- CCF 网页对高频请求有限流，脚本已内置重试；若持续 429 会自动降级
- 文章正文为会员内容，仅用于内部参考，请勿外传
- 大模型调用约每日几分钱，用量极低
