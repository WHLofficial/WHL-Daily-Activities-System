# 从零部署指南 · WHL 竞猜系统

> 目标读者：部署人本人。按顺序执行，每步都有 ✅ 验证点。全程约 20 分钟（不含插件开发）。
>
> 最终形态（纯 Worker，与赛事系统同构）：
>
> | 组件 | 地址 | 说明 |
> |---|---|---|
> | 赛事系统 | `whleague.win`（已部署） | 登录真源，cookie 发给全主域 |
> | 竞猜系统 | `guess.whleague.win` | 单个 Worker：静态资源 + API + 内置 cron |
> | AstrBot 插件 | 腾讯云服务器 | 积分真源，经 Cloudflare Tunnel 暴露 |
>
> 前置条件：Cloudflare 账号（`whleague.win` 托管其中）、Node.js ≥ 18、本仓库代码。

---

## 一、准备

```bash
cd WHL-Daily-Activities-System
npm install                # 安装 wrangler 等依赖
npx wrangler login         # 浏览器授权 Cloudflare 账号
npx wrangler whoami        # ✅ 应显示你的账号
```

---

## 二、创建业务库（D1，亚太区）

```bash
npx wrangler d1 create whl-guess --location apac
```

> `--location apac` 很重要：业务库和用户都在亚太；不指定会默认落在北美，每次查询多一个跨洋往返。

把输出的 `database_id` 填进 `wrangler.jsonc` 的 `DB` binding（`TOUR_DB`/`SESSION_KV` 是赛事系统的资源，勿动），然后建表：

```bash
npx wrangler d1 migrations apply whl-guess --remote
```

✅ 验证：输出显示 `0001_init.sql` 和 `0002_tour_auth.sql` 均应用成功。

---

## 三、部署 Worker + 绑定正式域名

```bash
npx wrangler deploy
```

`wrangler.jsonc` 里已声明 `"routes": [{ "pattern": "guess.whleague.win", "custom_domain": true }]`——deploy 时自动开通该域名的 DNS 与证书（zone 必须在同账号）。首次签发证书需要几分钟。

✅ 验证：`curl https://guess.whleague.win/api/me` 返回 `{"user":null}`（HTTP 200）。

> ⚠️ 不要用 `*.workers.dev` 域名做生产入口——大陆访问普遍不通（DNS 污染），这就是必须绑自定义域的原因。

### 配置 secrets

```bash
npx wrangler secret put SYNC_SECRET     # 与插件共享的 HMAC 密钥，填长随机串
npx wrangler secret put CRON_SECRET     # 内部接口密钥（手动触发重试/对账用）
npx wrangler secret put SETUP_TOKEN     # 首次初始化管理员用，第六步之后删除
npx wrangler secret put SYNC_BASE_URL   # 插件公网地址，第五步完成前可先填 http://127.0.0.1:9
```

cron（每 5 分钟重试 + 每日 09:00 对账）已内置在 Worker 里，**没有独立 cron 服务要部署**。

---

## 四、插件侧（腾讯云 AstrBot 服务器）

### 4.1 暴露插件 HTTP 入口（Cloudflare Tunnel）

```bash
# 服务器上安装 cloudflared 后（已登录 CF 账号）：
cloudflared tunnel create astrbot
cloudflared tunnel route dns astrbot astrbot.whleague.win
cloudflared tunnel run --url http://127.0.0.1:9991 astrbot     # 9991 = 插件 HTTP 端口
# 稳定运行建议注册成系统服务：cloudflared service install
```

✅ 验证：本机 `curl https://astrbot.whleague.win/sync/summary` 返回 401（`{"error":"bad sign"}`）——说明入口通了且验签生效。

### 4.2 实现插件同步 API

按 [astrbot-sync-api.md](./astrbot-sync-api.md) 实现（有 Python 参考实现可抄）：

- 服务器 → 插件：`POST /sync/credit`（**必须按 `payout_id` 去重**）、`GET /sync/summary?date=`
- 插件 → 服务器：轮询 `POST /api/bind/claim`（QQ 绑定）、`GET /api/reports/pending` + `POST /api/reports/ack`（战报）

完成后回竞猜系统改真地址：

