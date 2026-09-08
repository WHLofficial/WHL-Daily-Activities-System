# AstrBot 插件侧同步 API 契约

> 版本 v1 · 对应服务端 `functions/` 实现。积分真源在插件侧（AstrBot 积分插件），本系统只发「指令」，插件执行入账并回报。
>
> 本地联调：`SYNC_SECRET=testsecret node scripts/mock-plugin.js 9991` 起一个模拟插件。

## 0. 总览

两个方向、同一套签名算法：

```
┌──────────────┐  POST /sync/credit          ┌──────────────┐
│  竞猜系统     │  GET  /sync/summary?date=   │  AstrBot 插件 │
│ (Cloudflare) │ ───────────────────────────▶│  (腾讯云)     │
│              │ ◀───────────────────────────│              │
└──────────────┘  POST /api/bind/claim        └──────────────┘
                  GET  /api/reports/pending      ▲
                  POST /api/reports/ack          │ 定时轮询（建议 60s）
```

- **服务器 → 插件**：发奖指令 + 每日对账取数。由服务器主动发起（需插件暴露 HTTP 端口；经 Cloudflare Tunnel 穿透）。
- **插件 → 服务器**：绑定码认领 + 战报拉取。插件定时轮询，不依赖服务器入站可达。

## 1. 签名算法（两方向通用）

所有请求带两个头：

| 头 | 值 |
|---|---|
| `X-Timestamp` | Unix 秒级时间戳（10 位） |
| `X-Sign` | `hex( HMAC-SHA256( SECRET, 规范串 ) )` |

**规范串** = `HTTP方法|路径含query|时间戳|原始请求体`

- GET 的请求体为空字符串；
- `路径含query` 必须与实际请求行完全一致（含 `?date=...`，勿重复编码）；
- 时间戳容差 **±300 秒**，超窗拒绝；
- `SECRET` = 双方约定的共享密钥（服务器侧配在 `SYNC_SECRET` 环境变量）。

例（插件调服务器）：

```
POST /api/bind/claim
X-Timestamp: 1757320000
X-Sign: <hex>
Content-Type: application/json

{"code":"AB12-CD34","qq_id":"10001"}
规范串 = POST|/api/bind/claim|1757320000|{"code":"AB12-CD34","qq_id":"10001"}
```

## 2. 插件必须暴露的接口（服务器调用）

### 2.1 POST /sync/credit —— 单笔积分发放

服务器逐笔调用，**一笔一次 HTTP 调用**。请求体：

```json
{ "payout_id": "po-<uuid>", "qq_id": "10001", "amount": 530, "type": "reward", "event_id": 1, "ts": "2026-09-08T12:00:00.000Z" }
```

| 字段 | 说明 |
|---|---|
| `payout_id` | 全局唯一发放单号，**幂等键**。同号重发不得重复入账 |
| `qq_id` | 收款 QQ 号（字符串，可能带非数字风险，按字符串处理） |
| `amount` | 正数=发放；**负数=冲正**（`type:"reversal"` 时出现，扣回积分） |
| `type` | `reward` / `reversal` / `reconciliation`（对账补差，P1 预留） |
| `event_id` | 关联竞猜期 |
| `ts` | 指令产生时间（ISO 8601） |

**必须返回**（HTTP 200，签名不验或参数错返回 4xx）：

```json
{ "ok": true, "duplicate": false, "balance": 1530 }
```

- `duplicate`：该 `payout_id` 之前已入账过 → `true`（服务器视为成功，不重试）；
- `balance`：入账后该 QQ 余额（可选，服务器仅记录用于排障）；
- **失败语义**：非 2xx 响应 = 服务器认为「明确失败」会重试；**连接超时/断开 = 状态未知**，服务器同样重试。因此插件必须按 `payout_id` 去重，不能靠「没收到响应 = 没入账」的假设。

服务器侧重试策略：指数退避 `1 / 5 / 15 / 60` 分钟，**最多 5 次**，之后标记 `failed` 并在管理台可见（可手工重试或冲正）。

### 2.2 GET /sync/summary?date=YYYY-MM-DD —— 对账取数

每日 09:00（Asia/Shanghai）服务器 cron 调用。返回**该日期（按东八区）成功入账的按 QQ 汇总**：

```json
{ "date": "2026-09-08", "items": [ { "qq_id": "10001", "total": 530 }, { "qq_id": "10002", "total": 150 } ] }
```

- 只统计「实际入账成功」的流水（含冲正负数）；
- 与服务器侧镜像逐 QQ 比对，不一致写入 `recon_run`（status=`diff`），在管理台对账页可见。

## 3. 插件需要主动调用的接口

### 3.1 POST /api/bind/claim —— 绑定码认领

用户在网页登录后生成 8 位绑定码（10 分钟有效、一次性），在 QQ 群里对机器人发「绑定 AB12-CD34」，插件调用：

```json
{ "code": "AB12-CD34", "qq_id": "10001" }
```

响应：`{ "ok": true, "displayName": "小明" }`；错误：`400 {"error":"invalid_code"}`（无效/过期/已用）。

建议群内回执：「绑定成功：QQ 10001 ↔ 小明」。

### 3.2 GET /api/reports/pending —— 拉取待发战报

