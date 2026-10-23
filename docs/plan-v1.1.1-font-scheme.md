# v1.1.1 字体方案实现计划（whl-guess）

> 2026-10-23。全平台字体方案的第三站（club v6.53.2 → tour v5.8.1/5.8.2/5.8.3 → guess → auth）。
> 判级 **patch**：纯展示微调，无新能力、无接口、无迁移。

## 1. 现状与约束

- 纯静态站：`public/index.html` + `public/admin.html` + `style.css` + `app.js/admin.js/core.js`，
  **无构建步骤**（`public/` 由 wrangler assets 原样发布），版本号在 `package.json` 与
  `public/core.js` 的 `APP_VERSION` 手工双写（VERSIONS.md「落地位置」）。
- 原正文：`body { font: 15px/1.55 system-ui, -apple-system, "Segoe UI", "PingFang SC",
  "Microsoft YaHei", sans-serif }`；全站 **没有任何 `h1` / `h2`**，标题只有 `.card h3` 16px
  与鸣谢弹窗的 `.credit-title` 20px。
- 数字：`td.num, th.num` 已有 `tabular-nums`（比例字对齐够用）；真正需要等宽的是
  `.bigcode`（绑定码 34px / 800 / 字距 6px）与 `code.kbd`（「绑定 631233」）。
- 本地开发：`npm run dev` = `wrangler dev --port 8789 --var AUTH_MODE:compat`（兼容模式，
  匿名可看，登录后才有绑定码页）。

## 2. 裁决

| # | 裁决 | 理由 |
| --- | --- | --- |
| F1 | 正文自托管 **Inter**（latin + latin-ext 双 unicode-range），中文仍落系统黑体 | 与 club/tour 同一套；CJK 网络字体 300KB+ 不值 |
| F2 | **不加衬线标题**，`.card h3`（16px）保持黑体 | 本站没有 22px 以上标题；16px 衬线笔画发虚（tour 的 13–15px h3 同款结论） |
| F3 | 衬线只给**鸣谢弹窗**：`.credit-title` 20px + `.credit-quote` 14px，600 + `font-synthesis-weight: none` | 站内唯一的「信件」场景（引文 + 落款），衬线比黑体更像一封回信；A/B 截图见下 |
| F4 | 宋体子集 174,704 B **不 preload**，随弹窗按需下载 | 首页零成本；常开弹窗的人只付一次（浏览器缓存） |
| F5 | 等宽只给 `.bigcode` / `code.kbd` | 绑定码要逐位读，`0/O`、`1/l` 靠等宽区分；表格数字继续用 `tabular-nums` 的比例字，不改列宽 |
| F6 | 只 preload `inter-latin.woff2`（crossorigin） | 首屏唯一确定会用到的网络字体 |

### 关于「猜胜负」比分为什么不用等宽

tour v5.8.2 曾把分享卡比分切到 JetBrains，用户当场反馈「间距太大」并在 v5.8.3 回退。
guess 的比分是表单 `input.score-in`（17px / 700）与表格数字，比例字 + tabular 已够读，
不再重犯。

## 3. 交付

- `public/fonts/`：5 个 woff2（宋体子集 + Inter ×2 + JetBrains ×2）+ 3 份 OFL + `README.md`。
- `scripts/build-fonts.py`：宋体子集再生成（扫描 public + src + cron-worker + 20 队名 +
  ASCII/Latin-1 + 中文标点），字符集 1111 字（CJK 871）→ 174,704 B；原 TTF 缓存在
  `scripts/.font-cache/`（gitignore）。
- `public/style.css`：顶部 5 条 `@font-face`（全 `font-display: swap`）；`:root` 新增
  `--font-display` / `--font-sans` / `--font-mono`；`body` 改 `font-family: var(--font-sans)`；
  鸣谢两条规则走衬线；`.bigcode` / `code.kbd` 走等宽。
- `public/index.html`、`public/admin.html`：各加一条 `inter-latin` preload（crossorigin）。
- `tests/fonts.test.ts`：5 条静态锁（@font-face 全 swap 且无 `local()`、body 不再写死系统栈、
  衬线 600 + 禁合成、两页只 preload Inter、五个文件体积锁定）。
- `package.json` / `public/core.js`：1.1.0 → **1.1.1**。

## 4. 验收实测（本地 dist @ 8789）

- 字体请求：`/` 只拉 `inter-latin.woff2`（48,444 B）；打开鸣谢追加
  `noto-serif-sc-600-subset.woff2`（174,704 B）；绑定码页追加 `jbmono-latin.woff2`（40,404 B）。
  无 latin-ext、无 404。
- computed family：body `Inter` 15px；`.card h3` `Inter` 16px/700（黑体）；
  `.credit-title` / `.credit-quote` `Noto Serif SC` 600；`.bigcode` `JetBrains Mono` 34px/800；
  `code.kbd` `JetBrains Mono` 13px。
- 窄屏：375px 下 `/` 与 `#/bind` 的 `scrollWidth == innerWidth`（375），绑定码不溢出。
- 测试：`npm test` **4 文件 / 29 例全绿**（新增 5 例）。

## 5. 回退

删 `public/fonts/` 与 `style.css` 顶部 `@font-face` 块、把 `body` 的 `font-family` 与两条
`.credit-*` / `.bigcode` / `code.kbd` 的字体声明去掉即可，无数据与接口依赖。

## 6. 待办

- [ ] 发布：`npm run deploy`（Workers Builds 是否自动出包待观察），上线后回写 VERSIONS 与 AGENTS 口径。
- [ ] 如果以后给 guess 加页面级标题（≥22px），再把该选择器并进 `--font-display` 并重跑子集脚本。
- [ ] 管理台表头/数字若出现对齐问题，再评估 `td.num` 是否切换等宽（本轮不动列宽）。
