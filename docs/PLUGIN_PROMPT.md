# AstrBot 插件侧开发任务书（可直接交给 Agent 执行）

> 把本文件整份贴给编码 Agent 即可作为完整工作指令。契约细节以 [astrbot-sync-api.md](./astrbot-sync-api.md) 为准，本文件是任务框架与验收标准。
>
> 产出物：AstrBot 积分插件旁的一个新插件（或原插件内新增模块），实现「竞猜系统 ↔ 积分真源」的同步通道。

---

## 一、给 Agent 的任务提示词（复制以下全部内容）

```markdown
# 任务：为 WHL 竞猜系统实现 AstrBot 同步插件

## 角色
你是资深 Python 后端开发，熟悉 AstrBot 插件框架（异步、事件驱动）与 aiohttp。
你要为一个已有的 AstrBot 积分插件补上「HTTP 同步通道」，让它成为竞猜系统的积分真源。

## 背景（务必理解后再动手）
- 竞猜系统跑在 Cloudflare Worker（https://guess.whleague.win），群友在网页上竞猜足球比分，
  命中后由竞猜系统把积分「发放指令」推送给本插件，插件在本地 SQLite 里真正加/扣积分。
- **余额真源只在 AstrBot 侧**；竞猜系统只存凭证与流水镜像。因此幂等性是生命线：
  同一笔发放（payout_id 唯一）无论收到多少次，只允许入账一次。
- 通信双向都有 HMAC-SHA256 签名（±300 秒时间窗），算法与报文格式见
  `docs/astrbot-sync-api.md`（必读，含 Python 参考实现，核心逻辑可直接抄）。
- 服务端的期望行为可用 `scripts/mock-plugin.js`（Node）对照理解：它实现了同样的两个端点。

## 需要实现的功能（五块）

### 1. HTTP 服务（服务器被竞猜系统调用）
- `POST /sync/credit`：单笔发放。验签 → 校验 body → 按 payout_id 幂等入账 → 返回
  `{ok:true, duplicate:false, balance:<入账后余额>}`；重复单返回 `duplicate:true` 且**不再入账**。
  - amount 为正数=发奖（type=reward），负数=冲正（type=reversal，扣回）。
  - 入账失败（用户不存在/余额不足扣不了）返回 4xx/5xx，让竞猜系统按 failed 处理。
- `GET /sync/summary?date=YYYY-MM-DD`：对账取数。验签 → 返回该日期（东八区）成功入账的
  按 QQ 汇总 `{date, items:[{qq_id, total}]}`（冲正负数计入净额）。
- 监听 127.0.0.1:9991 即可（对外由 Cloudflare Tunnel 暴露）；所有端点先验签，失败一律 401。

### 2. 本地幂等账本
- SQLite 表 `sync_ledger`：`payout_id TEXT PRIMARY KEY, qq_id TEXT, amount INTEGER,
  type TEXT, event_id INTEGER, credited_at TEXT`（UTC）。
- 入账与写账本放在同一事务；积分扣加与积分插件的既有表对接（见第 4 块）。

### 3. QQ 绑定指令（群内交互）
- 用户在竞猜网页生成一次性绑定码（10 分钟有效），到 QQ 群里对 bot 发「绑定 123456」。
- 插件收到后调竞猜系统 `POST /api/bind/claim {code, qq_id}`（按契约签名），
  成功后群里回复「绑定成功：QQ xxx ↔ 昵称」；失败回复原因（无效/过期）。
- qq_id 取消息发送者的 QQ 号。

### 4. 与既有积分插件对接（关键集成点）
- 在现有积分插件的代码里找到「加积分 / 扣积分 / 查余额」的函数或表结构，复用它们，
  不要另立一套余额表。若只能直写表，必须与原插件加锁方式一致（WAL + 同一写入口）。
- `/sync/credit` 的 balance 字段从该处查询。

### 5. 待发内容轮询（后台任务）
- 每 60 秒调竞猜系统 `GET /api/reports/pending`（最多 5 条/次），
  把 `content` 原样发到配置指定的 QQ 群；**确认群消息发送成功后**才调
  `POST /api/reports/ack {ids:[...]}`。发送失败不 ack，下次还会拉到。
- 队列里混有三类内容，用 `kind` 区分：`report`（竞猜战报）、`open`（新竞猜开放通知）、
  `remind`（截止前 4 小时提醒）。三类都是可直接发群的纯文本、行数只有两三行，
  **按同一条路径发送即可，不必分支处理**。
- 目标群号放进插件配置（AstrBot 的 _conf_schema.json），不要硬编码。

## AstrBot 接入要求
- 按当前项目实际使用的 AstrBot 版本的插件规范实现（Star 子类 + register 装饰器 +
  filter.command 指令注册 + initialize 生命周期里用 asyncio.create_task 启动 aiohttp
  服务与轮询循环，terminate 时优雅退出）。若框架 API 与上述假设有出入，以本地 AstrBot
  源码/文档为准，保持「指令可触发、后台任务不阻塞消息循环」即可。
- 配置项：竞猜系统 BASE 地址、SYNC_SECRET、战报目标群、监听端口。
- 日志：每笔 credit（含 duplicate）与每次战报发送/ack 都打日志，便于与竞猜侧排障对照。

## 安全红线
- SECRET 不进 git、不打日志。
- 任何端点不得绕过验签；除 127.0.0.1 外不建议直接暴露（交给 Tunnel + 验签双重防护）。
- 余额只在积分插件既有存储里；sync_ledger 只存流水凭证，不存余额。

## 验收标准（逐条自测并在交付说明里给出结果）
1. 用契约里的签名算法构造合法请求 → 200；篡改 body 或签名 → 401；时间戳偏差 >300s → 401。
2. 同一 payout_id 连发两次 → 第一次 duplicate:false 且余额增加，第二次 duplicate:true 余额不变。
3. amount 为负的 reversal → 余额减少且 summary 净额正确。
4. 「绑定 123456」在群里可触发 claim；过期码返回用户可读的失败提示。
5. 战报：先发群成功、后 ack；人为让发送失败（如目标群不可用）时不 ack、下轮重拉。
6. 断网模拟：竞猜侧 dispatch 时插件不可达会进重试队列（1/5/15/60 分钟，共 5 次）——
   插件恢复后无需任何人工操作，重试自动到账（这是服务器侧行为，插件只需保证幂等）。
7. 联调：本地 `npm run dev`（8789，已带 `--var AUTH_MODE:compat`）+ `.dev.vars` 指向插件端口，
   跑 `scripts/smoke-test.sh` 18 步全过（credited 路径；要跑到「并发确认发奖」那步的幂等断言，
   需把插件 stdout 重定向到文件并用 `MOCK_LOG=` 指过去，脚本靠它数每笔 payout 只提交一次）。

## 交付物
- 插件目录（含 main.py、_conf_schema.json、sync 模块、README：配置方法与联调步骤）
- 一段自测记录（验收清单逐条结果）
```

---

## 二、给部署人（你）的补充说明

- **先决事实核对**：Agent 动手前需要两样东西——竞猜系统正式地址（`https://guess.whleague.win`）与 `SYNC_SECRET`（本机 `WHL-Daily-Activities-System/.prod-secrets.txt` 里的 `SYNC_SECRET=` 那行）。插件配好后跑 `npx wrangler secret put SYNC_BASE_URL` 填 `https://astrbot.whleague.win`（Tunnel 域名，见 DEPLOY.md 第四步）。
- **本地联调顺序**：`.dev.vars` 里 `SYNC_BASE_URL=http://127.0.0.1:9991` → 起插件（9991）→ `npm run dev`（8789）→ `bash scripts/smoke-test.sh`。全绿再上服务器。（插件 stdout 建议重定向到文件，冒烟步 12 的幂等断言靠 `MOCK_LOG=` 读它；反复跑冒烟前先 `bash scripts/reset-local.sh` 复位本地数据。）
- **上线检查**：Tunnel 存活（DEPLOY.md 4.1 的 401 验证）→ 服务器 secret 改真地址 → 管理台建一场真实竞猜走完整闭环。
