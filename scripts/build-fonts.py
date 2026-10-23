#!/usr/bin/env python3
"""生成竞猜站的宋体子集（Noto Serif SC 600）。

用法：python scripts/build-fonts.py
产物：public/fonts/noto-serif-sc-600-subset.woff2

字符集 = 站点源码里出现的全部字符 + 赛事平台 20 支球队中文名 + ASCII/Latin-1/Latin-Ext-A + 中文标点。
赛程/竞猜标题是运营在管理台手填的，不在源码里，因此衬线只用于固定 UI 文案（鸣谢弹窗），
动态文案继续走系统黑体——子集缺字时逐字回退系统宋体，不会出豆腐块。
"""
from __future__ import annotations

import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE = ROOT / "scripts" / ".font-cache"
TTF = CACHE / "NotoSerifSC_600SemiBold.ttf"
CHARS = CACHE / "chars.txt"
OUT = ROOT / "public" / "fonts" / "noto-serif-sc-600-subset.woff2"
TTF_URL = (
    "https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-serif-sc@0.4.4/"
    "600SemiBold/NotoSerifSC_600SemiBold.ttf"
)

# 赛事平台的 20 支球队中文名（竞猜页会渲染对阵双方）
TEAM_NAMES = (
    "AC米兰(CPU) RB莱比锡 佛罗伦萨 切尔西 利物浦 奥林匹亚科斯 尤文图斯 巴塞罗那 "
    "巴黎圣日耳曼 慕尼黑1860 拜仁慕尼黑 曼城(CPU) 曼联 皇家贝蒂斯 皇家马德里 "
    "纽卡斯尔联 诺丁汉森林 里昂 阿斯顿维拉 阿森纳"
).split()

PUNCT = "，。！？：；、（）【】《》「」『』“”‘’…—·～￥％＋－×÷＝"

SCAN_GLOBS = [
    "public/**/*.html",
    "public/**/*.js",
    "public/**/*.css",
    "src/**/*.ts",
    "cron-worker/**/*.ts",
]


def collect_chars() -> str:
    chars: set[str] = set()
    for pattern in SCAN_GLOBS:
        for path in ROOT.glob(pattern):
            if path.is_file():
                chars |= set(path.read_text(encoding="utf-8", errors="ignore"))
    chars |= set("".join(TEAM_NAMES))
    chars |= {chr(c) for c in range(0x20, 0x7F)}
    chars |= {chr(c) for c in range(0xA0, 0x100)}
    chars |= set(PUNCT)
    return "".join(sorted(chars))


def main() -> int:
    CACHE.mkdir(parents=True, exist_ok=True)
    if not TTF.exists():
        print(f"下载 {TTF_URL}")
        subprocess.run(["curl", "-fsSL", TTF_URL, "-o", str(TTF)], check=True)
    text = collect_chars()
    CHARS.write_text(text, encoding="utf-8")
    cjk = sum(1 for c in text if "\u4e00" <= c <= "\u9fff")
    print(f"字符集 {len(text)} 字（CJK {cjk}）")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            sys.executable,
            "-m",
            "fontTools.subset",
            str(TTF),
            f"--text-file={CHARS}",
            f"--output-file={OUT}",
            "--flavor=woff2",
            "--layout-features=kern,liga,locl,ccmp",
            "--glyph-names",
            "--symbol-cmap",
            "--legacy-cmap",
            "--notdef-glyph",
            "--notdef-outline",
            "--recommended-glyphs",
        ],
        check=True,
    )
    print(f"产物 {OUT.relative_to(ROOT)} {OUT.stat().st_size:,} B")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
