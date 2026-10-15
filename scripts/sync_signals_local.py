#!/usr/bin/env python3
"""
本地信号同步（数据回流 · 本机侧）：
通过 GitHub API（绕开被拦的 github.com 主站）下载 fiber-briefing 仓库里
云端累积的信号快照 data/signals_snapshot.json，把其中尚未写入的日期信号
补写进本机知识库卡片 D:/工作/4市场/_卡片/行业价格信号与事件演进.md。

设计要点（借鉴邮件助手 GitHub Actions 方案 + github-auto-upload 的 API 通道）：
  - 云端（GitHub Actions）每天 9:00 简报后跑 backfill_signals.js 抽取信号、写快照并 commit。
  - 本脚本每天 12:00 后跑一次（由 WorkBuddy 定时自动化调度），用 GitHub API 下载快照
    （不走 git pull，避免主站 502），幂等补写本地实体卡片。
  - 本地卡片始终是实体文件（检索快、离线可用），云端快照是权威源。

依赖：仅 Python 标准库。token 从 github-auto-upload 的 config.json 读取（GH_TOKEN 可覆盖）。
用法：
  python sync_signals_local.py            # 下载快照 + 补写卡片
  python sync_signals_local.py --dry-run  # 只预览不写
  python sync_signals_local.py --no-fetch # 不联网，只用本地已有快照补写
"""
import json, os, re, sys, urllib.request

REPO = "TFHuaxuepin/fiber-briefing"
BRANCH = "main"
SNAPSHOT_PATH = "data/signals_snapshot.json"
CARD_PATH = os.environ.get("SIGNALS_CARD_PATH", r"D:\工作\4市场\_卡片\行业价格信号与事件演进.md")

DRY_RUN = "--dry-run" in sys.argv
NO_FETCH = "--no-fetch" in sys.argv

ANCHOR_RE = re.compile(r"<!-- 信号锚点: (\d{4}-\d{2}-\d{2}) -->")


def get_token():
    t = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or os.environ.get("GAU_TOKEN")
    if t:
        return t.strip()
    cfg = os.path.expanduser("~/.workbuddy/github-auto-upload/config.json")
    if os.path.exists(cfg):
        try:
            c = json.load(open(cfg, encoding="utf-8"))
            return (c.get("token") or "").strip()
        except Exception:
            pass
    return ""


def fetch_snapshot():
    """用 GitHub API 下载快照原始内容。返回 dict 或 None。"""
    token = get_token()
    if not token:
        print("[sync] 无 GitHub token，无法下载快照")
        return None
    # 尝试 raw.githubusercontent.com（通常可直连），失败再走 api.github.com contents API
    urls = [
        f"https://raw.githubusercontent.com/{REPO}/{BRANCH}/{SNAPSHOT_PATH}",
    ]
    req = urllib.request.Request(urls[0], headers={"Authorization": f"token {token}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:
        print(f"[sync] raw 直连失败（{e}），改用 contents API...")
    # contents API：返回 base64 编码的内容
    api = f"https://api.github.com/repos/{REPO}/contents/{SNAPSHOT_PATH}?ref={BRANCH}"
    req = urllib.request.Request(api, headers={
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github.v3+json",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read().decode("utf-8"))
            import base64
            return json.loads(base64.b64decode(data["content"]).decode("utf-8"))
    except Exception as e:
        print(f"[sync] contents API 失败: {e}")
        return None


def existing_anchors(card):
    return set(ANCHOR_RE.findall(card))


def render_row(date, s):
    direction = (s.get("方向") or "").strip() or "—"
    return f"| {date} | {direction} | {s.get('品种') or '—'} | {s.get('数值') or '—'} | {s.get('信号')} | {s.get('来源') or '综合'} |"


def render_block(date, signals):
    header = f"\n<!-- 信号锚点: {date} -->\n| 日期 | 方向 | 品种 | 数值 | 信号 | 来源 |\n|---|---|---|---|---|---|"
    rows = "\n".join(render_row(date, s) for s in signals)
    return f"{header}\n{rows}\n"


def main():
    # 1) 获取快照
    snap = None
    if not NO_FETCH:
        print("[sync] 从 GitHub 下载云端信号快照...")
        snap = fetch_snapshot()
    else:
        local = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "signals_snapshot.json")
        if os.path.exists(local):
            snap = json.load(open(local, encoding="utf-8"))
            print(f"[sync] 使用本地快照 {local}")

    if not snap:
        print("[sync] 无快照（云端尚未运行过回流，或网络不可达）。跳过。")
        return

    dates = sorted(snap.keys())
    print(f"[sync] 快照共 {len(dates)} 个日期: {', '.join(dates)}")

    # 2) 读本地卡片 + 已有锚点
    card = ""
    if os.path.exists(CARD_PATH):
        with open(CARD_PATH, encoding="utf-8") as f:
            card = f.read()
    done = existing_anchors(card)

    # 3) 待补写
    todo = [d for d in dates if d not in done]
    if not todo:
        print("[sync] 本地卡片已是最新，无需补写。")
        return

    blocks = "".join(render_block(d, snap[d] or []) for d in todo)

    if DRY_RUN:
        print(f"[sync][dry-run] 将补写 {len(todo)} 个日期: {', '.join(todo)}")
        print(blocks)
        return

    # 4) 写卡（追加到末尾，日期升序）
    os.makedirs(os.path.dirname(CARD_PATH), exist_ok=True)
    with open(CARD_PATH, "w", encoding="utf-8") as f:
        f.write(card.rstrip() + "\n" + blocks)
    print(f"[sync] 已补写 {len(todo)} 个日期到本地卡片: {', '.join(todo)}")
    print(f"[sync] 卡片: {CARD_PATH}")


if __name__ == "__main__":
    main()
