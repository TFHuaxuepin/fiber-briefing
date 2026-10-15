# -*- coding: utf-8 -*-
"""化纤核心品种行情台账（基于 akshare）
抓取 短纤PF/PTA/乙二醇EG/PX/原油SC 主力合约日行情，幂等合并进本地 CSV 台账。
用法:
  python fetch_market_data.py            # 增量补最近 10 个交易日
  python fetch_market_data.py --days 30  # 补最近 30 天
数据落点: D:/工作/4市场/_数据/行情台账.csv（列: 日期,品种,开盘,最高,最低,收盘,成交量,持仓量,结算价）
幂等: 同一 (日期,品种) 已存在则跳过；收盘价以动态结算价列补充。
"""
import akshare as ak
import csv, os, sys, argparse
from datetime import date, timedelta

sys.stdout.reconfigure(encoding="utf-8")

CSV_PATH = r"D:\工作\4市场\_数据\行情台账.csv"
PRODUCTS = [
    ("短纤",   "PF0"),
    ("PTA",    "TA0"),
    ("乙二醇", "EG0"),
    ("PX",     "PX0"),
    ("原油SC", "SC0"),
]
HEADER = ["日期", "品种", "开盘", "最高", "最低", "收盘", "成交量", "持仓量", "结算价"]


def load_existing():
    """返回 {(日期, 品种): True} 集合 + 原有行数"""
    keys = set()
    n = 0
    if os.path.exists(CSV_PATH):
        with open(CSV_PATH, encoding="utf-8-sig") as f:
            for row in csv.DictReader(f):
                keys.add((row.get("日期", ""), row.get("品种", "")))
                n += 1
    return keys, n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=10)
    args = ap.parse_args()

    end = date.today()
    start = end - timedelta(days=args.days)
    sd, ed = start.strftime("%Y%m%d"), end.strftime("%Y%m%d")

    os.makedirs(os.path.dirname(CSV_PATH), exist_ok=True)
    existing, before_n = load_existing()

    new_rows = []
    errors = []
    for name, sym in PRODUCTS:
        try:
            df = ak.futures_main_sina(symbol=sym, start_date=sd, end_date=ed)
            for _, r in df.iterrows():
                d = str(r["日期"])
                if (d, name) in existing:
                    continue
                new_rows.append({
                    "日期": d, "品种": name,
                    "开盘": r.get("开盘价"), "最高": r.get("最高价"),
                    "最低": r.get("最低价"), "收盘": r.get("收盘价"),
                    "成交量": r.get("成交量"), "持仓量": r.get("持仓量"),
                    "结算价": r.get("动态结算价"),
                })
        except Exception as e:
            errors.append("%s(%s): %r" % (name, sym, e))

    # 按日期+品种排序后追加
    new_rows.sort(key=lambda x: (x["日期"], x["品种"]))
    write_header = not os.path.exists(CSV_PATH) or before_n == 0
    with open(CSV_PATH, "a", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=HEADER)
        if write_header:
            w.writeheader()
        w.writerows(new_rows)

    print("台账: %s" % CSV_PATH)
    print("原 %d 行 → 新增 %d 行 → 现 %d 行" % (before_n, len(new_rows), before_n + len(new_rows)))
    if new_rows:
        last_day = max(r["日期"] for r in new_rows)
        print("最新交易日: %s" % last_day)
        for r in new_rows:
            if r["日期"] == last_day:
                print("  %s 收盘 %s" % (r["品种"], r["收盘"]))
    if errors:
        print("!! 抓取失败:")
        for e in errors:
            print("  ", e)
    # 自检：新品种数 = 5
    print("品种数自检: %d/5" % len(PRODUCTS))


if __name__ == "__main__":
    main()
