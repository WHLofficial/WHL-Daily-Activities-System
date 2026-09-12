#!/usr/bin/env bash
# WHL 竞猜系统 本地冒烟测试（共享账号池版：注册/登录走赛事库）
# 前置（顺序重要）：
#   a) 竞猜库全新：npx wrangler d1 migrations apply whl-guess --local
#   b) 赛事本地库播种（必须在 dev 启动【前】执行——dev 运行中跑 d1 execute 会锁库静默失败）：
#      npx wrangler d1 execute whl --local --command "INSERT INTO organization (id,name,allow_open_reg) VALUES (1,'WHL',1) ON CONFLICT(id) DO UPDATE SET allow_open_reg=1"
#      npx wrangler d1 execute whl --local --command "INSERT OR IGNORE INTO user (name,password_hash,role) VALUES ('smboss','$(node scripts/gen-tour-hash.mjs secret123)','admin')"
#      # 步 16 用的「被管理员重置密码」账号（reset-local.sh 也会自动预置）
#      npx wrangler d1 execute whl --local --command "INSERT OR REPLACE INTO user (name,password_hash,role,locked,must_change_pw) VALUES ('sm4','$(node scripts/gen-tour-hash.mjs pass4444)','coach',0,1)"
#   c) dev 服务已起（npx wrangler dev --port 8789，.dev.vars 提供测试密钥）
# 验证：播种→注册（自动登录）→验密登录→开放竞猜→HMAC 绑定→提交预测→截止→录结果→结算→确认发奖（发往不可达地址→unknown）→cron 重试→对账→强制改密→开放通知与截止提醒→到点自动截止
set -e
BASE="http://127.0.0.1:8789"
SECRET="${SYNC_SECRET:-testsecret}"
CRON="${CRON_SECRET:-cronsecret}"
# 临时文件放仓库内的 .smoke-tmp/，且用 Windows 风格路径：curl 与 node 都是原生程序，
# Git Bash 的 /tmp 在两者眼里不是同一个目录（curl 看到 %TEMP%，node 看到 C:\tmp），会互相找不到文件。
SMOKE_TMP="$(cd "$(dirname "$0")/.." && pwd -W 2>/dev/null || pwd)/.smoke-tmp"
mkdir -p "$SMOKE_TMP"; export SMOKE_TMP
# 同理，MOCK_LOG 若是 /tmp/... 这类 MSYS 路径 node 读不到，先转成 Windows 路径。
MOCK_LOG_WIN="$MOCK_LOG"
if [ -n "$MOCK_LOG" ] && command -v cygpath >/dev/null 2>&1; then MOCK_LOG_WIN="$(cygpath -w "$MOCK_LOG")"; fi
J="$SMOKE_TMP"/whl-admin.jar; U1="$SMOKE_TMP"/whl-u1.jar; U2="$SMOKE_TMP"/whl-u2.jar; U3="$SMOKE_TMP"/whl-u3.jar
say() { echo; echo "=== $1 ==="; }
ok() { echo "  -> $1"; }

claim() { # 一次性绑定码 -> HMAC 调 bind/claim（与 docs/astrbot-sync-api.md 的规范一致）
  node -e '
    const crypto=require("crypto");
    const [code,qq,secret,base]=process.argv.slice(1);
    const body=JSON.stringify({code,qq_id:qq});
    const ts=Math.floor(Date.now()/1000);
    const sign=crypto.createHmac("sha256",secret).update(`POST|/api/bind/claim|${ts}|${body}`).digest("hex");
    fetch(base+"/api/bind/claim",{method:"POST",headers:{"Content-Type":"application/json","X-Timestamp":String(ts),"X-Sign":sign},body}).then(r=>r.text()).then(t=>console.log("  -> claim:",t));
  ' "$1" "$2" "$SECRET" "$BASE"
}

pull_until() { # 像真插件那样「拉 5 条 → ack → 再拉」，直到看到含 $1 的待发内容；拉不到则退出 1
  # 队列每轮只返回 5 条，跑到后面时新内容会被旧内容挤出窗口，所以不能只拉一次就断言
  node -e '
    const crypto=require("crypto");
    const [secret,base,marker,tries]=process.argv.slice(1);
    const sign=(m,p,ts,b)=>crypto.createHmac("sha256",secret).update(`${m}|${p}|${ts}|${b||""}`).digest("hex");
    (async () => {
      for (let i=0;i<Number(tries);i++){
        const t1=Math.floor(Date.now()/1000);
        const r=await fetch(base+"/api/reports/pending",{headers:{"X-Timestamp":String(t1),"X-Sign":sign("GET","/api/reports/pending",t1)}});
        const list=(await r.json()).reports||[];
        const hit=list.find(x=>x.content.includes(marker));
        if (hit){ console.log(hit.content); return; }
        if (!list.length) break;
        const t2=Math.floor(Date.now()/1000);
        const body=JSON.stringify({ids:list.map(x=>x.id)});
        await fetch(base+"/api/reports/ack",{method:"POST",headers:{"Content-Type":"application/json","X-Timestamp":String(t2),"X-Sign":sign("POST","/api/reports/ack",t2,body)},body});
      }
      process.exit(1);
    })();
  ' "$SECRET" "$BASE" "$1" "${2:-8}"
}

say "0a. 前端 JS 语法检查（node --check 对模块语法不可靠，改用 import() 捕 SyntaxError）"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for f in core app admin; do
  node -e "
    const { pathToFileURL } = require('url');
    import(pathToFileURL(process.argv[1]).href)
      .then(() => console.log('  $f.js: parse ok'))
      .catch(e => { if (e instanceof SyntaxError) { console.error('  $f.js: SYNTAX ERROR: ' + e.message); process.exit(1); } console.log('  $f.js: parse ok（DOM 引用跳过执行）'); })
  " "$ROOT/public/$f.js" || exit 1
done

say "0. /api/me 未登录"
curl -sf "$BASE/api/me"; echo

say "1. 管理员登录（smboss 账号在赛事库，验密走共享账号池）"
curl -sf -c "$J" -X POST "$BASE/api/login" -H 'Content-Type: application/json' \
  -d '{"username":"smboss","password":"secret123"}'; echo
curl -sf -b "$J" "$BASE/api/me" | head -c 200; echo
ok "错误密码登录应被拒（401）："
curl -s -X POST "$BASE/api/login" -H 'Content-Type: application/json' \
  -d '{"username":"smboss","password":"wrongpass1"}'; echo

say "2. 三个群友注册（开放注册路径，注册即自动登录）"
curl -sf -c "$U1" -X POST "$BASE/api/register" -H 'Content-Type: application/json' -d '{"name":"sm1","password":"pass1111","displayName":"小张"}'; echo
curl -sf -c "$U2" -X POST "$BASE/api/register" -H 'Content-Type: application/json' -d '{"name":"sm2","password":"pass2222","displayName":"小李"}'; echo
curl -sf -c "$U3" -X POST "$BASE/api/register" -H 'Content-Type: application/json' -d '{"name":"sm3","password":"pass3333","displayName":"小王"}'; echo
U1ID=$(curl -sf -b "$U1" "$BASE/api/me" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).user.id))")
U3ID=$(curl -sf -b "$U3" "$BASE/api/me" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).user.id))")
ok "sm1 本地镜像 id=$U1ID，sm3 本地镜像 id=$U3ID（sm3 不参与预测，用于回归「非参与者不得分」）"
ok "重复昵称注册应被拒（409）："
curl -s -X POST "$BASE/api/register" -H 'Content-Type: application/json' -d '{"name":"sm1","password":"pass9999"}'; echo
ok "弱密码注册应被拒（400）："
curl -s -X POST "$BASE/api/register" -H 'Content-Type: application/json' -d '{"name":"sm9","password":"pass111"}'; echo

