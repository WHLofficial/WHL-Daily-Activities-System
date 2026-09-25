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

**当前版本：`v1.0.1`**

## 落地位置

- 版本记录 = `package.json` 的 `version`。**本仓没有构建步骤**，静态资源（`public/*`）不经打包，
  因此**显示用的版本号在 `public/core.js` 的 `APP_VERSION`，与 package.json 手工同步**（改版本时两处一起改）。
- 页脚由 `public/core.js` 在模块求值时创建：`<footer class="app-footer">WHL 竞猜系统 · vX.Y.Z</footer>`。
  `index.html` 与 `admin.html` 分别经 `app.js` / `admin.js` 引入 core.js，故两个入口都自动带版本号。
- 样式 = `public/style.css` 的 `.app-footer`。
- 迁移文件名不随版本改（`migrations/0009_oidc_claims.sql` 等保留原名），只回填内容里的「增量 N」。

## 已知缺口

- 增量 1–8 在本仓**没有任何标注**（commit 里也没有），只能按时序归入地基，不可作判级依据。
- 本仓无 `typecheck` 脚本、无 tsconfig；验收靠 `npm test`（vitest，1 文件 16 例）。