```json
{ "reports": [ { "id": "rp-<uuid>", "event_id": 1, "content": "🏆 竞猜战报 · 英超第3轮\n...", "created_at": "..." } ] }
```

最多 5 条/次，按时间正序。插件把 `content` 原文发到目标群。

### 3.3 POST /api/reports/ack —— 确认已发送

```json
{ "ids": ["rp-<uuid>", "..."] }
```

响应 `{ "ok": true, "acked": 2 }`。**先发群成功后再 ack**；不 ack 服务器会一直保留待发。

## 4. Python 参考实现（AstrBot 插件片段）

> 仅示意核心逻辑（签名/去重/轮询），接入 AstrBot 的注册与消息分发按其插件规范包装。

```python
import hmac, hashlib, json, time, sqlite3, requests

SECRET = "testsecret"                       # 与服务器 SYNC_SECRET 一致
BASE = "http://127.0.0.1:8788"              # 竞猜系统地址（部署后换正式域名）
LOCAL_PORT = 9991                            # 本插件 HTTP 端口（Tunnel 指向这里）

# ---------- 签名 ----------
def sign(method: str, path_with_query: str, ts: int, raw_body: str) -> str:
    canonical = f"{method}|{path_with_query}|{ts}|{raw_body}"
    return hmac.new(SECRET.encode(), canonical.encode(), hashlib.sha256).hexdigest()

def call_server(method: str, path: str, body: dict | None = None):
    raw = json.dumps(body, ensure_ascii=False) if body is not None else ""
    ts = int(time.time())
    headers = {"X-Timestamp": str(ts), "X-Sign": sign(method, path, ts, raw),
               "Content-Type": "application/json"}
    resp = requests.request(method, BASE + path, data=raw.encode(), headers=headers, timeout=10)
    resp.raise_for_status()
    return resp.json()

def verify_request(method: str, path_with_query: str, x_ts: str, x_sign: str, raw_body: bytes) -> bool:
    if abs(int(time.time()) - int(x_ts)) > 300:
        return False
    expect = hmac.new(SECRET.encode(),
                      f"{method}|{path_with_query}|{x_ts}|{raw_body.decode()}".encode(),
                      hashlib.sha256).hexdigest()
    return hmac.compare_digest(expect, x_sign or "")

# ---------- 本地幂等账本（SQLite）----------
db = sqlite3.connect("sync_ledger.db", check_same_thread=False)
db.execute("""CREATE TABLE IF NOT EXISTS sync_ledger(
    payout_id TEXT PRIMARY KEY, qq_id TEXT, amount INTEGER,
    type TEXT, event_id INTEGER, credited_at TEXT)""")

def handle_credit(raw_body: bytes, x_ts: str, x_sign: str):
    if not verify_request("POST", "/sync/credit", x_ts, x_sign, raw_body):
        return 401, {"error": "bad sign"}
    b = json.loads(raw_body)
    try:
        db.execute("INSERT INTO sync_ledger VALUES (?,?,?,?,?,datetime('now'))",
                   (b["payout_id"], b["qq_id"], b["amount"], b["type"], b.get("event_id")))
        db.commit()
        dup = False
    except sqlite3.IntegrityError:
        dup = True                                   # 同 payout_id 已入账 → 幂等返回
    # TODO: 在这里调用积分插件真正加/扣积分；失败则回滚本行并返回 500
    balance = get_balance(b["qq_id"])                # 你的积分插件余额查询
    return 200, {"ok": True, "duplicate": dup, "balance": balance}

def handle_summary(date: str, x_ts: str, x_sign: str, raw: bytes):
    if not verify_request("GET", f"/sync/summary?date={date}", x_ts, x_sign, raw):
        return 401, {"error": "bad sign"}
    rows = db.execute("""SELECT qq_id, SUM(amount) FROM sync_ledger
                         WHERE type != 'reversal' AND substr(credited_at,1,10) = ?
                         GROUP BY qq_id""", (date,)).fetchall()
    # 注意：冲正为负数流水，汇总时应一并计入净额；上查询仅示意，实际按净额实现
    return 200, {"date": date, "items": [{"qq_id": r[0], "total": r[1]} for r in rows]}

# ---------- 战报轮询（建议放后台线程，60s 一次）----------
def poll_reports():
    data = call_server("GET", "/api/reports/pending")
    ids = []
    for r in data.get("reports", []):
        if send_to_group(r["content"]):              # TODO: 接入你的发群逻辑
            ids.append(r["id"])
    if ids:
        call_server("POST", "/api/reports/ack", {"ids": ids})
```

## 5. 联调清单

1. 服务器 `.dev.vars`（本地）/ 生产环境变量：`SYNC_SECRET`、`SYNC_BASE_URL`（指向插件公网入口，本地联调 `http://127.0.0.1:9991`）；
2. 先起插件（或 mock），再在管理台走「结算 → 确认发奖」；
3. 模拟故障：把插件进程停掉再确认发奖 → 应看到 `unknown` 进入重试队列（管理台批次页可见 `retry_count`/`next_retry_at`）；恢复插件后等退避到期或手动 `POST /api/internal/retry`（头 `X-Cron-Key`）；
4. 对账：`POST /api/internal/recon?date=YYYY-MM-DD`，或等每日 09:00 cron；管理台「对账」页查 `ok/diff/error`。