say "3. 创建竞猜（1 场 3 项，立即开放）"
DEADLINE=$(node -e "console.log(new Date(Date.now()+3600e3).toISOString())")
# 含中文的请求体一律走文件：Windows 的 curl.exe 会用本地代码页解码命令行参数，直接 -d 传中文会变乱码
cat > "$SMOKE_TMP"/whl-create.json <<JSON
{
  "title": "英超第3轮", "deadline": "$DEADLINE", "rewardCap": 1000, "openNow": true,
  "matches": [{"home": "阿森纳", "away": "切尔西", "items": [
    {"type": "score", "tiers": {"score": 300, "goals": 100, "wdl": 50}},
    {"type": "wdl", "tiers": {"wdl": 50}},
    {"type": "fun", "question": "谁先进球", "tiers": {"fun": 80}}
  ]}]
}
JSON
CREATE=$(curl -sf -b "$J" -X POST "$BASE/api/admin/events" -H 'Content-Type: application/json' -d @"$SMOKE_TMP"/whl-create.json)
echo "$CREATE"
EID=$(echo "$CREATE" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).eventId))")
ok "eventId=$EID"
# 「总进球」题型已下线（并进「猜比分」的三档），建期再传 goals 必须被拒
cat > "$SMOKE_TMP"/whl-create-goals.json <<JSON
{"title": "下线题型探针", "deadline": "$DEADLINE", "rewardCap": 1000, "openNow": false,
 "matches": [{"home": "甲队", "away": "乙队", "items": [{"type": "goals", "tiers": {"goals": 100}}]}]}
JSON
ok "用已下线的「总进球」题型建期应被拒："
curl -s -b "$J" -X POST "$BASE/api/admin/events" -H 'Content-Type: application/json' -d @"$SMOKE_TMP"/whl-create-goals.json; echo
# 玩法项与场次 id 必须从刚建的竞猜里取：本地库 AUTOINCREMENT 会累积，写死 1-4 只对全新库成立
IDS=$(curl -sf -b "$J" "$BASE/api/events/$EID" | node -e "
  let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    const d=JSON.parse(s); const byType={};
    for(const i of d.items) byType[i.type]=i.id;
    console.log([byType.score, byType.wdl, byType.fun, (d.matches[0] || {}).id].join(' '));
  })")
P_SCORE=$(echo "$IDS" | cut -d' ' -f1); P_WDL=$(echo "$IDS" | cut -d' ' -f2)
P_FUN=$(echo "$IDS" | cut -d' ' -f3); MID=$(echo "$IDS" | cut -d' ' -f4)
ok "比分=$P_SCORE 胜平负=$P_WDL 趣味=$P_FUN 场次=$MID"

say "4. 生成绑定码 + HMAC 回调绑定（sm1→QQ10001, sm2→QQ10002, sm3 故意不绑）"
C1=$(curl -sf -b "$U1" -X POST "$BASE/api/bind/new" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).code))")
C2=$(curl -sf -b "$U2" -X POST "$BASE/api/bind/new" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).code))")
claim "$C1" 10001
claim "$C2" 10002
ok "错误码验证：重放同一码应被拒"
claim "$C1" 99999 || true

say "5. 提交预测（玩法项 id 由本次竞猜动态取出）"
cat > "$SMOKE_TMP"/whl-p1.json <<JSON
{"predictions":[{"playItemId":$P_SCORE,"content":{"home":2,"away":1}},{"playItemId":$P_WDL,"content":"home"},{"playItemId":$P_FUN,"content":"萨卡"}]}
JSON
curl -sf -b "$U1" -X PUT "$BASE/api/events/$EID/predictions" -H 'Content-Type: application/json' -d @"$SMOKE_TMP"/whl-p1.json; echo
curl -sf -b "$U2" -X PUT "$BASE/api/events/$EID/predictions" -H 'Content-Type: application/json' \
  -d "{\"predictions\":[{\"playItemId\":$P_SCORE,\"content\":{\"home\":3,\"away\":0}},{\"playItemId\":$P_WDL,\"content\":\"home\"}]}"; echo
ok "sm3 未绑定 QQ，提交应被拒（403 need_binding）："
curl -s -b "$U3" -X PUT "$BASE/api/events/$EID/predictions" -H 'Content-Type: application/json' \
  -d "{\"predictions\":[{\"playItemId\":$P_SCORE,\"content\":{\"home\":2,\"away\":1}}]}"; echo

say "5b. 大家的答案：截止前也能看到他人预测，且只给昵称与答案"
curl -sf -b "$U1" "$BASE/api/events/$EID" > "$SMOKE_TMP"/whl-others.json
node -e '
  const fs = require("fs");
  const d = JSON.parse(fs.readFileSync(process.env.SMOKE_TMP + "/whl-others.json", "utf8"));
  const assert = (cond, msg) => { if (!cond) { console.error("  ✗ " + msg); process.exit(1); } console.log("  ✓ " + msg); };
  const names = d.others.map(o => o.name);
  assert(d.others.length === 1, `sm1 看到 1 位其他参赛者（实得 ${d.others.length}）`);
  assert(names[0] === "sm2", `看到的是 sm2（实得 ${names[0]}）`);
  assert(!names.includes("sm1"), "自己的答案不重复列出（页面上有自己的输入框）");
  assert(d.others[0].items[process.argv[1]] === "home", `sm2 的胜平负答案可见（实得 ${JSON.stringify(d.others[0].items)}）`);
  assert(d.others[0].total === undefined && d.others[0].hits === undefined, "未结算时不带得分与命中字段");
  assert(!fs.readFileSync(process.env.SMOKE_TMP + "/whl-others.json", "utf8").includes("10002"), "响应里不含他人 QQ 号");
' "$P_WDL"

say "5c. 奖励一览：列表与详情都带「最高可得」（＝各玩法项最高档之和）"
curl -sf -b "$U1" "$BASE/api/events" > "$SMOKE_TMP"/whl-list.json
curl -sf -b "$U1" "$BASE/api/events/$EID" > "$SMOKE_TMP"/whl-max.json
node -e '
  const fs = require("fs");
  const d = JSON.parse(fs.readFileSync(process.env.SMOKE_TMP + "/whl-max.json", "utf8"));
  const list = JSON.parse(fs.readFileSync(process.env.SMOKE_TMP + "/whl-list.json", "utf8"));
  const assert = (cond, msg) => { if (!cond) { console.error("  ✗ " + msg); process.exit(1); } console.log("  ✓ " + msg); };
  // 本场：比分 300 + 胜平负 50 + 趣味 80 = 430（比分项的三个档取最高，不相加）
  assert(d.event.maxScore === 430, `详情「最高可得 430 分」（实得 ${d.event.maxScore}）`);
  const row = list.events.find((e) => e.id === Number(process.argv[1]));
  assert(row && row.maxScore === 430, `列表同一场也带 430（实得 ${row && row.maxScore}）`);
  assert(d.event.maxScore < d.event.reward_cap, "「最高可得」是真实满分，与兑奖上限不是一回事");
' "$EID"

say "6. 提前截止 → 录比分 2:1 + 趣味题命中 sm1（本地 id $U1ID）；hits 里故意塞入未预测的 sm3"
curl -sf -b "$J" -X POST "$BASE/api/admin/events/$EID/seal"; echo
curl -sf -b "$J" -X POST "$BASE/api/admin/events/$EID/result" -H 'Content-Type: application/json' \
  -d "{\"results\":[{\"matchId\":$MID,\"home\":2,\"away\":1}],\"fun\":[{\"itemId\":$P_FUN,\"hits\":[$U1ID,$U3ID]}]}"; echo
ok "期望：sm1=比分全中 300 + 胜平负 50 + 趣味 80=430；sm2=猜比分项的总进球档 100 + 胜平负 50=150；sm3 未绑定不能参与，且进了 hits 也不得分（总计 580）"

