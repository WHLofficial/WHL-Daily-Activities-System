# 技术方案 · WHL 竞猜系统

- 版本：v0.1（收敛初稿，已确认落盘）
- 日期：2026-09-06
- 状态：开发中（MVP 代码已全部落盘）
- 进度（2026-09-08）：MVP 已实现并通过本地端到端冒烟测试；线上部署与真实插件联调待做
- 配套文档：[PRD.md](./PRD.md)

## 结论先行

- **部署**：单个 Cloudflare Worker（静态资源 + API + 内置 cron，与赛事系统同构；D1 建在亚太区）绑 `guess.whleague.win`；AstrBot 积分插件加同步 API，经 Cloudflare Tunnel 暴露 HTTPS；战报与群通知由插件**出站轮询拉取**。（2026-09-09 已从 Pages 迁移为纯 Worker，cron 不再需要独立服务）
- **同步**：余额真源只在 AstrBot；竞猜库只存「应发凭证 + 流水镜像」；每笔资金操作带全局唯一单号（payout_id），插件侧用唯一索引做**防重发最终防线**；Workers 超时重试 + 每日对账兜底。

## 一、部署架构

```
群友手机浏览器
   │
CF Worker（静态前端 + API + cron）──D1（竞猜库）
                              │ ① 发奖 HTTPS + HMAC 签名（经 Cloudflare Tunnel）
                              ▼
        云服务器（国内，仅 IP）：AstrBot + 积分插件（同步 API + 同步流水表）
                              │ ② 拉战报与群通知（出站轮询，每分钟）
                              ▼
                    Worker /api/reports/pending
```

- **① 发奖方向**：cloudflared 在服务器上**主动**连 Cloudflare 建隧道（Cloudflare Tunnel），服务器不开任何入站端口、不需要域名和证书、换 IP 不影响；Worker 直接调隧道地址。远期迁香港零改动。
- **② 群通知方向**：国内入站不稳、出站稳，所以战报与群通知都由插件**主动来拉**，而不是竞猜侧去推。竞猜侧零暴露。

- **① 发奖方向**：cloudflared 在服务器上**主动**连 Cloudflare 建隧道（Cloudflare Tunnel），服务器不开任何入站端口、不需要域名和证书、换 IP 不影响；Workers 直接调隧道地址。远期迁香港零改动。
- **② 群通知方向**：国内入站不稳、出站稳，所以战报与群通知都由插件**主动来拉**，而不是竞猜侧去推。竞猜侧零暴露。

### 技术选型（两句式）

