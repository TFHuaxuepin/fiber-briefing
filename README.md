# 化纤行业公众号每日信息简报（云端自动版）

每天北京时间 09:00 由 GitHub Actions + DeepSeek 自动运行，**无需本机开机**，自动采集推文、深度阅读正文、整合为分析师风格信息简报并发布到 GitHub Pages。

## 工作原理

1. GitHub Actions 按计划触发（cron `0 1 * * *` UTC = 北京 09:00）
2. 通过搜狗微信搜索，多关键词检索化纤行业公众号文章
3. 解析真实链接并抓取正文（受反爬限制，部分可能仅得标题/摘要）
4. 调用 DeepSeek 大模型，把多篇推文内容梳理整合为带数据、表格、判断的行业简报
5. 生成当日 HTML + 历史目录页，自动发布到 GitHub Pages

## 必须配置的仓库 Secrets（Settings → Secrets and variables → Actions）

| Secret 名 | 值 | 说明 |
|---|---|---|
| `LLM_API_KEY` | 你的 DeepSeek API Key | 必填，获取：https://platform.deepseek.com/ |
| `LLM_BASE_URL` | `https://api.deepseek.com` | 选填，默认即此值 |
| `LLM_MODEL` | `deepseek-chat` | 选填，默认即此值 |

不配置 `LLM_API_KEY` 时脚本会降级为简单推文列表，不会报错。

## 启用 GitHub Pages

仓库 Settings → Pages → Source 选择 `gh-pages` 分支、`/(root)` 目录。首次运行 workflow 后该分支会自动创建。

## 指定公众号（scripts/build_briefing.js 的 ACCOUNTS）

- 化纤头条
- 中国化学纤维工业协会
- 化纤邦
- 华瑞信息

修改名单只需编辑 `ACCOUNTS` 与 `KEYWORDS` 两个数组。

## 手动触发

Actions 页面 → Daily Fiber Briefing → Run workflow

## 注意事项

- 搜索依赖搜狗微信搜索，云端 IP 可能被反爬限流，脚本已内置自动重试
- 部分文章正文因反爬无法抓取，简报会依据标题/摘要生成并标注
- DeepSeek 调用约每日几分钱，用量极低