say "6b. 结算断言（含非参与者名单回归）"
curl -sf -b "$J" "$BASE/api/admin/events/$EID" > "$SMOKE_TMP"/whl-settle.json
node -e '
  const fs = require("fs");
  const d = JSON.parse(fs.readFileSync(process.env.SMOKE_TMP + "/whl-settle.json", "utf8"));
  const rows = (d.settlement && d.settlement.detail) || [];
  const byName = Object.fromEntries(rows.map(r => [r.name, r.total]));
  const assert = (cond, msg) => { if (!cond) { console.error("  ✗ " + msg); process.exit(1); } console.log("  ✓ " + msg); };
  assert(rows.length === 2, `结算明细只有 2 人（实得 ${rows.length}）`);
  assert(Number(d.settlement.total) === 580, `总发放 580（实得 ${d.settlement.total}）`);
  assert(byName["sm1"] === 430, `sm1 = 430（实得 ${byName["sm1"]}）`);
  assert(byName["sm2"] === 150, `sm2 = 150（实得 ${byName["sm2"]}）`);
  assert(!rows.some(r => String(r.user_id) === process.argv[1]), `非参与者 sm3（本地 id ${process.argv[1]}）未出现在结算明细里`);
' "$U3ID"

say "6c. 结算后「大家的答案」附命中档与得分"
curl -sf -b "$U1" "$BASE/api/events/$EID" > "$SMOKE_TMP"/whl-others-settled.json
node -e '
  const fs = require("fs");
  const d = JSON.parse(fs.readFileSync(process.env.SMOKE_TMP + "/whl-others-settled.json", "utf8"));
  const assert = (cond, msg) => { if (!cond) { console.error("  ✗ " + msg); process.exit(1); } console.log("  ✓ " + msg); };
  const [pScore, pWdl, pFun] = process.argv.slice(1);
  const o = d.others[0];
  assert(d.others.length === 1 && o.name === "sm2", `结算后仍只列 sm2（实得 ${d.others.map(x => x.name).join("/")}）`);
  assert(Number(o.total) === 150, `sm2 总分 150（实得 ${o.total}）`);
  assert(Number(o.hits[pScore]) === 100, `sm2 的猜比分命中总进球档 +100（实得 ${JSON.stringify(o.hits)}）`);
  assert(Number(o.hits[pWdl]) === 50, `sm2 的胜平负 +50（实得 ${JSON.stringify(o.hits)}）`);
  assert(!(pFun in o.hits), "sm2 的趣味题未命中，不进 hits");
' "$P_SCORE" "$P_WDL" "$P_FUN"

wait_batch() { # 确认发奖的同步已转后台执行，这里轮询批次直到全部到终态（本地 mock 下亚秒级）
  local bid="$1" s=""
  for i in $(seq 1 30); do
    s=$(curl -sf -b "$J" "$BASE/api/admin/batches/$bid" | node -e "
      let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
        const b=JSON.parse(s);
        console.log(b.items.every(i=>['credited','reversed','exhausted'].includes(i.status))?'done':b.items.map(i=>i.status).join('/'));
      })")
    [ "$s" = "done" ] && { ok "批次 #$bid 全部到终态（第 $i 次轮询）"; return 0; }
    sleep 0.5
  done
  echo "  ✗ 批次 #$bid 未在 15 秒内到账（$s）"; exit 1
}

say "7. 确认发奖（SYNC_BASE_URL 指向 mock → 直接 credited；不可达时则 unknown 进重试队列；同步在后台跑，响应立即返回）"
CONFIRM1=$(curl -sf -b "$J" -X POST "$BASE/api/admin/events/$EID/confirm" -H 'Content-Type: application/json' -d '{"overrideCap":false}')
echo "$CONFIRM1"

say "7b. 重复确认发奖（幂等：第二次走 alreadyConfirmed，不新建批次）"
SECOND=$(curl -sf -b "$J" -X POST "$BASE/api/admin/events/$EID/confirm" -H 'Content-Type: application/json' -d '{"overrideCap":false}')
echo "$SECOND"
BID=$(curl -sf -b "$J" "$BASE/api/admin/events/$EID" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log((JSON.parse(s).batch||{}).id))")
wait_batch "$BID"
curl -sf -b "$J" "$BASE/api/admin/batches/$BID" > "$SMOKE_TMP"/whl-batch.json
node -e '
  const fs = require("fs");
  const first = JSON.parse(process.argv[1]);
  const second = JSON.parse(process.argv[2]);
  const b = JSON.parse(fs.readFileSync(process.env.SMOKE_TMP + "/whl-batch.json", "utf8"));
  const assert = (cond, msg) => { if (!cond) { console.error("  ✗ " + msg); process.exit(1); } console.log("  ✓ " + msg); };
  assert(first.background === true && first.dispatch === null, "确认发奖立即返回（background=true，同步转后台）");
  assert(second.alreadyConfirmed === true, "第二次确认返回 alreadyConfirmed");
  assert(Number(second.batchId) === Number(b.batch.id), `两次确认指向同一批次 #${b.batch.id}`);
  assert(b.items.length === 2, `批次仍是 2 笔（未重复建项，实得 ${b.items.length}）`);
  assert(b.items.every(i => i.status === "credited"), `2 笔均到账（实得 ${b.items.map(i => i.status).join("/")}）`);
' "$CONFIRM1" "$SECOND"

say "8. cron 重试通道"
curl -sf -X POST "$BASE/api/internal/retry" -H "X-Cron-Key: $CRON"; echo
ok "cron key 错误应被拒："
curl -s -X POST "$BASE/api/internal/retry" -H "X-Cron-Key: wrong" ; echo

say "9. 每日对账（插件不可达 → error 记录）"
curl -sf -X POST "$BASE/api/internal/recon" -H "X-Cron-Key: $CRON"; echo
curl -sf -b "$J" "$BASE/api/admin/recon"; echo

say "10. 战报待发队列（插件将拉取的内容）"
node -e '
    const crypto=require("crypto");
    const [secret,base]=process.argv.slice(1);
    const ts=Math.floor(Date.now()/1000);
    const sign=crypto.createHmac("sha256",secret).update(`GET|/api/reports/pending|${ts}|`).digest("hex");
    fetch(base+"/api/reports/pending",{headers:{"X-Timestamp":String(ts),"X-Sign":sign}}).then(r=>r.text()).then(t=>console.log(t));
  ' "$SECRET" "$BASE"

say "11. 数据库核对（发放项/流水镜像/同步日志）"
npx wrangler d1 execute whl-guess --local --command \
  "SELECT display_name, pi.qq_id, pi.amount, pi.status, pi.retry_count FROM payout_item pi JOIN users u ON u.id=pi.user_id" --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s)[0].results)))"
npx wrangler d1 execute whl-guess --local --command "SELECT payout_id, qq_id, amount, type FROM ledger_mirror" --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s)[0].results)))"
npx wrangler d1 execute whl-guess --local --command "SELECT attempt, outcome, substr(detail,1,60) AS detail FROM sync_log" --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s)[0].results)))"
HOLD=$(npx wrangler d1 execute whl-guess --local --command "SELECT COUNT(*) AS n FROM payout_item WHERE claim_at IS NOT NULL" --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)[0].results[0].n))")
if [ "$HOLD" = "0" ]; then ok "认领锁已释放（claim_at 全为 NULL）"; else echo "  ✗ 仍有 $HOLD 条发放项挂着认领锁"; exit 1; fi

if [ -n "$MOCK_LOG" ]; then
say "12. 并发确认发奖（幂等 + 认领锁：每笔只向插件提交一次；需要 MOCK_LOG 指向 mock 插件日志）"
DEADLINE2=$(node -e "console.log(new Date(Date.now()+3600e3).toISOString())")
cat > "$SMOKE_TMP"/whl-create2.json <<JSON
{"title": "并发发奖验证", "deadline": "$DEADLINE2", "rewardCap": 1000, "openNow": true,
 "matches": [{"home": "利物浦", "away": "曼城", "items": [{"type": "wdl", "tiers": {"wdl": 100}}]}]}
