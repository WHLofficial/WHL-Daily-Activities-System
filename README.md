# WHL 竞猜系统（whl-guess）

群友足球竞猜：免费提交预测 → 按档位发虚拟积分 → 战报回 QQ 群。积分真源在 AstrBot 积分插件，本系统只记「应收/已发」并推送发放指令。**全程无真钱。**

- 产品范围与决策记录：[PRD.md](./PRD.md)
- 技术方案与失败路径设计：[TECH_DESIGN.md](./TECH_DESIGN.md)
- 插件对接契约（含 Python 参考实现）：[docs/astrbot-sync-api.md](./docs/astrbot-sync-api.md)
- 插件开发任务书（可直接交给 Agent）：[docs/PLUGIN_PROMPT.md](./docs/PLUGIN_PROMPT.md)

## 架构

```
用户/管理员浏览器 ── Cloudflare Worker（静态 public/ 资源 + API + D1 + 内置 cron）
AstrBot 插件 ────── HMAC 轮询 /api/bind/claim、/api/reports/pending、/api/reports/ack
竞猜 Worker ─────── 推送 POST /sync/credit、GET /sync/summary?date= → 插件 HTTP 入口
内置 cron ────────── 每 5 分钟重试未到账发放项 + 扫截止前 4 小时的提醒；每天 09:00（UTC+8）对账
```

> 群通知（开放通知、截止前提醒）与战报共用 report 队列，用 `kind` 区分，插件侧无需新增接口。详见 [docs/astrbot-sync-api.md](docs/astrbot-sync-api.md)。

## 目录

```
migrations/                 # 0001 初始 17 表 + 0002 账号打通（tour_id/initiators）+ 后续增量
src/index.ts                # Worker 入口：/api/* → 路由，其余 → 静态资源；scheduled 处理 cron
src/api.ts                  # 全部 API 路由
src/_lib/                   # http/auth/judge/sync/report/reward/notify 工具库
public/                     # 用户端 index.html/app.js + 管理端 admin.html/admin.js
scripts/smoke-test.sh       # 端到端冒烟测试（20+ 步）
scripts/mock-plugin.js      # 模拟插件 HTTP 服务（联调用）
docs/astrbot-sync-api.md    # 插件侧对接文档
```

## 本地开发

```bash
npm install
# .dev.vars（本地环境变量，已 gitignore，测试值可自定）：
#   SYNC_SECRET=testsecret / CRON_SECRET=cronsecret
#   SYNC_BASE_URL=http://127.0.0.1:9991   ← 指向 mock 或真插件
npx wrangler d1 migrations apply whl-guess --local   # 初始化本地 D1
# 播种赛事本地库（兼容模式旧账密登录要查它；账号真源在 auth，本地只需与 auth 账号同 id 的 user 行。必须在 dev 启动【前】执行，dev 运行中跑会锁库静默失败）：
npx wrangler d1 execute whl --local --command "INSERT INTO organization (id,name,allow_open_reg) VALUES (1,'WHL',1) ON CONFLICT(id) DO UPDATE SET allow_open_reg=1"
npx wrangler d1 execute whl --local --command "INSERT OR IGNORE INTO user (name,password_hash,role) VALUES ('smboss','$(node scripts/gen-tour-hash.mjs secret123)','admin')"
npm run dev                                          # 起服务（8789，兼容模式）

# 另开两个终端：
SYNC_SECRET=testsecret node scripts/mock-plugin.js 9991   # 模拟插件
bash scripts/smoke-test.sh                                # 端到端冒烟（跑完人工核对输出）
```

冒烟脚本覆盖：播种赛事库（开放注册+管理员）→ 前端脚本语法检查 → 登录 → 注册（重名/弱密码拒绝）→ 建期（含已下线题型探针）→ 绑定码认领（含重放拒绝）→ 提交预测（未绑定拒绝）→ 他人答案可见 → 奖励一览（最高可得）→ 截止 → 录比分 → 结算断言（档位/上限/非参与者）→ 确认发奖（幂等 + 并发）→ 无人命中跳过发奖 → 猜胜负三种模式 → cron 重试（含错 key 拒绝）→ 每日对账 → 战报拉取 → 数据库核对 → 强制改密 → 开放通知与截止前提醒。

