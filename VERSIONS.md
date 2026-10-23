# 版本口径与历史版本（whl-guess）

> 2026-09-25 起本仓采用**自己的语义化版本**。此前全生态共用一个「增量 N」序列，那个序列的台账不在本仓
> （在俱乐部平台 `ROADMAP.md`），本仓只在少数几处标注过。**本表是本仓版本历史的唯一真源**：
> 历史文档/注释里的「增量 N」一律按本表换算为 `vX.Y.Z`。

## 判级口径

- **major**（`vX.0.0`）：① 对外/跨仓契约或 URL 不兼容；② 生产数据真源或口径重定义、需重导；③ 写入口下线或必须多仓同轮。
- **minor**（`vX.Y.0`）：新增用户可见能力（新页面 / 新端点 / 新规则），向后兼容。
- **patch**（`vX.Y.Z`）：无新增能力——缺陷修补、性能与读量治理、文档、内部重构、纯展示微调。
- 起点：本仓地基（无生产数据）= `v0.1.0`。**纯他仓的 wave 不占本仓版本号。**

## 历史版本

| 原增量 | 版本 | 主题 | 判级依据 |
| --- | --- | --- | --- |
| （1–8 未标注） | `v0.1.0` | 竞猜系统地基：CF Pages + Pages Functions + D1、竞猜/发奖/鸣谢 | 地基 |
| 9 | `v1.0.0` | 统一认证收口 / `user_binding` 镜像退役 | major：本仓认领 9B2 / 9C / 9D——停镜像停读、五处读点改实时查 auth、`isOidc` 改判 `AUTH_MODE`、删兼容直写死码（写入口下线） |
| 10 | `v1.0.1` | 用户列表按模式分流 | patch：无新增能力，内部重构（OIDC 分支不再 JOIN `user_binding`） |
| — | `v1.0.2` | 时间口径对齐：cron 对账时刻订正 + 读侧双格式防御 | patch：无新增能力——缺陷修补（`0 9 * * *` 按 CF UTC 实际北京 17:00 触发，与全仓「09:00 北京时间」承诺差 8 小时，订正为 `0 1 * * *`）；存量空格格式列判定不迁移、读侧解析归一防御（core.js `parseTs` / report.ts `fmtE8`）；`tests/cron-pair.test.ts` 静态锁 crons 双写一致性。依据：club 仓 v6.25.0 spec `2026-10-03-timezone-display-design.md` §3/§4 |
| — | `v1.1.0` | 顶栏右上角 ≡ 菜单：改密码 + 登出收纳进弹层 | minor：新增用户可见能力（≡ 弹层菜单，两页顶栏）；两页 HTML 加静态菜单壳（`.user-menu-wrap` 内 ≡ 按钮 + `role="menu"` 弹层，登出项 `role="menuitem"` 仅登录态随 userbox 显隐），`core.js` 加 `initUserMenu()`（开合 + aria-expanded 同步 + Esc/点外部/hashchange 三路收起，挂进 `initTopbar`），`renderTopbar` 写菜单头用户名；登出两段式确认语义一字未改，兼容模式无时区控件 ⇒ 不含时区档（对齐 club 仓 v6.41.0 同款改动的 guess 仓版）。`tests/topbar-menu.test.ts` 5 例静态锁（aria 契约 / 索引序 / 登出语义 / CSS 右锚 / 版本双写），变异 M1-M3 实测真红 |
| — | `v1.1.1` | 全站字体方案：正文 Inter + 绑定码 JetBrains Mono + 鸣谢弹窗宋体 | patch：无新增能力——纯展示微调（自托管字体），零迁移零接口零生产写。交付：`public/fonts/` 5 个 woff2（宋体子集 174,704 B / Inter 拉丁 48,444 + 扩展 74,328 / 等宽 40,404 + 15,196，全 OFL）；`public/style.css` 顶部 5 条 `@font-face`（全 swap）+ `--font-display/--font-sans/--font-mono` 令牌，body 改 `var(--font-sans)`；鸣谢标题与引文走宋体 600 + `font-synthesis-weight: none`，`.bigcode` / `code.kbd` 走等宽；两页各加 Inter latin preload（宋体不 preload，弹窗打开时才下）；`scripts/build-fonts.py` 再生成子集（1111 字 / CJK 871）；`tests/fonts.test.ts` 5 条静态锁。实测：`/` 只拉 48,444 B、鸣谢追加 174,704 B、绑定码页追加 40,404 B，无 latin-ext；375 无横向溢出；`npm test` 4 文件 29 例全绿。依据：club v6.53.2 / tour v5.8.1–5.8.3 同套方案；计划 `docs/plan-v1.1.1-font-scheme.md` |


**当前版本：`v1.1.1`**

## 落地位置

- 版本记录 = `package.json` 的 `version`。**本仓没有构建步骤**，静态资源（`public/*`）不经打包，
  因此**显示用的版本号在 `public/core.js` 的 `APP_VERSION`，与 package.json 手工同步**（改版本时两处一起改）。
- 页脚由 `public/core.js` 在模块求值时创建：`<footer class="app-footer">WHL 竞猜系统 · vX.Y.Z</footer>`。
  `index.html` 与 `admin.html` 分别经 `app.js` / `admin.js` 引入 core.js，故两个入口都自动带版本号。
- 样式 = `public/style.css` 的 `.app-footer`。
- 迁移文件名不随版本改（`migrations/0009_oidc_claims.sql` 等保留原名），只回填内容里的「增量 N」。

## 已知缺口

- 增量 1–8 在本仓**没有任何标注**（commit 里也没有），只能按时序归入地基，不可作判级依据。
- 本仓无 `typecheck` 脚本、无 tsconfig；验收靠 `npm test`（vitest，4 文件 29 例）。