JSON
CREATE2=$(curl -sf -b "$J" -X POST "$BASE/api/admin/events" -H 'Content-Type: application/json' -d @"$SMOKE_TMP"/whl-create2.json)
EID2=$(echo "$CREATE2" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).eventId))")
IDS2=$(curl -sf -b "$J" "$BASE/api/events/$EID2" | node -e "
  let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s);console.log(d.items[0].id+' '+(d.matches[0]||{}).id)})")
P2=$(echo "$IDS2" | cut -d' ' -f1); MID2=$(echo "$IDS2" | cut -d' ' -f2)
curl -sf -b "$U1" -X PUT "$BASE/api/events/$EID2/predictions" -H 'Content-Type: application/json' -d "{\"predictions\":[{\"playItemId\":$P2,\"content\":\"home\"}]}" > /dev/null
curl -sf -b "$U2" -X PUT "$BASE/api/events/$EID2/predictions" -H 'Content-Type: application/json' -d "{\"predictions\":[{\"playItemId\":$P2,\"content\":\"home\"}]}" > /dev/null
curl -sf -b "$J" -X POST "$BASE/api/admin/events/$EID2/seal" > /dev/null
curl -sf -b "$J" -X POST "$BASE/api/admin/events/$EID2/result" -H 'Content-Type: application/json' \
  -d "{\"results\":[{\"matchId\":$MID2,\"home\":2,\"away\":1}],\"fun\":[]}" > /dev/null
curl -sf -b "$J" -X POST "$BASE/api/admin/events/$EID2/confirm" -H 'Content-Type: application/json' -d '{"overrideCap":false}' > "$SMOKE_TMP"/whl-c1.json &
curl -sf -b "$J" -X POST "$BASE/api/admin/events/$EID2/confirm" -H 'Content-Type: application/json' -d '{"overrideCap":false}' > "$SMOKE_TMP"/whl-c2.json &
wait
BID2=$(curl -sf -b "$J" "$BASE/api/admin/events/$EID2" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log((JSON.parse(s).batch||{}).id))")
wait_batch "$BID2"
curl -sf -b "$J" "$BASE/api/admin/batches/$BID2" > "$SMOKE_TMP"/whl-batch2.json
node -e '
  const fs = require("fs");
  const c1 = JSON.parse(fs.readFileSync(process.env.SMOKE_TMP + "/whl-c1.json", "utf8"));
  const c2 = JSON.parse(fs.readFileSync(process.env.SMOKE_TMP + "/whl-c2.json", "utf8"));
  const b = JSON.parse(fs.readFileSync(process.env.SMOKE_TMP + "/whl-batch2.json", "utf8"));
  const log = fs.readFileSync(process.argv[1], "utf8");
  const assert = (cond, msg) => { if (!cond) { console.error("  ✗ " + msg); process.exit(1); } console.log("  ✓ " + msg); };
  assert(new Set([c1.batchId, c2.batchId]).size === 1, `并发两次确认落在同一批次 #${c1.batchId}`);
  assert(c1.alreadyConfirmed === true || c2.alreadyConfirmed === true, "其中一个请求走幂等分支（alreadyConfirmed）");
  assert(b.items.length === 2 && b.items.every(i => i.status === "credited"), `批次 2 笔全部到账（实得 ${b.items.map(i => i.status).join("/")}）`);
  for (const i of b.items) {
    const n = (log.match(new RegExp("credit payout_id=" + i.payout_id, "g")) || []).length;
    assert(n === 1, `${i.payout_id} 在插件侧只被提交 1 次（实得 ${n} 次）`);
  }
' "$MOCK_LOG_WIN"
else
  echo; echo "(跳过 12：未设置 MOCK_LOG，无法统计插件侧提交次数)"
fi

say "13. 无人命中：确认发奖跳过批次（状态直接到「已发奖」，不留空批次）"
DEADLINE3=$(node -e "console.log(new Date(Date.now()+3600e3).toISOString())")
cat > "$SMOKE_TMP"/whl-create3.json <<JSON
{"title": "无人命中验证", "deadline": "$DEADLINE3", "rewardCap": 1000, "openNow": true,
 "matches": [{"home": "热刺", "away": "埃弗顿", "items": [{"type": "score", "tiers": {"score": 300, "goals": 100, "wdl": 50}}]}]}
JSON
CREATE3=$(curl -sf -b "$J" -X POST "$BASE/api/admin/events" -H 'Content-Type: application/json' -d @"$SMOKE_TMP"/whl-create3.json)
EID3=$(echo "$CREATE3" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).eventId))")
IDS3=$(curl -sf -b "$J" "$BASE/api/events/$EID3" | node -e "
  let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s);console.log(d.items[0].id+' '+(d.matches[0]||{}).id)})")
P3=$(echo "$IDS3" | cut -d' ' -f1); MID3=$(echo "$IDS3" | cut -d' ' -f2)
# 两人都猜错：实际 3:2（主胜、总进球 5），sm1 猜 0:0（平、0 球），sm2 猜 0:1（客胜、1 球）
curl -sf -b "$U1" -X PUT "$BASE/api/events/$EID3/predictions" -H 'Content-Type: application/json' -d "{\"predictions\":[{\"playItemId\":$P3,\"content\":{\"home\":0,\"away\":0}}]}" > /dev/null
curl -sf -b "$U2" -X PUT "$BASE/api/events/$EID3/predictions" -H 'Content-Type: application/json' -d "{\"predictions\":[{\"playItemId\":$P3,\"content\":{\"home\":0,\"away\":1}}]}" > /dev/null
curl -sf -b "$J" -X POST "$BASE/api/admin/events/$EID3/seal" > /dev/null
echo "  result: $(curl -sf -b "$J" -X POST "$BASE/api/admin/events/$EID3/result" -H 'Content-Type: application/json' -d "{\"results\":[{\"matchId\":$MID3,\"home\":3,\"away\":2}],\"fun\":[]}")"
SKIP=$(curl -sf -b "$J" -X POST "$BASE/api/admin/events/$EID3/confirm" -H 'Content-Type: application/json' -d '{"overrideCap":false}')
echo "  confirm: $SKIP"
AGAIN3=$(curl -sf -b "$J" -X POST "$BASE/api/admin/events/$EID3/confirm" -H 'Content-Type: application/json' -d '{"overrideCap":false}')
echo "  confirm again: $AGAIN3"
curl -sf -b "$J" "$BASE/api/admin/events/$EID3" > "$SMOKE_TMP"/whl-nohit.json
echo "  archive: $(curl -sf -b "$J" -X POST "$BASE/api/admin/events/$EID3/archive")"
node -e '
  const fs = require("fs");
  const skip = JSON.parse(process.argv[1]), again = JSON.parse(process.argv[2]);
  const d = JSON.parse(fs.readFileSync(process.env.SMOKE_TMP + "/whl-nohit.json", "utf8"));
  const assert = (cond, msg) => { if (!cond) { console.error("  ✗ " + msg); process.exit(1); } console.log("  ✓ " + msg); };
  assert(Number(d.settlement.total) === 0, `结算总额 0（实得 ${d.settlement.total}）`);
  assert(skip.skipped === true && skip.ok === true, "确认发奖返回 skipped");
  assert(skip.payoutCount === 0 && skip.batchId === null, "未建批次、未写发放项");
  assert(!d.batch, "本次竞猜没有发放批次");
  assert(d.event.status === "paid", `状态直接到「已发奖」（实得 ${d.event.status}）`);
  assert(again.alreadyConfirmed === true && again.skipped === true, "重复确认走 alreadyConfirmed，不重复处理");