| 选型 | 用什么 + 为什么 + 代价 |
|------|------|
| 前端 | 无框架无构建的静态页（原生 ES Module）随 Worker 一起发布：移动优先，改完即部署，不用管打包工具链。代价：无 SEO（群内分享场景无所谓）、复杂交互要靠手写。 |
| 后端 | 单个 Cloudflare Worker（静态资源 + API + 内置 cron 同仓同域）：免运维。代价：每次调用外部请求上限 50 个（免费档）、定时任务 CPU 仅 10 毫秒（纯等网络不计 CPU，够用）。来源：[Workers Limits](https://developers.cloudflare.com/workers/platform/limits/) |
| 数据库 | D1（CF 家的云端 SQLite）：`batch()` 打包的语句是原子事务、全成或全回滚（官方保证）。代价：不支持「语句中间夹应用逻辑」的交互式事务，用 batch 打包规避。来源：[D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/) |
| 不用 KV 存资金数据 | KV 是最终一致的全球缓存（写入后其他节点最长约 60 秒才可见），只能放缓存类数据，余额/凭证一律 D1。来源：[KV 工作原理](https://developers.cloudflare.com/kv/concepts/how-kv-works/) |
| 重试通道 | P0 用定时任务（cron 每 5 分钟）扫描重试，并顺带扫「截止前 4 小时」的提醒，≤30 人规模足够；P2 升级 Cloudflare Queues（至少一次送达，官方建议幂等键做主键，与本设计天然契合）。来源：[Queues Delivery Guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/) |
| 隧道 | Cloudflare Tunnel（cloudflared 常驻进程）：零入站端口、免域名免证书、IP 可变。代价：服务器多跑一个进程。 |
| 服务器侧 API | 挂进积分插件进程（假设：插件可起常驻 HTTP 服务）；退路：独立小服务共读 SQLite（需 WAL 模式 + busy_timeout，且只保留一个写入口）。 |
| 鉴权 | HMAC-SHA256 请求签名（两边共享密钥）+ 时间窗防重放；TLS 由隧道提供。代价：两边要配置同一密钥。 |

## 二、积分同步机制（含完整失败路径）

### 原则

1. **余额真源只在 AstrBot**；竞猜库不存余额，只存「应发凭证」和「流水镜像」。
2. 每笔资金操作有全局唯一 payout_id；插件侧同步流水表对 payout_id 建唯一索引 = **防重发的最终防线**（即使竞猜侧状态机全错，也不会重发一分）。
3. API 按「加/扣」对称设计，P0 只启用加（免费猜）；未来门票类玩法直接复用。

### 给插件设计的同步 API

```
POST /sync/credit
  body : { payout_id, qq_id, amount(>0), type: reward|reversal, event_id, ts }
  headers: X-Timestamp, X-Sign = HMAC-SHA256(secret, method+path+ts+body)
  插件处理：验签 + 时间窗校验（±5 分钟）
            → SQLite 事务：INSERT OR IGNORE 同步流水表（payout_id 唯一）
              · 新插入 → 更新积分表加分
              · 已存在 → 直接返回上次结果（幂等）
  响应 : { result: "credited" | "duplicate", balance }

POST /sync/debit    （P2 启用，与 credit 同构；防超扣靠
                      「UPDATE ... SET balance=balance-? WHERE id=? AND balance>=?」
                      的条件更新，单条 SQL 原子完成）

GET  /sync/summary?date=   （按人汇总，对账用）
```

- 幂等靠 payout_id；防伪造靠 HMAC 签名；防重放靠时间窗；防窃听靠隧道 TLS。

### 发奖主流程（正常路径）

结算确认 → D1 `batch()` 原子写入：发放批次 + 每人一条发放项（pending，带 payout_id）+ 流水镜像 → 逐条调 `/sync/credit`，成功置 credited → 批次置已发奖 → 生成战报（待发）。

### 失败路径（逐条）

| 编号 | 场景 | 处理 |
|------|------|------|
| F1 | 调用超时 | 每次调用包 10 秒中止信号（AbortSignal）；超时状态记「未知」而非「失败」——钱可能已到账；用**同一个 payout_id** 重试，插件幂等兜底，绝不重发 |
| F2 | 需要重试 | 同步日志记录每次尝试（状态码/错误/次数）；指数退避（1/5/15/60 分钟）；cron 每 5 分钟扫描 pending/未知，最多 5 次，同一次扫描顺带投递到期的截止提醒；超限转人工对账台标红 |
| F3 | 服务器不可达（隧道断/服务器挂） | 批次整体停在 pending 并告警；恢复后 cron 自动续发，不丢不重 |
| F4 | 发错奖 | 发奖前 → 改比分重算（未发奖，零成本）；发奖后 → 冲正：对已入账的发放项生成反向流水（type=reversal）走同一 credit 接口，两边流水对称、全程留痕 |
| F5 | 每日对账 | 竞猜侧汇总流水镜像（应收）vs `GET /sync/summary`（实发），按人比对；差异自动生成补发单（差为正）或冲正单（差为负），人工确认执行 |

### 原任务书「防超扣 / 防重复扣」的对应回答

免费猜模式没有扣分，不存在超扣面；「防重复扣」等价于**防重复发**：payout_id 唯一索引 + 幂等响应 + 同键重试；「防漏发」：cron 重试 + 每日对账 + 差异修账。未来门票玩法上线时，扣分走对称的 debit 接口，防超扣由插件侧条件更新（余额不足即拒绝）保证。

## 三、数据模型草图（同步边界）

### 竞猜库（D1）——业务与凭证

| 表 | 关键字段 | 说明 |
|----|----------|------|
| user_binding | id, 赛事系统账号id, **qq_id(唯一)**, 状态, 时间 | Web 账号 ↔ QQ 映射 |
| event（竞猜） | id, 标题, 状态(草稿/开放/截止/已结算/已发奖/归档), 发起人, 截止时间, 单场奖励上限, **reminded_at(截止提醒已入队的时刻)** | 玩法形式（纯猜胜负/标准）不落库，由 play_item 派生：玩法项全部都是「猜胜负」即纯猜胜负局 |
| match（场次） | id, event_id, 主队, 客队, 开赛时间, 状态 | 属于某场竞猜 |
| play_item（玩法项） | id, **event_id**, match_id(跨场次项为空), 类型(比分/胜平负/趣味/猜胜负；goals 仅兼容历史数据), 题目, 默认档位, 覆盖档位, 奖励上限 | 单场项挂 match_id；跨场次「猜胜负」只挂 event_id，故查询统一用 `i.event_id = ?`。纯猜胜负局只有这一个跨场次项、没有单场项；标准形式 1~3 场，纯猜胜负 2~10 场 |
| prediction（预测） | id, 玩法项id, 用户id, 答案内容, 提交/修改时间; **唯一(玩法项,用户)** | 防一人多份 |
| settlement（结算） | id, event_id, 实际比分, 各玩法判定明细, 计算时间, 确认人 | |
| payout_batch（发放批次） | id, event_id, 状态, 总额 | |
| payout_item（发放项） | id, 批次id, 用户id, 金额, 明细, **payout_id(全局唯一/幂等键)**, 状态(待发/已发/失败/已冲正/重试耗尽), retry_count, next_retry_at, last_error, **claim_at(派发认领锁)** | |
| sync_log（同步日志） | payout_id, 请求摘要, 响应, 错误, 重试次数, 下次重试时间 | |
| ledger_mirror（流水镜像） | id, payout_id, qq_id, 金额(正/负), 类型(奖励/冲正, 预留押金/退款), event_id | 竞猜侧账本，对账本地依据 |
| report（战报/群通知） | id(唯一), event_id, 内容, **kind(报告/开放通知/截止提醒，默认「报告」)**, 状态(待发/已发) | 三类内容共用一个队列：战报与群通知都是可直接发群的纯文本，插件不必分支处理 |
| recon_run（对账记录） | id, 时间, 应收, 实发, 差异明细, 状态 | |

### AstrBot 插件库（SQLite）——余额与资金真源

| 表 | 关键字段 | 说明 |
|----|----------|------|
| 现有积分表 | （不动） | 余额真源 |
| sync_ledger（新增） | id, **payout_id(唯一索引)**, qq_id, 金额(正/负), 来源=竞猜, event_id, 操作后余额, 时间 | 防重 + 对账凭据 |

### 同步边界

- **插件侧**：积分余额、资金真账（sync_ledger）。
- **竞猜库**：业务数据、应发凭证（payout_item）、流水镜像（ledger_mirror）。
- **流动通道只有两组接口**：资金（credit / debit / summary）与群通知（pending / ack，含战报）。每笔资金操作由 payout_id 贯穿两边。

### 生命周期每步数据变化

| 步骤 | 数据变化 |
|------|----------|
| 开盘 | 写 event + match + play_item，event 置「开放」；向 report 队列投一条「开放通知」（kind=open） |
| 提交预测 | upsert prediction（唯一约束防多份） |
| 封盘 | event 置「截止」（截止时间自动 + 手动提前），prediction 锁定 |
| 截止前 4 小时 | cron 每 5 分钟扫一次，命中后原子写 event.reminded_at 并向 report 投一条提醒（kind=remind）；每场竞猜最多一条 |
| 结算 | 写 settlement（判定明细），event 置「已结算」 |
| 发奖 | batch 原子写 payout_batch + payout_item + ledger_mirror → 逐条 credited → 批次「已发奖」→ report 置「待发」 |
| 冲正 | 新增反向 payout_item + 镜像（type=reversal），原项标「已冲正」 |
| 对账 | 写 recon_run |

### 发奖防重的三层保险

1. **一笔竞猜一个批次**：`payout_batch.event_id` 唯一。重复确认（双击、并发、确认后重来）不再报错——先查既有批次，命中就直接返回 `alreadyConfirmed` 并补一次派发；INSERT 撞唯一约束也走同一分支。
2. **一笔发放一个幂等键**：`payout_item.payout_id` 全局唯一，插件侧按此去重并回 `duplicate`，网站把 duplicate 视同到账。
3. **派发认领锁**：`payout_item.claim_at`。确认发奖、手动重试、cron 三条路径可能同时扫到同一批待发项，派发前先原子抢锁（`UPDATE payout_item SET claim_at=? WHERE id=? AND status='pending' AND (claim_at IS NULL OR claim_at < ?)`），`meta.changes` 不为 1 就跳过；落库时释放。锁超过 5 分钟视为上一轮进程已死，可被重新认领。

## 四、身份打通（已实现，2026-09-08）

> **⚠ 本节已被统一认证迁移取代（2026-09 起，增量 9 系列）**：账号真源已从赛事系统 `whl` 库 `user` 表搬到 auth 认证中心；竞猜站不再自带注册/登录（OIDC 模式下 302 移交认证中心，兼容模式返回 410），赛事库 `user` 表退化为镜像。QQ 绑定真源也搬到 auth 的 `identity` 表（本地 `user_binding` 在 OIDC 下停写停读）。下文保留 2026-09-08 当时的方案原貌，当前口径见 README「账号体系（统一认证：真源在 auth）」。

- **共享账号池（2026-09-08 起，替代早期「仅 cookie 互通」方案）**：账号真源 = 赛事系统 D1 `whl` 库 `user` 表。竞猜站自带注册/登录（`POST /api/register` / `POST /api/login`），直接读写赛事库；密码哈希为赛事兼容格式（`src/_lib/tourcrypto.ts` ↔ 赛事系统 `worker/lib/crypto.ts`，`pbkdf2$iter$salt_b64$hash_b64` 单串）——任一站注册/改密的账号全系列站点通用。注册门槛复用赛事系统：注册码（`signup_code` 表，原子核销）或组织 `allow_open_reg` 开关（无码注册 = locked 观众号）；竞猜站注册的角色只会是 coach，绝不产出 admin。改密 `POST /api/password` 写回赛事库并清 `must_change_pw`。
- **自动登录（附加通道）**：竞猜跨项目绑定赛事系统的 KV（会话真源 `sess:<token>`）与 D1 `whl` 库，收到请求读 `whl_session` cookie → KV 取 userId → 查 user 表 → 镜像进本库 `users`（`tour_id` 唯一键，upsert）。赛事系统仅需把 cookie 的 Domain 设为主域根（`COOKIE_DOMAIN` secret = `.whleague.win`，可选；不设则 host-only）。
- **角色映射**：赛事 `admin/superadmin` → 竞猜 `admin`；`coach`（含 locked=1 的观众号）→ 竞猜 `user`（locked 是「未解锁绑队」的观众，放行）；`must_change_pw=1` 的账号允许登录，但除「查自己/改密码」以外的接口一律 403（`password_change_required`），前端强制跳到站内改密页（`POST /api/password` 写回赛事库并清标记），不再要求绕到赛事系统改。发起人不进角色体系，用本库 `initiators` 名单表，管理员在后台勾选。
- **注册/登录限流**：KV 固定窗口（与赛事系统同款）：注册 IP 5 次/时；登录 IP 10 次/15 分 + 账号 5 次/15 分。
- 本地 `users.password_salt/password_hash` 列保留但不再使用（镜像行填空串）；旧自建账号（boss 等）已弃用。
- **QQ 认证前置**：提交预测必须已绑定 QQ（`PUT /predictions` 无 `user_binding` 行返回 403 `need_binding`，前端跳绑定页）；观众（locked coach）与 coach 同权可猜。
- **QQ 映射**：网页点「获取绑定码」→ 生成一次性码（10 分钟有效）→ 用户在群里向 bot 发「绑定 123456」→ 插件**出站**调竞猜 `POST /api/bind/claim {code, qq_id}` 完成映射。出站方向在国内最稳，竞猜侧无需额外暴露端口。
- `user_binding.qq_id` 唯一 → 一个 QQ 号只能绑一个账号，天然防多号。

## 五、规模与容量

≤30 人、1~2 场并行：CF 免费档余量充足（具体额度以官方定价页为准，未逐一核实，**假设：免费档够用**）。发奖为异步批量，跨境延迟不影响用户体验。

## 六、假设清单汇总

1. 假设：积分插件可常驻挂 HTTP 服务（Q1 标注未知）；退路：独立小服务共读 SQLite（WAL + 单写入口）。
2. 假设：与赛事系统同主域共享登录态可行。
3. 假设：服务器到 Cloudflare Tunnel 出站连通性良好（国内网络需实测一次）。
4. 假设：趣味题人工判定；比分命中多档取最高档（PRD 开放问题）。跨场次「猜胜负」按命中场数算分，两种模式二选一：`tiered` 按命中场数分档（档位键 hit1..hitN，N = 本局场次数），`per_hit` 为每命中一场固定分 × 命中场数。tiered 的某一档留空或填 0 表示不设该档，判分从命中场数往前找第一个有分的档（例：10 场只配 hit3=300、hit5=500，则中 4 场得 300、中 6 场得 500），至少要配一档。
5. 假设：CF 免费档额度足够当前规模。

## 七、调研来源

- [Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)：外部请求上限 50/免费档、单请求无官方超时（需自行用中止信号）、cron 15 分钟、CPU 10ms（免费档，I/O 等待不计）。
- [D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)：batch 是原子 SQL 事务、顺序执行、失败全回滚。
- [Queues Delivery Guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)：至少一次送达、官方建议幂等键做主键。
- [KV 工作原理](https://developers.cloudflare.com/kv/concepts/how-kv-works/)：最终一致，禁存余额类数据。
- 奖池分成机制（P2 玩法备用）：[Wikipedia: Parimutuel betting](https://en.wikipedia.org/wiki/Parimutuel_betting)、[Equine Edge](https://equinedge.com/glossary/betting-basics/parimutuel-betting)、[Harry Crane 预测市场通讯](https://harrycrane.substack.com/p/how-parimutuel-pools-work)。
- [AstrBot GitHub](https://github.com/AstrBotDevs/AstrBot/blob/master/README_zh.md)、[AstrBot 文档](https://docs.astrbot.app/README.html)：Python 异步插件框架。
