# 技术方案 · WHL 竞猜系统

- 版本：v0.1（收敛初稿，已确认落盘）
- 日期：2026-09-06
- 状态：开发中（MVP 代码已全部落盘）
- 进度（2026-09-08）：MVP 已实现并通过本地端到端冒烟测试；线上部署与真实插件联调待做
- 配套文档：[PRD.md](./PRD.md)

## 结论先行

- **部署**：CF Pages（前端）+ Pages Functions（后端 API）+ D1（竞猜业务库）；AstrBot 积分插件加同步 API，经 Cloudflare Tunnel 暴露 HTTPS；战报由插件**出站轮询拉取**。
- **同步**：余额真源只在 AstrBot；竞猜库只存「应发凭证 + 流水镜像」；每笔资金操作带全局唯一单号（payout_id），插件侧用唯一索引做**防重发最终防线**；Workers 超时重试 + 每日对账兜底。

## 一、部署架构

```
群友手机浏览器
   │
CF Pages（静态前端）──CF Pages Functions（API）──D1（竞猜库）
                              │ ① 发奖 HTTPS + HMAC 签名（经 Cloudflare Tunnel）
                              ▼
        云服务器（国内，仅 IP）：AstrBot + 积分插件（同步 API + 同步流水表）
                              │ ② 拉战报（出站轮询，每分钟）
                              ▼
                    Pages Functions /reports/pending
```

- **① 发奖方向**：cloudflared 在服务器上**主动**连 Cloudflare 建隧道（Cloudflare Tunnel），服务器不开任何入站端口、不需要域名和证书、换 IP 不影响；Workers 直接调隧道地址。远期迁香港零改动。
- **② 战报方向**：国内入站不稳、出站稳，所以战报由插件**主动来拉**，而不是竞猜侧去推。竞猜侧零暴露。

### 技术选型（两句式）