' "$SKIP" "$AGAIN3"

say "14. 猜胜负（跨场次玩法，覆盖全部场次）：tiered 分档计分"
DEADLINE4=$(node -e "console.log(new Date(Date.now()+3600e3).toISOString())")
cat > "$SMOKE_TMP"/whl-create4.json <<JSON
{"title": "猜胜负分档验证", "deadline": "$DEADLINE4", "rewardCap": 1000, "openNow": true,
 "matches": [
   {"home": "国米", "away": "罗马", "items": [{"type": "wdl", "tiers": {"wdl": 10}}]},
   {"home": "拜仁", "away": "多特", "items": [{"type": "wdl", "tiers": {"wdl": 10}}]}
 ],
 "cross": {"type": "wdl_all", "tiers": {"mode": "tiered", "hit1": 20, "hit2": 100, "hit3": 300}}}
JSON
CREATE4=$(curl -sf -b "$J" -X POST "$BASE/api/admin/events" -H 'Content-Type: application/json' -d @"$SMOKE_TMP"/whl-create4.json)
echo "$CREATE4"
EID4=$(echo "$CREATE4" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).eventId))")
IDS4=$(curl -sf -b "$J" "$BASE/api/events/$EID4" | node -e "
  let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s);
    const cross=d.items.filter(i=>i.match_id==null).map(i=>i.id);
    console.log(d.matches.map(m=>m.id).concat(cross).join(' '))})")
M4A=$(echo "$IDS4" | cut -d' ' -f1); M4B=$(echo "$IDS4" | cut -d' ' -f2); PC4=$(echo "$IDS4" | cut -d' ' -f3)
ok "两场 id=$M4A/$M4B，跨场次「猜胜负」项 id=$PC4"
# 跨场次项不挂在任何一场比赛下（match_id 为 NULL），必须仍能出现在 items 里
ok "跨场次项已挂在整个竞猜下（不依赖任何单场比赛）"

ok "只答一场应被拒（场次不齐）："
curl -s -b "$U1" -X PUT "$BASE/api/events/$EID4/predictions" -H 'Content-Type: application/json' \
  -d "{\"predictions\":[{\"playItemId\":$PC4,\"content\":{\"$M4A\":\"home\"}}]}"; echo
ok "答案值不合法应被拒（只能主胜/平/客胜）："
curl -s -b "$U1" -X PUT "$BASE/api/events/$EID4/predictions" -H 'Content-Type: application/json' \
  -d "{\"predictions\":[{\"playItemId\":$PC4,\"content\":{\"$M4A\":\"win\",\"$M4B\":\"draw\"}}]}"; echo
# 实际：国米 2:1 罗马（主胜）、拜仁 1:1 多特（平）→ sm1 两场全中→hit2 档 100；sm2 只中国米→hit1 档 20
curl -sf -b "$U1" -X PUT "$BASE/api/events/$EID4/predictions" -H 'Content-Type: application/json' \
  -d "{\"predictions\":[{\"playItemId\":$PC4,\"content\":{\"$M4A\":\"home\",\"$M4B\":\"draw\"}}]}" > /dev/null
curl -sf -b "$U2" -X PUT "$BASE/api/events/$EID4/predictions" -H 'Content-Type: application/json' \
  -d "{\"predictions\":[{\"playItemId\":$PC4,\"content\":{\"$M4A\":\"home\",\"$M4B\":\"away\"}}]}" > /dev/null
curl -sf -b "$J" -X POST "$BASE/api/admin/events/$EID4/seal" > /dev/null
curl -sf -b "$J" -X POST "$BASE/api/admin/events/$EID4/result" -H 'Content-Type: application/json' \
  -d "{\"results\":[{\"matchId\":$M4A,\"home\":2,\"away\":1},{\"matchId\":$M4B,\"home\":1,\"away\":1}],\"fun\":[]}" > /dev/null
CONFIRM4=$(curl -sf -b "$J" -X POST "$BASE/api/admin/events/$EID4/confirm" -H 'Content-Type: application/json' -d '{"overrideCap":false}')
echo "$CONFIRM4"
curl -sf -b "$J" "$BASE/api/admin/events/$EID4" > "$SMOKE_TMP"/whl-wdlall.json
node -e '
  const fs = require("fs");
  const d = JSON.parse(fs.readFileSync(process.env.SMOKE_TMP + "/whl-wdlall.json", "utf8"));
  const rows = (d.settlement && d.settlement.detail) || [];
  const byName = Object.fromEntries(rows.map(r => [r.name, r.total]));
  const tierOf = (n) => (((rows.find(r => r.name === n) || {}).items || []).flatMap(i => i.hitTiers || []))[0];
  const assert = (cond, msg) => { if (!cond) { console.error("  ✗ " + msg); process.exit(1); } console.log("  ✓ " + msg); };
  assert(Number(d.settlement.total) === 120, `总发放 120（实得 ${d.settlement.total}）`);
  assert(byName["sm1"] === 100, `sm1 中 2 场取 hit2 档 = 100（实得 ${byName["sm1"]}）`);
  assert(byName["sm2"] === 20, `sm2 中 1 场取 hit1 档 = 20（实得 ${byName["sm2"]}）`);
  assert(tierOf("sm1") === "hit2" && tierOf("sm2") === "hit1", `命中档记进明细（实得 sm1=${tierOf("sm1")} sm2=${tierOf("sm2")}）`);
' 
say "14b. 战报：跨场次玩法单独一段（战报按场次逐场输出，不单列就会整段丢失）"
RPT4B=$(pull_until "🏆 竞猜战报 · 猜胜负分档验证") || { echo "  ✗ 待发战报里没有猜胜负那一次的"; exit 1; }
echo "$RPT4B" | node -e '
  const content=require("fs").readFileSync(0,"utf8");
  const assert=(cond,msg)=>{if(!cond){console.error("  ✗ "+msg);process.exit(1);}console.log("  ✓ "+msg);};
  console.log("--- 战报片段 ---");
  console.log(content.trimEnd());
  assert(content.includes("🎯 猜胜负"), "战报含「🎯 猜胜负」独立段");
  assert(content.includes("胜负中 2 场") && content.includes("sm1"), "战报标出「胜负中 2 场」与中奖人");
'

say "14c. 猜胜负：每中一场固定分（per_hit）模式"
DEADLINE5=$(node -e "console.log(new Date(Date.now()+3600e3).toISOString())")
cat > "$SMOKE_TMP"/whl-create5.json <<JSON
{"title": "猜胜负每场分验证", "deadline": "$DEADLINE5", "rewardCap": 1000, "openNow": true,
 "matches": [
   {"home": "巴萨", "away": "塞维", "items": [{"type": "wdl", "tiers": {"wdl": 10}}]},
   {"home": "马竞", "away": "皇社", "items": [{"type": "wdl", "tiers": {"wdl": 10}}]}
 ],
 "cross": {"type": "wdl_all", "tiers": {"mode": "per_hit", "perHit": 50}}}
JSON
CREATE5=$(curl -sf -b "$J" -X POST "$BASE/api/admin/events" -H 'Content-Type: application/json' -d @"$SMOKE_TMP"/whl-create5.json)
EID5=$(echo "$CREATE5" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).eventId))")
IDS5=$(curl -sf -b "$J" "$BASE/api/events/$EID5" | node -e "
  let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s);
    const cross=d.items.filter(i=>i.match_id==null).map(i=>i.id);
    console.log(d.matches.map(m=>m.id).concat(cross).join(' '))})")