> **本地 dev 的模式开关**：`wrangler dev` 会继承 `wrangler.jsonc` 的 `vars`，而生产那套是 `AUTH_MODE=oidc`。所以 `npm run dev` 显式带 `--var AUTH_MODE:compat` 回到兼容模式（`src/_lib/oidc.ts:29` 的 `isOidc` 只认字面量 `'oidc'`），`npm run dev:oidc` 才是 OIDC 联调。`scripts/smoke-test.sh` 跑的是兼容模式链路，开头有模式闸门，跑错模式会带着正确命令直接退出。

**Windows 注意**：`wrangler dev` 崩溃后常残留 `workerd.exe` 孤儿进程，重启前先 `taskkill /F /IM workerd.exe`。本地开发用 8789 端口——8788 被历史僵尸连接污染过会一直挂起。

### OIDC 模式（统一认证迁移步骤②，auth 项目 PRD P0-6）

配置 `AUTH_MODE=oidc` + `OIDC_ISSUER` + `OIDC_CLIENT_ID` 三者齐备才切到认证中心登录（判定见 `src/_lib/oidc.ts:29` 的 `isOidc`；撤掉 `AUTH_MODE` 重新部署 = 回滚到共享 cookie/本地会话）；本地联调走 `npm run dev:oidc`，它把 ISSUER/CLIENT_ID 指向本地 8792 并补 `OIDC_REDIRECT_ORIGIN`（wrangler dev 会把 custom_domain 路由的 request.url 重写成 `http://guess.whleague.win`，需覆盖回本端口；生产是 https 正确值，无需配置）：

```bash
# 前置：auth 项目已起 dev（8792）并播种 guess client 与测试账号（auth 项目 seed-local-*.mjs 的 SQL）
#   guess 本地赛事库需有与 auth 账号同 id 的 user 行（如 id=6/7 → oidctest4/5），同样 dev 启动【前】执行
npm run db:migrate:local        # 0008_oidc_session（OIDC 本地会话表）
npm run dev:oidc                # 8796 端口起 OIDC 模式
npx vitest run                  # 单元测试（in-process 伪认证中心，7 例）
node scripts/smoke-oidc-local.mjs                        # 双服务联调（19 项断言，可连跑）
```

OIDC 模式行为变化：登录/注册/改密入口 302 移交认证中心（直写赛事库的旧代码不再可达）；本地 30 天会话退役，改用 7 天 OIDC 会话（`__Host-guess_session`）；QQ 绑定真源已搬到 auth 的 `identity` 表（增量 9B），OIDC 模式下本地 `user_binding` 停写停读、读点实时查 auth（兼容模式仍用本地 `user_binding`）；auth 主动登出会经 back-channel 通知本站按 sid 吊销会话。

> **⚠ 绑定迁移硬闸门（2026-09-14 生产事故后立规，现已闭环）**：`scripts/migrate-user-binding-to-auth.mjs` 把绑定搬到 auth 的 `identity` 表，须先于打开 `OIDC_ISSUER`/`OIDC_CLIENT_ID`。事故根因（登录时 `/userinfo` 的 `qq` 为空被当成「已解绑」而 `DELETE` 本地行）已由增量 9B 根除：`mirrorBinding` 退役，OIDC 模式下本地 `user_binding` 停写停读，读点改实时查 auth（`src/_lib/authLookup.ts`）。

## 部署（首次）

> 保姆级分步指南（含验证点/验收清单/故障排查）见 **[docs/DEPLOY.md](./docs/DEPLOY.md)**，以下为速查版。

