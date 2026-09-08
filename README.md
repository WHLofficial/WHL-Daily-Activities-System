# WHL 竞猜系统（whl-guess）

群友足球竞猜：免费提交预测 → 按档位发虚拟积分 → 战报回 QQ 群。积分真源在 AstrBot 积分插件，本系统只记「应收/已发」并推送发放指令。**全程无真钱。**

- 产品范围与决策记录：[PRD.md](./PRD.md)
- 技术方案与失败路径设计：[TECH_DESIGN.md](./TECH_DESIGN.md)
- 插件对接契约（含 Python 参考实现）：[docs/astrbot-sync-api.md](./docs/astrbot-sync-api.md)

## 架构

```
用户/管理员浏览器 ── Cloudflare Pages（静态 public/ + Functions API + D1）
AstrBot 插件 ────── HMAC 轮询 /api/bind/claim、/api/reports/pending、/api/reports/ack
Cloudflare Pages ── 推送 POST /sync/credit、GET /sync/summary?date= → 插件 HTTP 入口
cron-worker ─────── 每 5 分钟触发重试通道；每天 09:00（UTC+8）触发对账
```

## 目录

```
migrations/0001_init.sql    # 17 张表（D1 schema）
functions/_lib/             # http/auth/judge/sync/report 工具库
functions/api/[[path]].ts   # 全部 API 路由
public/                     # 用户端 index.html/app.js + 管理端 admin.html/admin.js
cron-worker/                # 独立 Cron Worker（薄壳，只打内部接口）
scripts/smoke-test.sh       # 12 步端到端冒烟测试
scripts/mock-plugin.js      # 模拟插件 HTTP 服务（联调用）
docs/astrbot-sync-api.md    # 插件侧对接文档
```

## 本地开发

```bash
npm install
# .dev.vars（本地环境变量，已 gitignore，测试值可自定）：
#   SETUP_TOKEN=testtoken / SYNC_SECRET=testsecret / CRON_SECRET=cronsecret
#   SYNC_BASE_URL=http://127.0.0.1:9991   ← 指向 mock 或真插件
npx wrangler d1 migrations apply whl-guess --local   # 初始化本地 D1
npx wrangler pages dev public --port 8788            # 起服务（首次会拉 wrangler）

# 另开两个终端：
SYNC_SECRET=testsecret node scripts/mock-plugin.js 9991   # 模拟插件
bash scripts/smoke-test.sh                                # 端到端冒烟（跑完人工核对输出）
```

冒烟脚本覆盖：管理员 setup → 建号 → 建期 → 绑定码认领（含重放拒绝）→ 提交预测 → 截止 → 录比分 → 结算预览（档位/上限）→ 确认发奖 → cron 重试（含错 key 拒绝）→ 每日对账 → 战报拉取 → 数据库核对。

**Windows 注意**：`wrangler dev` 崩溃后常残留 `workerd.exe` 孤儿进程占 8788 端口，重启前先 `taskkill /F /IM workerd.exe`；确认 8788 上无多个 LISTENING 再访问（`netstat -ano | findstr 8788`）。

## 部署（首次）

> 保姆级分步指南（含验证点/验收清单/故障排查）见 **[docs/DEPLOY.md](./docs/DEPLOY.md)**，以下为速查版。

1. **创建 D1**：`npx wrangler d1 create whl-guess`，把返回的 `database_id` 填进 `wrangler.toml`（替换 `TODO_REPLACE_WITH_D1_ID`）。
2. **建表**：`npx wrangler d1 migrations apply whl-guess --remote`。
3. **Pages**：`npx wrangler pages deploy public`（或接 Git 集成，构建命令留空、输出目录 `public`、Functions 自动识别 `functions/`）。
4. **环境变量**（Pages 项目 Settings → Variables，生产值）：
   - `SYNC_SECRET`：与插件共享的 HMAC 密钥（长随机串）
   - `SYNC_BASE_URL`：插件公网 HTTP 入口（见下「插件侧」）
   - `SETUP_TOKEN`：**首次初始化管理员用，初始化完成后从环境变量中删除**（关闭 setup 入口）
   - `CRON_SECRET`：内部 cron 通道密钥
5. **Cron Worker**：
   ```bash
   cd cron-worker
   npx wrangler deploy           # wrangler.jsonc 里已声明两条 cron
   npx wrangler secret put CRON_SECRET   # 值与 Pages 侧一致
   ```
   并把 cron-worker 的 `APP_URL`（wrangler.jsonc vars）改为 Pages 生产域名。
6. **自定义域名**：Pages 项目绑自定义域（大陆可达性，`*.pages.dev` 常被 DNS 污染）。

## 账号体系（已对接赛事系统）

- 竞猜系统**不重做注册登录**：跨项目绑定赛事系统的 KV（`SESSION_KV`）与 D1（`TOUR_DB`），读 `whl_session` cookie 验证身份，用户镜像进本库（`users.tour_id`）。
- 角色映射：赛事 `admin/superadmin` → 竞猜管理员；`coach`（含观众号）→ 普通用户；发起人是本库 `initiators` 名单，管理员在「发起人名单」里勾选。
- **提交预测前必须绑定 QQ**（未绑定提交返回 403 并引导到绑定页）；绑定码流程见插件对接文档。
- 主域名 `whleague.win`：竞猜绑 `guess.whleague.win`，赛事系统在 `whleague.win`（或其子域）。
- 赛事系统侧执行 `npx wrangler secret put COOKIE_DOMAIN` 填 `.whleague.win`（用 secret 而非 vars：`wrangler deploy` 会覆盖 dashboard vars），cookie 即跨子域生效。
- 本地开发两端口不共享 cookie，用保留的自建账号登录联调（管理员 setup 流程不变）。

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
- API 密钥只在服务端环境变量；密码 PBKDF2-SHA256（10 万次迭代）；会话 cookie 仅存 token 哈希。
- 插件/内部通道全部 HMAC（±300s 窗口）+ 常量时间比对。