M5A=$(echo "$IDS5" | cut -d' ' -f1); M5B=$(echo "$IDS5" | cut -d' ' -f2); PC5=$(echo "$IDS5" | cut -d' ' -f3)
# 实际：巴萨 0:2 塞维（客胜）、马竞 3:0 皇社（主胜）→ sm1 猜客胜/主胜 → 中 2 场 = 50×2 = 100
curl -sf -b "$U1" -X PUT "$BASE/api/events/$EID5/predictions" -H 'Content-Type: application/json' \
  -d "{\"predictions\":[{\"playItemId\":$PC5,\"content\":{\"$M5A\":\"away\",\"$M5B\":\"home\"}}]}" > /dev/null
curl -sf -b "$J" -X POST "$BASE/api/admin/events/$EID5/seal" > /dev/null
curl -sf -b "$J" -X POST "$BASE/api/admin/events/$EID5/result" -H 'Content-Type: application/json' \
  -d "{\"results\":[{\"matchId\":$M5A,\"home\":0,\"away\":2},{\"matchId\":$M5B,\"home\":3,\"away\":0}],\"fun\":[]}" > /dev/null
curl -sf -b "$J" -X POST "$BASE/api/admin/events/$EID5/confirm" -H 'Content-Type: application/json' -d '{"overrideCap":false}' > /dev/null
curl -sf -b "$J" "$BASE/api/admin/events/$EID5" > "$SMOKE_TMP"/whl-wdlall2.json
node -e '
  const fs = require("fs");
  const d = JSON.parse(fs.readFileSync(process.env.SMOKE_TMP + "/whl-wdlall2.json", "utf8"));
  const rows = (d.settlement && d.settlement.detail) || [];
  const sm1 = rows.find(r => r.name === "sm1") || {};
  const assert = (cond, msg) => { if (!cond) { console.error("  ✗ " + msg); process.exit(1); } console.log("  ✓ " + msg); };
  assert(Number(d.settlement.total) === 100, `总发放 100（实得 ${d.settlement.total}）`);
  assert(Number(sm1.total) === 100, `sm1 中 2 场 × 每场 50 = 100（实得 ${sm1.total}）`);
'

say "15. 纯猜胜负：2~10 场、档位留空或填 0 则往前找档（没有单场玩法项）"
DEADLINE6=$(node -e "console.log(new Date(Date.now()+3600e3).toISOString())")
# 探针体统一用 ASCII 队名/标题：node -e 的命令行参数在 Windows 下会被按 cp936 解码，中文会乱码
node -e '
  const fs = require("fs"), d = process.argv[1], dl = process.argv[2];
  const T = (t) => ({ type: "wdl_all", tiers: t });
  const mk = (n, form, cross, withItems) => ({
    form, title: "edge probe", deadline: dl, rewardCap: 1000, openNow: true,
    matches: Array.from({ length: n }, (_, i) => ({ home: "H" + i, away: "A" + i, items: withItems ? [{ type: "wdl", tiers: { wdl: 10 } }] : [] })),
    ...(cross === null ? {} : { cross })
  });
  fs.writeFileSync(d + "/whl-pure-1.json", JSON.stringify(mk(1, "pure", T({ mode: "tiered", hit1: 50 }))));
  fs.writeFileSync(d + "/whl-pure-11.json", JSON.stringify(mk(11, "pure", T({ mode: "tiered", hit1: 50 }))));
  fs.writeFileSync(d + "/whl-pure-items.json", JSON.stringify(mk(2, "pure", T({ mode: "tiered", hit1: 50 }), true)));
  fs.writeFileSync(d + "/whl-pure-nocross.json", JSON.stringify(mk(2, "pure", null)));
  fs.writeFileSync(d + "/whl-pure-zero.json", JSON.stringify(mk(2, "pure", T({ mode: "tiered", hit1: 0, hit2: 0 }))));
  fs.writeFileSync(d + "/whl-items-4.json", JSON.stringify(mk(4, "items", null, true)));
' "$SMOKE_TMP" "$DEADLINE6"
ok "纯猜胜负只给 1 场应被拒："
curl -s -b "$J" -X POST "$BASE/api/admin/events" -H 'Content-Type: application/json' -d @"$SMOKE_TMP"/whl-pure-1.json; echo
ok "纯猜胜负给 11 场应被拒（上限 10 场）："
curl -s -b "$J" -X POST "$BASE/api/admin/events" -H 'Content-Type: application/json' -d @"$SMOKE_TMP"/whl-pure-11.json; echo
ok "纯猜胜负带单场玩法项应被拒："
curl -s -b "$J" -X POST "$BASE/api/admin/events" -H 'Content-Type: application/json' -d @"$SMOKE_TMP"/whl-pure-items.json; echo
ok "纯猜胜负不配计分方式应被拒："
curl -s -b "$J" -X POST "$BASE/api/admin/events" -H 'Content-Type: application/json' -d @"$SMOKE_TMP"/whl-pure-nocross.json; echo
ok "档位全为 0 应被拒（至少要有一档有分）："
curl -s -b "$J" -X POST "$BASE/api/admin/events" -H 'Content-Type: application/json' -d @"$SMOKE_TMP"/whl-pure-zero.json; echo
ok "标准形式给 4 场应被拒（上限 3 场）："
curl -s -b "$J" -X POST "$BASE/api/admin/events" -H 'Content-Type: application/json' -d @"$SMOKE_TMP"/whl-items-4.json; echo

# 10 场纯猜胜负，只配「中 3 场 = 300」「中 5 场 = 500」，其余留空
node -e '
  const fs = require("fs"), d = process.argv[1], dl = process.argv[2];
  fs.writeFileSync(d + "/whl-pure10.json", JSON.stringify({
    form: "pure", title: "pure wdl 10 matches", deadline: dl, rewardCap: 1000, openNow: true,
    matches: Array.from({ length: 10 }, (_, i) => ({ home: "H" + i, away: "A" + i, items: [] })),
    cross: { type: "wdl_all", tiers: { mode: "tiered", hit3: 300, hit5: 500 } }
  }));
' "$SMOKE_TMP" "$DEADLINE6"
CREATE6=$(curl -sf -b "$J" -X POST "$BASE/api/admin/events" -H 'Content-Type: application/json' -d @"$SMOKE_TMP"/whl-pure10.json)
echo "$CREATE6"
EID6=$(echo "$CREATE6" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).eventId))")
VIEW6=$(curl -sf -b "$J" "$BASE/api/events/$EID6")
INFO6=$(echo "$VIEW6" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s);console.log([d.form,d.items[0].id].concat(d.matches.map(m=>m.id)).join(' '))})")
FORM6=$(echo "$INFO6" | cut -d' ' -f1); PC6=$(echo "$INFO6" | cut -d' ' -f2); MIDS6=$(echo "$INFO6" | cut -d' ' -f3-)
ok "服务端派生 form=$FORM6；跨场次项 id=$PC6；10 场 id=$MIDS6"
ok "场数=$(echo "$MIDS6" | wc -w)（应为 10）、玩法项=$(echo "$VIEW6" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).items.length))")（应为 1，纯猜胜负没有单场玩法项）"
# 10 场全部录 1:0（主胜）。sm1 前 4 场猜主胜 = 中 4 场；sm2 前 6 场猜主胜 = 中 6 场
node -e '
  const fs = require("fs"), [d, itemId, mids] = process.argv.slice(1);
  const ids = mids.split(" ").map(Number);
  fs.writeFileSync(d + "/whl-pure10-hit4.json", JSON.stringify({ predictions: [{ playItemId: Number(itemId),
    content: Object.fromEntries(ids.map((id, i) => [id, i < 4 ? "home" : "away"])) }] }));
  fs.writeFileSync(d + "/whl-pure10-hit6.json", JSON.stringify({ predictions: [{ playItemId: Number(itemId),
    content: Object.fromEntries(ids.map((id, i) => [id, i < 6 ? "home" : "away"])) }] }));
  const res = (n) => JSON.stringify({ results: ids.slice(0, n).map((id) => ({ matchId: id, home: 1, away: 0 })), fun: [] });
  fs.writeFileSync(d + "/whl-pure10-res9.json", res(9));
  fs.writeFileSync(d + "/whl-pure10-res.json", res(10));