| 选型 | 用什么 + 为什么 + 代价 |
|------|------|
| 前端 | CF Pages + 轻量框架（Vue/React 均可）：移动优先静态站，和后端同仓库。代价：无 SEO（群内分享场景无所谓）。 |
| 后端 | Pages Functions（即 Workers）：和前端同域同仓库，免运维。代价：每次调用外部请求上限 50 个（免费档）、定时任务 CPU 仅 10 毫秒（纯等网络不计 CPU，够用）。来源：[Workers Limits](https://developers.cloudflare.com/workers/platform/limits/) |
| 数据库 | D1（CF 家的云端 SQLite）：`batch()` 打包的语句是原子事务、全成或全回滚（官方保证）。代价：不支持「语句中间夹应用逻辑」的交互式事务，用 batch 打包规避。来源：[D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/) |
| 不用 KV 存资金数据 | KV 是最终一致的全球缓存（写入后其他节点最长约 60 秒才可见），只能放缓存类数据，余额/凭证一律 D1。来源：[KV 工作原理](https://developers.cloudflare.com/kv/concepts/how-kv-works/) |
| 重试通道 | P0 用定时任务（cron 每 5 分钟）扫描重试，≤30 人规模足够；P2 升级 Cloudflare Queues（至少一次送达，官方建议幂等键做主键，与本设计天然契合）。来源：[Queues Delivery Guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/) |
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
| F2 | 需要重试 | 同步日志记录每次尝试（状态码/错误/次数）；指数退避（1/5/15/60 分钟）；cron 每 5 分钟扫描 pending/未知，最多 5 次；超限转人工对账台标红 |
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
| event（竞猜期） | id, 标题, 状态(草稿/开放/截止/已结算/已发奖/归档), 发起人, 截止时间, 单场奖励上限 | |
| match（场次） | id, event_id, 主队, 客队, 开赛时间, 状态 | 属于某个竞猜期 |
| play_item（玩法项） | id, match_id, 类型(比分/胜平负/总进球/趣味), 题目, 默认档位, 覆盖档位, 奖励上限 | 一场比赛多个玩法项 |
| prediction（预测） | id, 玩法项id, 用户id, 答案内容, 提交/修改时间; **唯一(玩法项,用户)** | 防一人多份 |
| settlement（结算） | id, event_id, 实际比分, 各玩法判定明细, 计算时间, 确认人 | |
| payout_batch（发放批次） | id, event_id, 状态, 总额 | |
| payout_item（发放项） | id, 批次id, 用户id, 金额, 明细, **payout_id(全局唯一/幂等键)**, 状态(待发/已发/重复/失败/已冲正) | |
| sync_log（同步日志） | payout_id, 请求摘要, 响应, 错误, 重试次数, 下次重试时间 | |
| ledger_mirror（流水镜像） | id, payout_id, qq_id, 金额(正/负), 类型(奖励/冲正, 预留押金/退款), event_id | 竞猜侧账本，对账本地依据 |
| report（战报） | id(唯一), event_id, 内容, 状态(待发/已发) | |
| recon_run（对账记录） | id, 时间, 应收, 实发, 差异明细, 状态 | |

### AstrBot 插件库（SQLite）——余额与资金真源

| 表 | 关键字段 | 说明 |
|----|----------|------|
| 现有积分表 | （不动） | 余额真源 |
| sync_ledger（新增） | id, **payout_id(唯一索引)**, qq_id, 金额(正/负), 来源=竞猜, event_id, 操作后余额, 时间 | 防重 + 对账凭据 |

### 同步边界

- **插件侧**：积分余额、资金真账（sync_ledger）。
- **竞猜库**：业务数据、应发凭证（payout_item）、流水镜像（ledger_mirror）。
- **流动通道只有两组接口**：资金（credit / debit / summary）与战报（pending / ack）。每笔资金操作由 payout_id 贯穿两边。

### 生命周期每步数据变化

| 步骤 | 数据变化 |
|------|----------|
| 开盘 | 写 event + match + play_item，event 置「开放」 |
| 提交预测 | upsert prediction（唯一约束防多份） |
| 封盘 | event 置「截止」（截止时间自动 + 手动提前），prediction 锁定 |
| 结算 | 写 settlement（判定明细），event 置「已结算」 |
| 发奖 | batch 原子写 payout_batch + payout_item + ledger_mirror → 逐条 credited → 批次「已发奖」→ report 置「待发」 |
| 冲正 | 新增反向 payout_item + 镜像（type=reversal），原项标「已冲正」 |
| 对账 | 写 recon_run |

## 四、身份打通

- **登录**：竞猜部署在赛事系统**同主域**（子路径或子域），共享登录 cookie，不重做注册登录。假设：赛事系统已有会话机制且主域一致；退路：竞猜自建会话。
- **QQ 映射**：网页点「获取绑定码」→ 生成一次性码（10 分钟有效）→ 用户在群里向 bot 发「绑定 123456」→ 插件**出站**调竞猜 `POST /bind {code, qq_id}` 完成映射。出站方向在国内最稳，竞猜侧无需额外暴露端口。
- `user_binding.qq_id` 唯一 → 一个 QQ 号只能绑一个账号，天然防多号。

## 五、规模与容量

≤30 人、1~2 场并行：CF 免费档余量充足（具体额度以官方定价页为准，未逐一核实，**假设：免费档够用**）。发奖为异步批量，跨境延迟不影响用户体验。

## 六、假设清单汇总

1. 假设：积分插件可常驻挂 HTTP 服务（Q1 标注未知）；退路：独立小服务共读 SQLite（WAL + 单写入口）。
2. 假设：与赛事系统同主域共享登录态可行。
3. 假设：服务器到 Cloudflare Tunnel 出站连通性良好（国内网络需实测一次）。
4. 假设：趣味题人工判定；比分命中多档取最高档（PRD 开放问题）。
5. 假设：CF 免费档额度足够当前规模。

## 七、调研来源

- [Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)：外部请求上限 50/免费档、单请求无官方超时（需自行用中止信号）、cron 15 分钟、CPU 10ms（免费档，I/O 等待不计）。
- [D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)：batch 是原子 SQL 事务、顺序执行、失败全回滚。
- [Queues Delivery Guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)：至少一次送达、官方建议幂等键做主键。
- [KV 工作原理](https://developers.cloudflare.com/kv/concepts/how-kv-works/)：最终一致，禁存余额类数据。
- 奖池分成机制（P2 玩法备用）：[Wikipedia: Parimutuel betting](https://en.wikipedia.org/wiki/Parimutuel_betting)、[Equine Edge](https://equinedge.com/glossary/betting-basics/parimutuel-betting)、[Harry Crane 预测市场通讯](https://harrycrane.substack.com/p/how-parimutuel-pools-work)。
- [AstrBot GitHub](https://github.com/AstrBotDevs/AstrBot/blob/master/README_zh.md)、[AstrBot 文档](https://docs.astrbot.app/README.html)：Python 异步插件框架。
