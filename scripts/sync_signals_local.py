#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本地信号闭环（纯本机 · 零 LLM · 不经 GitHub）
============================================
读本机简报 data/<date>.json，从其**已成型的结构化表格**中提取价格/事件信号，
幂等补写进知识库纵向卡 D:/工作/4市场/_卡片/行业价格信号与事件演进.md。

为什么不再调 LLM / 不再绕 GitHub（2026-10-15 重构，两次踩坑后的定论）：
  · 旧方案 A：云端 Actions 抽信号 → 落仓库快照 → 本机 pull 回来。
    前提是「本机不常在线」，但本机天天在跑简报，纯属绕路；且云端 LLM key 已失效
    （429 insufficient_quota），快照永远为空。
  · 旧方案 B：本机调 WorkBuddy 本地网关抽信号。实测网关能起、健康检查通，
    但 /api/v1/jobs 提交后 transcript 长时间拿不到正文，300s 超时
    （网关适合交互式问答，不适合这种批处理抽帧），且它依赖 WorkBuddy 桌面端在跑。
  · 定论：**简报 json 的 sections[].table 本身就是结构化信号表**（品种/价格/环比/备注），
    highpoints 也带方向 tag——直接规则化提取即可，无需任何模型，零依赖、零超时、可重复。

信号提取规则：
  1) 各 section 的 table.rows：每行 → 一条信号
     - 品种 = 行的第 1 列
     - 数值 = 第 2 列（附上「环比变化」列）
     - 方向 = 从中间各列解析：含 +/涨/升 → 涨；含 -/跌/降/下调 → 跌；0/持平/稳 → 稳；否则事件
     - 信号 = 行的最后一列（判断/备注）
     - 来源 = 按 section 标题粗映射（CCF快讯/CCF日报/市场速递/综合）
  2) 可选 --with-highlights：把 highpoints（带 up/down/stable tag）作为事件类补录。

幂等：卡片里已有 `<!-- 信号锚点: <date> -->` 则跳过，绝不重复写。

用法：
  python scripts/sync_signals_local.py                   # 处理 data/ 下最新一期
  python scripts/sync_signals_local.py 2026-10-15        # 指定日期
  python scripts/sync_signals_local.py --all             # 回填 data/ 下所有未入卡日期
  python scripts/sync_signals_local.py --dry-run         # 只预览
  python scripts/sync_signals_local.py --with-highlights # 额外补 highpoints 事件信号

依赖：仅标准库。
环境变量：
  SIGNALS_CARD_PATH   卡片绝对路径，缺省 D:/工作/4市场/_卡片/行业价格信号与事件演进.md