' "$SMOKE_TMP" "$PC6" "$MIDS6"
curl -sf -b "$U1" -X PUT "$BASE/api/events/$EID6/predictions" -H 'Content-Type: application/json' -d @"$SMOKE_TMP"/whl-pure10-hit4.json > /dev/null
curl -sf -b "$U2" -X PUT "$BASE/api/events/$EID6/predictions" -H 'Content-Type: application/json' -d @"$SMOKE_TMP"/whl-pure10-hit6.json > /dev/null
curl -sf -b "$J" -X POST "$BASE/api/admin/events/$EID6/seal" > /dev/null
ok "录结果漏 1 场应被拒（10 场只报 9 场）："
curl -s -b "$J" -X POST "$BASE/api/admin/events/$EID6/result" -H 'Content-Type: application/json' -d @"$SMOKE_TMP"/whl-pure10-res9.json; echo
curl -sf -b "$J" -X POST "$BASE/api/admin/events/$EID6/result" -H 'Content-Type: application/json' -d @"$SMOKE_TMP"/whl-pure10-res.json > /dev/null
curl -sf -b "$J" -X POST "$BASE/api/admin/events/$EID6/confirm" -H 'Content-Type: application/json' -d '{"overrideCap":false}' > /dev/null
curl -sf -b "$J" "$BASE/api/admin/events/$EID6" > "$SMOKE_TMP"/whl-pure10-done.json
node -e '
  const d = JSON.parse(require("fs").readFileSync(process.env.SMOKE_TMP + "/whl-pure10-done.json", "utf8"));
  const rows = (d.settlement && d.settlement.detail) || [];
  const byName = Object.fromEntries(rows.map((r) => [r.name, Number(r.total)]));
  const tierOf = (n) => (((rows.find((r) => r.name === n) || {}).items || []).flatMap((i) => i.hitTiers || []))[0];
  const assert = (c, m) => { if (!c) { console.error("  ✗ " + m); process.exit(1); } console.log("  ✓ " + m); };
  assert(Number(d.settlement.total) === 800, `总发放 800（实得 ${d.settlement.total}）`);
  assert(byName.sm1 === 300, `中 4 场：hit4 留空 → 往前取 hit3 = 300（实得 ${byName.sm1}）`);
  assert(byName.sm2 === 500, `中 6 场：hit6 留空 → 往前取 hit5 = 500（实得 ${byName.sm2}）`);
  assert(tierOf("sm1") === "hit4" && tierOf("sm2") === "hit6", `明细记实际命中场数（实得 ${tierOf("sm1")}/${tierOf("sm2")}）`);
'

say "15b. 纯猜胜负战报：按命中场数贴档位标签"
RPT5B=$(pull_until "🏆 竞猜战报 · pure wdl 10 matches") || { echo "  ✗ 待发战报里没有 10 场纯猜胜负那一次的"; exit 1; }
echo "$RPT5B" | node -e '
  const content=require("fs").readFileSync(0,"utf8");
  const assert=(cond,msg)=>{if(!cond){console.error("  ✗ "+msg);process.exit(1);}console.log("  ✓ "+msg);};
  assert(content.includes("🎯 猜胜负"), "战报含「🎯 猜胜负」独立段");
  assert(content.includes("胜负中 4 场") && content.includes("（+300）"), "标出「胜负中 4 场 （+300）」");
  assert(content.includes("胜负中 6 场") && content.includes("（+500）"), "标出「胜负中 6 场 （+500）」");
'

say "16. 强制改密：被管理员重置密码的账号在本站内改密（不再赶去赛事系统）"
# sm4 由 reset-local.sh 预置成 must_change_pw=1（该标记只能在 dev 启动前写赛事本地库）
U4="$SMOKE_TMP"/whl-u4.jar
LOGIN4=$(curl -sf -c "$U4" -X POST "$BASE/api/login" -H 'Content-Type: application/json' -d '{"username":"sm4","password":"pass4444"}')
echo "  login: $LOGIN4"
curl -sf -b "$U4" "$BASE/api/me" > "$SMOKE_TMP"/whl-me4.json
echo "  me: $(cat "$SMOKE_TMP"/whl-me4.json)"
ok "未改密时应能看自身状态、但业务接口被拦下（403 password_change_required）："
GATE4=$(curl -s -b "$U4" -w '\n%{http_code}' "$BASE/api/events")
echo "$GATE4"
ok "旧密码不对应被拒："
curl -s -b "$U4" -X POST "$BASE/api/password" -H 'Content-Type: application/json' -d '{"oldPassword":"wrongold1","newPassword":"pass5555"}'; echo
ok "新密码太弱应被拒："
curl -s -b "$U4" -X POST "$BASE/api/password" -H 'Content-Type: application/json' -d '{"oldPassword":"pass4444","newPassword":"short1"}'; echo
CHG4=$(curl -sf -b "$U4" -X POST "$BASE/api/password" -H 'Content-Type: application/json' -d '{"oldPassword":"pass4444","newPassword":"pass5555"}')
echo "  password: $CHG4"
curl -sf -b "$U4" "$BASE/api/me" > "$SMOKE_TMP"/whl-me4-2.json
AFTER4=$(curl -s -o /dev/null -w '%{http_code}' -b "$U4" "$BASE/api/events")
ok "改密后业务接口恢复：GET /api/events → $AFTER4"
ok "旧密码应失效："
curl -s -X POST "$BASE/api/login" -H 'Content-Type: application/json' -d '{"username":"sm4","password":"pass4444"}'; echo
NEWLOGIN4=$(curl -sf -c "$SMOKE_TMP"/whl-u4b.jar -X POST "$BASE/api/login" -H 'Content-Type: application/json' -d '{"username":"sm4","password":"pass5555"}')
echo "  relogin: $NEWLOGIN4"
node -e '
  const fs = require("fs");
  const rd = (p) => JSON.parse(fs.readFileSync(process.env.SMOKE_TMP + p, "utf8"));
  const login = JSON.parse(process.argv[1]), relogin = JSON.parse(process.argv[3]);
  const me = rd("/whl-me4.json"), me2 = rd("/whl-me4-2.json");
  const [gate, code] = process.argv[2].split("\n");
  const assert = (c, m) => { if (!c) { console.error("  ✗ " + m); process.exit(1); } console.log("  ✓ " + m); };
  assert(login.ok === true && login.mustChangePassword === true, "重置账号能登录，且响应带 mustChangePassword 标记");
  assert(!!me.user && Number(me.user.id) > 0, "/api/me 在未改密时仍放行（白名单）");
  assert(me.mustChangePassword === true, "/api/me 带 mustChangePassword=true");
  assert(code === "403" && JSON.parse(gate).error === "password_change_required", `业务接口 403 password_change_required（实得 ${code}/${JSON.parse(gate).error}）`);
  assert(me2.mustChangePassword === false, "改密后 /api/me 标记清零");
  assert(relogin.ok === true && relogin.mustChangePassword === false, "新密码可登录且不再要求改密（已写回共享账号池）");
' "$LOGIN4" "$GATE4" "$NEWLOGIN4"
if [ "$AFTER4" = "200" ]; then ok "改密后 GET /api/events 200"; else echo "  ✗ 改密后 GET /api/events 期望 200，实得 $AFTER4"; exit 1; fi

say "17. 开放通知 + 截止前提醒（复用 report 队列，kind 区分；提醒挂在 */5 扫描上）"
d1q() { npx wrangler d1 execute whl-guess --local --command "$1" --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s)[0].results)))"; }
# 5 小时后截止：建期即开放，此时不该有提醒（还没进 4 小时窗口）
DL7=$(node -e "console.log(new Date(Date.now()+5*3600e3).toISOString())")
cat > "$SMOKE_TMP"/whl-notify.json <<JSON
{"title": "通知验证局", "deadline": "$DL7", "rewardCap": 1000, "openNow": true,
 "matches": [{"home": "甲队", "away": "乙队", "items": [{"type": "score", "tiers": {"score": 300, "goals": 100, "wdl": 50}}]}]}