1. **创建 D1**：`npx wrangler d1 create whl-guess --location apac`（亚太区），把 `database_id` 填进 `wrangler.jsonc`。
2. **建表**：`npx wrangler d1 migrations apply whl-guess --remote`。
3. **部署**：`npx wrangler deploy`——`routes` 里声明的 `guess.whleague.win` 自定义域自动开通（DNS+证书）。
4. **Secrets**：`npx wrangler secret put SYNC_SECRET / CRON_SECRET / SYNC_BASE_URL`（cron 已内置在 Worker，无独立服务）。

## 账号体系（统一认证：真源在 auth）

- **账号真源在 auth 认证中心**（`https://auth.whleague.win`）：生产 `AUTH_MODE=oidc` 下，登录/注册/改密入口 302 移交认证中心；姓名/状态/角色/权限全部来自登录回调存档的 claims（`src/_lib/auth.ts` 的 `parseOidcClaims`），不再查赛事库 `user` 表。赛事库 `whl` 的 `user` 表已退化为 auth 账号的精简镜像，**不要再新增对它的读写**。
- 本地 `users` 表只是镜像锚点（`users.tour_id` = auth account.id，由 claims 建立/更新），预测、发奖、对账的 JOIN 都锚在本地 `users.id`。
- 自动登录：OIDC 模式靠进站静默探测认证中心会话（`prompt=none`）；兼容模式靠跨项目共享 cookie——读赛事系统 KV（`SESSION_KV`）里的 `whl_session` 自动镜像登录（`users.tour_id`）。
- 兼容模式（未配 `AUTH_MODE`，理论回滚位）：注册/改密一律 410；旧账密登录 `POST /api/login` 仍只读校验赛事库 `user` 表（`src/_lib/tourcrypto.ts` 的 PBKDF2 单串格式）并建 30 天本地会话。
- 角色映射：OIDC 下由 claims 投影（`guess.admin` / `superadmin` → 竞猜管理员，其余 → 普通用户）；兼容模式按赛事库 `role` 映射（`admin`/`superadmin` → 管理员，其余含观众号 → 普通用户）。发起人是本库 `initiators` 名单，管理员在「发起人名单」里勾选。
- **提交预测前必须绑定 QQ**（未绑定提交返回 403 并引导到绑定页）；绑定码流程见插件对接文档。
- 主域名 `whleague.win`：竞猜绑 `guess.whleague.win`，赛事系统在 `tour.whleague.win`。
- 赛事系统侧执行 `npx wrangler secret put COOKIE_DOMAIN` 填 `.whleague.win`（用 secret 而非 vars：`wrangler deploy` 会覆盖 dashboard vars），cookie 即跨子域生效。

## 插件侧（AstrBot）

- 服务器需能访问插件：给腾讯云机器配 Cloudflare Tunnel（服务器只有 IP 无域名时的推荐方案），Tunnel 指向插件 HTTP 端口。
- 接口契约、签名算法、幂等与去重要求、Python 参考实现见 [docs/astrbot-sync-api.md](./docs/astrbot-sync-api.md)。
- 关键点：`/sync/credit` 必须按 `payout_id` 做唯一约束去重；战报「先发群成功、再 ack」。

## 日常运维

- **对账**：每天 09:00 自动跑昨日镜像 vs 插件汇总；管理台「对账」页可看 `ok/diff/error`，`diff` 时按明细人工冲正（批次页「冲正」按钮，生成反向流水）。
- **发奖失败**：批次页可见 `retry_count` / `next_retry_at` / `last_error`；退避 1/5/15/60 分钟共 5 次；卡住可手动重试或冲正。
- **P0 流程回顾**：建期 → 开放 → 截止 → 录比分 → 结算预览 → 确认发奖（自动推送+战报）→ 对账。

## 安全边界

- 全系统无真钱、无充值/提现/实物兑换入口（把竞猜变成赌博的唯一开关，永远不加）。
- API 密钥只在服务端环境变量；密码 PBKDF2-SHA256（与赛事系统一致的 25k 次迭代单串格式）；会话 cookie 仅存 token 哈希。
- 插件/内部通道全部 HMAC（±300s 窗口）+ 常量时间比对。