"""
import os
import re
import sys
import json
import glob

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(REPO_ROOT, "data")
CARD_PATH = os.environ.get("SIGNALS_CARD_PATH", r"D:\工作\4市场\_卡片\行业价格信号与事件演进.md")

DRY_RUN = "--dry-run" in sys.argv
ALL = "--all" in sys.argv
WITH_HIGHLIGHTS = "--with-highlights" in sys.argv
DATE_ARG = next((a for a in sys.argv[1:] if re.fullmatch(r"\d{4}-\d{2}-\d{2}", a)), None)

ANCHOR_RE = re.compile(r"<!-- 信号锚点: (\d{4}-\d{2}-\d{2}) -->")

# 各 section 标题 → 默认来源标注
SOURCE_HINTS = [
    ("原油", "CCF快讯"), ("原料", "CCF日报"), ("聚酯", "CCF日报"),
    ("下游", "市场速递"), ("再生", "市场速递"), ("产业", "CCF快讯"),
    ("政策", "CCF快讯"), ("趋势", "综合"),
]


def guess_source(section_title):
    for kw, src in SOURCE_HINTS:
        if kw in (section_title or ""):
            return src
    return "综合"


# 「纯变化列」形态：仅由 [+-]数字 + 可选单位/% 构成，如 -40元 / +1.01% / +6 美元 / 0
_CHANGE_ONLY = re.compile(r"^\s*[+\-−]?\s*\d+(\.\d+)?\s*(%|元|美元|成|万米|美元/吨|美元/桶)?\s*$")


def parse_direction(text):
    """从「环比变化」列解析方向。返回 涨/跌/稳/事件。

    只在**纯变化列**（-40元 / +1.01% / 0）上用符号判定，避免把
    「1-9月」「12.5%」「宽幅震荡」这类正文里的减号误当跌幅。
    非纯变化列则只看方向词，且要求涨跌词成对出现时才判定，避免
    「原料走强、以稳价为主」被单字词误判。
    """
    t = (text or "").strip()
    if not t:
        return "事件"

    # 1) 纯变化列：看符号
    if _CHANGE_ONLY.match(t):
        if re.match(r"^\s*0\s*$", t):
            return "稳"
        if re.match(r"^\s*[+\-−]", t):
            return "涨" if t.lstrip()[0] == "+" else "跌"
        return "稳"

    # 2) 非纯变化列：统计涨/跌/稳词，取「最明确」的一个
    up = sum(1 for k in ("涨", "上行", "走强", "推涨", "上调", "上移", "重心上") if k in t)
    down = sum(1 for k in ("跌", "下行", "走弱", "下调", "下滑", "回落", "重心下", "收缩") if k in t)
    flat = sum(1 for k in ("持平", "稳定", "维稳", "暂稳", "维持", "盘整", "稳价", "报价稳", "以稳") if k in t)
    # 明确方向词优先；并列时按出现顺序（先出现的为准）判定
    pos = [(t.find(k), "涨") for k in ("涨", "上行", "走强", "推涨", "上调", "上移") if k in t]
    neg = [(t.find(k), "跌") for k in ("跌", "下行", "走弱", "下调", "下滑", "回落", "收缩") if k in t]
    flat_pos = [(t.find(k), "稳") for k in ("持平", "稳定", "维稳", "暂稳", "维持", "盘整", "稳价", "以稳") if k in t]
    cand = pos + neg + flat_pos
    if cand:
        cand.sort(key=lambda x: x[0])
        return cand[0][1]
    return "事件"


def sig_from_table_row(section_title, row):
    """把一行表格转成一条信号 dict；不适用返回 None。"""
    cells = [("" if c is None else str(c)).strip() for c in row]
    cells = [c for c in cells if c != ""]
    if len(cells) < 2:
        return None
    name = cells[0]
    if name in ("品种", "环节", "方向", "指标", "类别", "项目"):
        return None
    value = cells[1]
    detail = cells[-1]
    mid = cells[1:-1] if len(cells) > 2 else []

    direction, change_col = "事件", ""
    for c in mid[::-1]:
        d = parse_direction(c)
        if d != "事件":
            direction, change_col = d, c
            break
    if direction == "事件":
        direction = parse_direction(detail)

    num = value
    if change_col and change_col not in value:
        num = "%s（%s）" % (value, change_col)

    signal = detail if detail and detail != name else value
    signal = re.sub(r"\s+", " ", signal).strip()
    if len(signal) > 60:
        signal = signal[:58] + "…"

    return {
        "方向": direction,
        "品种": name,
        "数值": num,
        "信号": signal,
        "来源": guess_source(section_title),
    }


def extract_signals(data):
    out = []
    for sec in (data.get("sections") or []):
        title = sec.get("title") or ""
        table = sec.get("table")
        rows = []
        if isinstance(table, dict):
            rows = table.get("rows") or []
        elif isinstance(table, list):
            rows = table
        for row in rows:
            if isinstance(row, (list, tuple)):
                s = sig_from_table_row(title, row)
                if s:
                    out.append(s)

    if WITH_HIGHLIGHTS:
        for h in (data.get("highpoints") or data.get("points") or []):
            tag = (h.get("tag") or "").strip().lower()
            d = {"up": "涨", "down": "跌", "stable": "稳"}.get(tag, "事件")
            txt = re.sub(r"\s+", " ", (h.get("text") or "")).strip()
            if not txt:
                continue
            out.append({
                "方向": d,
                "品种": "综合",
                "数值": "—",
                "信号": (txt[:58] + "…") if len(txt) > 60 else txt,
                "来源": "综合",
            })

    seen, uniq = set(), []
    for s in out:
        k = (s["品种"], s["数值"])
        if k in seen:
            continue
        seen.add(k)
        uniq.append(s)
    return uniq


def existing_anchors(card):
    return set(ANCHOR_RE.findall(card))


def render_block(date, signals):
    header = ("\n<!-- 信号锚点: %s -->\n"
              "| 日期 | 方向 | 品种 | 数值 | 信号 | 来源 |\n"
              "|---|---|---|---|---|---|" % date)
    rows = []
    for s in signals:
        rows.append("| %s | %s | %s | %s | %s | %s |" % (
            date, s["方向"], s["品种"], s["数值"], s["信号"], s["来源"]))
    return header + "\n" + "\n".join(rows) + "\n"


def list_dates():
    out = []
    for p in glob.glob(os.path.join(DATA_DIR, "*.json")):
        m = re.search(r"(\d{4}-\d{2}-\d{2})\.json$", os.path.basename(p))
        if m:
            out.append(m.group(1))
    return sorted(set(out))


def main():
    card = ""
    if os.path.exists(CARD_PATH):
        with open(CARD_PATH, encoding="utf-8") as f:
            card = f.read()
    done = existing_anchors(card)

    if DATE_ARG:
        targets = [DATE_ARG]
    elif ALL:
        targets = list_dates()
    else:
        all_d = list_dates()
        if not all_d:
            print("[sync] data/ 下无简报，结束。")
            return
        targets = [all_d[-1]]

    todo = [d for d in targets if d not in done]
    if not todo:
        print("[sync] 卡片已包含 %s 的信号，无需补写。" % ", ".join(targets))
        return

    blocks = []
    for d in todo:
        p = os.path.join(DATA_DIR, "%s.json" % d)
        if not os.path.exists(p):
            print("[sync] 跳过 %s：简报文件不存在" % d)
            continue
        try:
            with open(p, encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            print("[sync] 跳过 %s：解析失败 %s" % (d, e))
            continue
        sigs = extract_signals(data)
        if not sigs:
            print("[sync] %s 未提取到信号，跳过。" % d)
            continue
        print("[sync] %s 提取到 %d 条信号。" % (d, len(sigs)))
        blocks.append(render_block(d, sigs))

    if not blocks:
        print("[sync] 无新增信号，卡片未变更。")
        return

    if DRY_RUN:
        print("[sync][dry-run] 预览：")
        print("".join(blocks))
        return

    os.makedirs(os.path.dirname(CARD_PATH), exist_ok=True)
    with open(CARD_PATH, "w", encoding="utf-8") as f:
        f.write(card.rstrip() + "\n" + "".join(blocks))
    print("[sync] 已补写 %d 个日期到卡片：%s" % (len(blocks), CARD_PATH))


if __name__ == "__main__":
    main()