JSON
EID7=$(curl -sf -b "$J" -X POST "$BASE/api/admin/events" -H 'Content-Type: application/json' -d @"$SMOKE_TMP"/whl-notify.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).eventId))")
ok "eventId=$EID7（5 小时后截止）"
ROWS7=$(d1q "SELECT kind, content FROM report WHERE event_id = $EID7")
STATE7=$(d1q "SELECT reminded_at FROM event WHERE id = $EID7")
R0=$(curl -sf -X POST "$BASE/api/internal/remind" -H "X-Cron-Key: $CRON")
ok "默认窗口扫描：$R0"
R1=$(curl -sf -X POST "$BASE/api/internal/remind?ahead=360" -H "X-Cron-Key: $CRON")   # 临时把提前量放到 6 小时，模拟到点
ok "提前量放到 6 小时的扫描：$R1"
ROWS7B=$(d1q "SELECT kind, content FROM report WHERE event_id = $EID7")
R2=$(curl -sf -X POST "$BASE/api/internal/remind?ahead=360" -H "X-Cron-Key: $CRON")
ok "重复扫描：$R2"
# 3 小时后截止：开放时就把 reminded_at 填了，不该再收到提醒（否则刚开放紧跟一条）
DL7B=$(node -e "console.log(new Date(Date.now()+3*3600e3).toISOString())")
cat > "$SMOKE_TMP"/whl-notify2.json <<JSON
{"title": "短窗护栏局", "deadline": "$DL7B", "rewardCap": 1000, "openNow": true,
 "matches": [{"home": "丙队", "away": "丁队", "items": [{"type": "wdl", "tiers": {"wdl": 50}}]}]}
JSON
EID7B=$(curl -sf -b "$J" -X POST "$BASE/api/admin/events" -H 'Content-Type: application/json' -d @"$SMOKE_TMP"/whl-notify2.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).eventId))")
R3=$(curl -sf -X POST "$BASE/api/internal/remind?ahead=240" -H "X-Cron-Key: $CRON")
ROWS7C=$(d1q "SELECT kind, content FROM report WHERE event_id = $EID7B")
STATE7B=$(d1q "SELECT reminded_at FROM event WHERE id = $EID7B")
node -e '
  const [rows, state, rowsB, r0, r1, r2, rowsC, stateB, r3] = process.argv.slice(1);
  const j = (s) => JSON.parse(s);
  const assert = (c, m) => { if (!c) { console.error("  ✗ " + m); process.exit(1); } console.log("  ✓ " + m); };
  const a = j(rows), b = j(rowsB), c = j(rowsC);
  const open = a.find((r) => r.kind === "open");
  assert(a.length === 1 && !!open, `开放时只入队 1 条通知（实得 ${a.map((r) => r.kind).join("/")}）`);
  assert(open.content.includes("🎯 新竞猜开放《通知验证局》"), "开放通知有标题");
  assert(open.content.includes("共 1 场比赛"), "开放通知写了场次数");
  assert(open.content.includes("最高可得 300 分"), `开放通知写了真实满分 300（实得 ${JSON.stringify(open.content)}）`);
  assert(open.content.includes("截止") && open.content.includes("https://guess.whleague.win"), "开放通知写了截止时间与填预测入口");
  assert(j(state)[0].reminded_at === null, "5 小时后的局提醒标记仍为空（等扫描）");
  assert(j(r0).sent === 0, `默认 4 小时窗口扫不到它（实得 sent=${j(r0).sent}）`);
  assert(j(r1).sent === 1, `进入窗口后发出 1 条提醒（实得 sent=${j(r1).sent}）`);
  const remind = b.find((r) => r.kind === "remind");
  assert(!!remind, "提醒进了 report 队列");
  assert(remind.content.includes("⏰ 《通知验证局》还有约 5 小时截止"), "提醒写了剩余时间");
  assert(remind.content.includes("已有 0 人提交"), "提醒报了当前提交人数");
  assert(b.length === 2, `该竞猜共 2 条通知（开放 + 提醒，实得 ${b.length}）`);
  assert(j(r2).sent === 0, `重复扫描不重复提醒（实得 sent=${j(r2).sent}）`);
  assert(c.filter((r) => r.kind === "remind").length === 0, "短窗局不发提醒（开放时就填了标记）");
  assert(c.some((r) => r.kind === "open"), "短窗局仍有开放通知");
  assert(j(stateB)[0].reminded_at !== null, "短窗局的提醒标记在开放时即填上（护栏）");
  assert(j(r3).sent === 0, `短窗局扫描时不重复发（实得 sent=${j(r3).sent}）`);
' "$ROWS7" "$STATE7" "$ROWS7B" "$R0" "$R1" "$R2" "$ROWS7C" "$STATE7B" "$R3"

say "18. 到点自动截止（cron seal）：过期 open 单被扫成 sealed，两道提交闸门各拦一次"
# 建单要求截止在未来，所以用「+2 秒后截止」：睡 3 秒让它过期，再触发扫描
DL8=$(node -e "console.log(new Date(Date.now()+2e3).toISOString())")
cat > "$SMOKE_TMP"/whl-autoseal.json <<JSON
{"title": "自动截止验证局", "deadline": "$DL8", "rewardCap": 1000, "openNow": true,
 "matches": [{"home": "戊队", "away": "己队", "items": [{"type": "wdl", "tiers": {"wdl": 50}}]}]}
JSON
EID8=$(curl -sf -b "$J" -X POST "$BASE/api/admin/events" -H 'Content-Type: application/json' -d @"$SMOKE_TMP"/whl-autoseal.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).eventId))")
ITEM8=$(curl -sf -b "$U1" "$BASE/api/events/$EID8" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).items[0].id))")
sleep 3
REJ1=$(curl -s -b "$U1" -X PUT "$BASE/api/events/$EID8/predictions" -H 'Content-Type: application/json' -d "{\"preds\":[{\"itemId\":$ITEM8,\"content\":\"home\"}]}")
ok "status 未收敛时 deadline 闸门先拦：$REJ1"
SEAL8=$(curl -sf -X POST "$BASE/api/internal/seal" -H "X-Cron-Key: $CRON")
ok "触发自动截止扫描：$SEAL8"
ST8=$(d1q "SELECT status FROM event WHERE id = $EID8")
REJ2=$(curl -s -b "$U1" -X PUT "$BASE/api/events/$EID8/predictions" -H 'Content-Type: application/json' -d "{\"preds\":[{\"itemId\":$ITEM8,\"content\":\"home\"}]}")
REM8=$(curl -sf -X POST "$BASE/api/internal/remind" -H "X-Cron-Key: $CRON")
node -e '
  const [st, rej1, rej2, rem] = process.argv.slice(1);
  const assert = (c, m) => { if (!c) { console.error("  ✗ " + m); process.exit(1); } console.log("  ✓ " + m); };
  assert(JSON.parse(st)[0].status === "sealed", `过期 open 单被置为 sealed（实得 ${st}）`);
  assert(rej1.includes("已过提交截止时间"), "status 未收敛时 deadline 闸门也拦得住");
  assert(rej2.includes("本次竞猜不在提交时段"), "sealed 后走 status 闸门");
  assert(JSON.parse(rem).scanned === 0, `已截止单不再进提醒扫描（实得 ${rem}）`);
' "$ST8" "$REJ1" "$REJ2" "$REM8"

echo
echo "✅ 冒烟测试跑完，请人工核对上方各步骤返回与期望值"