```bash
npx wrangler secret put SYNC_BASE_URL    # 填 https://astrbot.whleague.win
```

✅ 验证：第六步发奖后积分真到账，即为通。

---

## 五、首次初始化

### 5.1 创建管理员

```bash
curl -X POST "https://guess.whleague.win/api/setup" \
  -H "Content-Type: application/json" \
  -d '{"setupToken":"<你的SETUP_TOKEN>","username":"boss","password":"<管理密码>","displayName":"boss"}'
```

⚠️ **初始化完成后立刻删掉入口**（重要）：

```bash
npx wrangler secret delete SETUP_TOKEN
```

### 5.2 共享登录打通检查

1. 服务器上给赛事系统配 cookie 域（让 cookie 跨子域）：
   ```bash
   cd WHL-tournament-management-system
   npx wrangler secret put COOKIE_DOMAIN      # 填 .whleague.win
   ```
2. 浏览器登录 `whleague.win`（赛事系统），然后新标签打开 `guess.whleague.win`。
3. ✅ 验证：竞猜页右上角直接显示赛事系统的昵称（无需再登录）。
   - 若显示未登录：检查 COOKIE_DOMAIN 是否已配、竞猜是否走 `guess.` 子域、浏览器是否有 `whleague.win` 域下的 `whl_session` cookie。

### 5.3 管理台配置

`guess.whleague.win/admin.html` 登录管理员，依次确认：

- **发起人名单**：把可以开期的管理员/群友勾成发起人（名单外的人看不到管理功能）；
- **默认档位**（比分 300 / 胜平负 50 / 总进球 100 / 趣味 50）与单场上限，可按需调整。

> 说明：管理员身份来自赛事系统的 `admin/superadmin`；「本站登录」的自建账号仅用于本地开发联调，线上不用管。

---

## 六、首次实战验收

1. 发起人建一期竞猜（标题/截止/比赛/玩法项），状态改为开放；
2. 群友在赛事系统登录 → 竞猜页**绑定 QQ**（网页生成绑定码 → QQ 群里向 bot 发码）→ 提交预测（未绑定的账号此时会被 403 拦下并引导去绑定，属预期）；
3. 截止 → 录比分 → 结算预览（核对每人金额与上限）→ 确认发奖；
4. ✅ 插件日志出现 `credit payout_id=po-… amount=…`，群里收到战报，`/api/admin/batches/<id>` 显示 `paid`；
5. 次日 09:00 后：管理台「对账」页应显示 `ok`（或手动 `curl -X POST "https://guess.whleague.win/api/internal/recon" -H "X-Cron-Key: <CRON>"` 立即跑一次）。

---

## 七、日常运维

| 场景 | 现象 | 处理 |
|---|---|---|
| 发奖 unknown | 批次页 `retry_count` 增长、`next_retry_at` 在未来 | Tunnel/插件恢复后自动重试（1/5/15/60 分钟退避，共 5 次）；急事在批次页点「重试」 |
| 发奖 failed | 5 次退避后仍失败 | 看插件日志定位（多为积分不足/接口 500）；处理后「重试」，或「冲正」生成反向流水 |
| 对账 diff | 对账页出现差值明细 | 核对插件侧流水 → 管理台冲正/补发，差异当天清零 |
| 对账 error | 插件 summary 不可达 | 查 Tunnel 是否存活，恢复后次日自动再对 |

---

## 八、故障排查

- **`wrangler d1 create` 提示未登录** → `npx wrangler login` 重走授权。
- **线上 500** → `npx wrangler secret list` 确认四个 secret 都在；本地 `.dev.vars` 只影响本地。
- **发奖全 unknown 但插件正常** → `SYNC_BASE_URL` 是否漏改/多写了尾斜杠；`SYNC_SECRET` 两端是否一致。
- **战报不发** → 插件是否在轮询 `pending` 且发送成功后才 `ack`；管理台「战报」可查积压。
- **共享登录失效** → 按 5.2 的三点排查（COOKIE_DOMAIN / 子域 / cookie 存在性）。
- **`wrangler d1 delete` 报错找不到库** → 该命令按 wrangler.jsonc 里的 `database_id` 解析，先把对应 id 填进配置再按名删除。
