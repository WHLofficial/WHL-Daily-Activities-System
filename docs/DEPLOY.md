# 从零部署指南 · WHL 竞猜系统

> 目标读者：部署人本人。按顺序执行，每步都有 ✅ 验证点。全程约 30 分钟（不含插件开发）。
>
> 最终形态：
>
> | 组件 | 地址 | 说明 |
> |---|---|---|
> | 赛事系统 | `whleague.win`（已部署） | 登录真源，cookie 发给全主域 |
> | 竞猜系统 | `guess.whleague.win` | 本文档部署主体（Pages + D1） |
> | Cron Worker | `whl-guess-cron`（Workers） | 每 5 分钟重试 + 每日 09:00 对账 |
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

## 二、创建竞猜业务库（D1）

```bash
npx wrangler d1 create whl-guess
```

输出里有 `database_id`（形如 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`），填进 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "whl-guess"
database_id = "<替换这里>"
```

> 文件里另外两个绑定（`TOUR_DB` = 赛事系统 D1、`SESSION_KV` = 赛事系统 KV）的 id 已是真实值，不要动。

建表（远程库）：

```bash
npx wrangler d1 migrations apply whl-guess --remote
```

✅ 验证：输出显示 `0001_init.sql` 和 `0002_tour_auth.sql` 均应用成功。

---

## 三、部署竞猜系统（Pages）

```bash
npx wrangler pages deploy public
```

首次执行会询问项目名，用默认 `whl-guess`。完成后得到 `https://whl-guess.pages.dev`。

> 以后更新代码：仍执行这条命令即可（Functions 与 public/ 一起发布）。

### 配置环境变量（secrets）

```bash
npx wrangler pages secret put SYNC_SECRET     # 与插件共享的 HMAC 密钥，填长随机串
npx wrangler pages secret put CRON_SECRET     # 内部 cron 通道密钥，另存一份给第四步
npx wrangler pages secret put SETUP_TOKEN     # 首次初始化管理员用，第六步之后删除
npx wrangler pages secret put SYNC_BASE_URL   # 插件公网地址，第五步完成前可先填 http://127.0.0.1:9
```

✅ 验证：浏览器打开 `https://whl-guess.pages.dev`，能看到竞猜首页（用户端）。

### 绑定正式域名

1. Cloudflare Dashboard → Workers & Pages → `whl-guess` → Custom domains → **Add** `guess.whleague.win`。
2. 等证书签发（几分钟，同账号域名 DNS/证书全自动）。

✅ 验证：`https://guess.whleague.win` 可访问。**以下步骤全部用这个域名**（`*.pages.dev` 在大陆常被 DNS 污染）。

---

## 四、部署 Cron Worker

编辑 `cron-worker/wrangler.jsonc`，把 `APP_URL` 改为正式域名：

```jsonc
"vars": { "APP_URL": "https://guess.whleague.win" }
```

```bash
cd cron-worker
npx wrangler deploy
npx wrangler secret put CRON_SECRET    # 值与第三步一致
```

✅ 验证：

```bash
curl -X POST "https://guess.whleague.win/api/internal/retry" -H "X-Cron-Key: <你的CRON_SECRET>"
# {"total":0,...} 即通；{"error":"cron key 错误"} 说明 secret 没配对
```

---

## 五、插件侧（腾讯云 AstrBot 服务器）

### 5.1 暴露插件 HTTP 入口（Cloudflare Tunnel）

```bash
# 服务器上安装 cloudflared 后（已登录 CF 账号）：
cloudflared tunnel create astrbot
cloudflared tunnel route dns astrbot astrbot.whleague.win
cloudflared tunnel run --url http://127.0.0.1:9991 astrbot     # 9991 = 插件 HTTP 端口
# 稳定运行建议注册成系统服务：cloudflared service install
```

✅ 验证：本机 `curl https://astrbot.whleague.win/sync/summary` 返回 401（`{"error":"bad sign"}`）——说明入口通了且验签生效。

### 5.2 实现插件同步 API

按 [astrbot-sync-api.md](./astrbot-sync-api.md) 实现（有 Python 参考实现可抄）：

- 服务器 → 插件：`POST /sync/credit`（**必须按 `payout_id` 去重**）、`GET /sync/summary?date=`
- 插件 → 服务器：轮询 `POST /api/bind/claim`（QQ 绑定）、`GET /api/reports/pending` + `POST /api/reports/ack`（战报）

