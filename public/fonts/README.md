# 字体文件（v1.1.1 起）

全部自托管、全部 OFL，与俱乐部平台 / 赛事平台同一套三族。**目录不入构建**：本仓没有打包步骤，
`public/` 原样发布，所以这里加文件就是在线上加文件。

## 文件

| 文件 | 字节 | 用途 | 来源 |
| --- | --- | --- | --- |
| `inter-latin.woff2` | 48,444 | 正文拉丁（`--font-sans` 首位） | `@fontsource-variable/inter@5.2.5` |
| `inter-latin-ext.woff2` | 74,328 | 拉丁扩展（Š/Đ/Ł 等），`unicode-range` 按需 | 同上 |
| `jbmono-latin.woff2` | 40,404 | 绑定码 / `code.kbd`（`--font-mono`） | `@fontsource-variable/jetbrains-mono@5.2.5` |
| `jbmono-latin-ext.woff2` | 15,196 | 等宽拉丁扩展，按需 | 同上 |
| `noto-serif-sc-600-subset.woff2` | 174,704 | 鸣谢弹窗标题与引文（`--font-display`） | Noto Serif SC 600 子集，见下 |

中文正文**不下载**网络字体，落系统黑体（`PingFang SC` / `Microsoft YaHei` / `Noto Sans SC`）。
宋体子集只在打开「鸣谢」弹窗时才下载，没有 preload。

## 再生成宋体子集

```bash
python scripts/build-fonts.py
```

脚本会下载 `@expo-google-fonts/noto-serif-sc@0.4.4/600SemiBold/NotoSerifSC_600SemiBold.ttf`
到 `scripts/.font-cache/`（已 gitignore），扫描 `public/**/*.{html,js,css}` + `src/**/*.ts` +
`cron-worker/**/*.ts` + 赛事平台 20 支球队中文名 + ASCII / Latin-1 + 中文标点，输出上面的 woff2。
当前字符集 1111 字（CJK 871）。

**改了鸣谢文案或新增中文界面文案后要重跑**，否则新字不在子集里，会逐字回退系统宋体
（不出豆腐块，但同屏会混两种宋体字形）。

## 硬约束

1. 子集只有 **600** 一个字重。任何用 `--font-display` 的规则必须写 `font-weight: 600` 并加
   `font-synthesis-weight: none`，否则浏览器合成假粗，中文会糊。
2. `@font-face` 不要加 `local()`：族名 `Noto Serif SC` / `Inter` / `JetBrains Mono` 与系统字体同名时，
   加了 `local()` 会在装了完整字体的机器上跳过自托管文件，各端字形不一致。
3. 拉丁字体必须带 `unicode-range`；去掉后 latin-ext 会在首屏被一起下载，白付 73KB。

## 许可

- `OFL-NotoSerifSC.txt` — Noto Serif SC（SIL Open Font License 1.1）
- `OFL-Inter.txt` — Inter（SIL Open Font License 1.1）
- `OFL-JetBrainsMono.txt` — JetBrains Mono（SIL Open Font License 1.1）