完成后回竞猜系统改真地址：

```bash
npx wrangler pages secret put SYNC_BASE_URL    # 填 https://astrbot.whleague.win
```

✅ 验证：第六步发奖后积分真到账，即为通。

---

## 六、首次初始化

### 6.1 创建管理员

```bash
curl -X POST "https://guess.whleague.win/api/setup" \
  -H "Content-Type: application/json" \
  -d '{"setupToken":"<你的SETUP_TOKEN>","username":"boss","password":"<管理密码>","displayName":"boss"}'
```

⚠️ **初始化完成后立刻删掉入口**（重要）：

```bash
npx wrangler pages secret delete SETUP_TOKEN
```

### 6.2 共享登录打通检查

1. 服务器上给赛事系统配 cookie 域（让 cookie 跨子域）：
   ```bash
   cd WHL-tournament-management-system
   npx wrangler secret put COOKIE_DOMAIN      # 填 .whleague.win
   ```
2. 浏览器登录 `whleague.win`（赛事系统），然后新标签打开 `guess.whleague.win`。
3. ✅ 验证：竞猜页右上角直接显示赛事系统的昵称（无需再登录）。
   - 若显示未登录：检查 COOKIE_DOMAIN 是否已配、竞猜是否走 `guess.` 子域、浏览器是否有 `whleague.win` 域下的 `whl_session` cookie。

### 6.3 管理台配置

`guess.whleague.win/admin.html` 登录管理员，依次确认：

- **发起人名单**：把可以开期的管理员/群友勾成发起人（名单外的人看不到管理功能）；
- **默认档位**（比分 300 / 胜平负 50 / 总进球 100 / 趣味 50）与单场上限，可按需调整。

> 说明：管理员身份来自赛事系统的 `admin/superadmin`；「本站登录」的自建账号仅用于本地开发联调，线上不用管。

---

## 七、首次实战验收

1. 发起人建一期竞猜（标题/截止/比赛/玩法项），状态改为开放；
2. 群友在赛事系统登录 → 竞猜页**绑定 QQ**（网页生成绑定码 → QQ 群里向 bot 发码）→ 提交预测（未绑定的账号此时会被 403 拦下并引导去绑定，属预期）；
3. 截止 → 录比分 → 结算预览（核对每人金额与上限）→ 确认发奖；
4. ✅ 插件日志出现 `credit payout_id=po-… amount=…`，群里收到战报，`/api/admin/batches/<id>` 显示 `paid`；
5. 次日 09:00 后：管理台「对账」页应显示 `ok`（或手动 `curl -X POST "https://guess.whleague.win/api/internal/recon" -H "X-Cron-Key: <CRON>"` 立即跑一次）。

---

## 八、日常运维

| 场景 | 现象 | 处理 |
|---|---|---|
| 发奖 unknown | 批次页 `retry_count` 增长、`next_retry_at` 在未来 | Tunnel/插件恢复后自动重试（1/5/15/60 分钟退避，共 5 次）；急事在批次页点「重试」 |
| 发奖 failed | 5 次退避后仍失败 | 看插件日志定位（多为积分不足/接口 500）；处理后「重试」，或「冲正」生成反向流水 |
| 对账 diff | 对账页出现差值明细 | 核对插件侧流水 → 管理台冲正/补发，差异当天清零 |
| 对账 error | 插件 summary 不可达 | 查 Tunnel 是否存活，恢复后次日自动再对 |

---

## 九、故障排查

- **`wrangler d1 create` 提示未登录** → `npx wrangler login` 重走授权。
- **Pages 部署后 500** → `npx wrangler pages secret list` 确认四个 secret 都在；本地 `.dev.vars` 只影响本地，不会上生产。
- **发奖全 unknown 但插件正常** → `SYNC_BASE_URL` 是否漏改/多写了尾斜杠；`SYNC_SECRET` 两端是否一致。
- **战报不发** → 插件是否在轮询 `pending` 且发送成功后才 `ack`；管理台「战报」可查积压。
- **共享登录失效** → 按第六步 6.2 的三点排查（COOKIE_DOMAIN / 子域 / cookie 存在性）。
