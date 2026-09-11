#!/usr/bin/env bash
# WHL 竞猜系统 本地冒烟测试（共享账号池版：注册/登录走赛事库）
# 前置（顺序重要）：
#   a) 竞猜库全新：npx wrangler d1 migrations apply whl-guess --local
#   b) 赛事本地库播种（必须在 dev 启动【前】执行——dev 运行中跑 d1 execute 会锁库静默失败）：
#      npx wrangler d1 execute whl --local --command "INSERT INTO organization (id,name,allow_open_reg) VALUES (1,'WHL',1) ON CONFLICT(id) DO UPDATE SET allow_open_reg=1"
#      npx wrangler d1 execute whl --local --command "INSERT OR IGNORE INTO user (name,password_hash,role) VALUES ('smboss','$(node scripts/gen-tour-hash.mjs secret123)','admin')"
#   c) dev 服务已起（npx wrangler dev --port 8789，.dev.vars 提供测试密钥）
# 验证：播种→注册（自动登录）→验密登录→开放竞猜→HMAC 绑定→提交预测→截止→录结果→结算→确认发奖（发往不可达地址→unknown）→cron 重试→对账
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

say "7. 确认发奖（SYNC_BASE_URL 指向 mock → 直接 credited；不可达时则 unknown 进重试队列）"
curl -sf -b "$J" -X POST "$BASE/api/admin/events/$EID/confirm" -H 'Content-Type: application/json' -d '{"overrideCap":false}'; echo

say "7b. 重复确认发奖（幂等：第二次走 alreadyConfirmed，不新建批次）"
SECOND=$(curl -sf -b "$J" -X POST "$BASE/api/admin/events/$EID/confirm" -H 'Content-Type: application/json' -d '{"overrideCap":false}')
echo "$SECOND"
BID=$(curl -sf -b "$J" "$BASE/api/admin/events/$EID" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log((JSON.parse(s).batch||{}).id))")
curl -sf -b "$J" "$BASE/api/admin/batches/$BID" > "$SMOKE_TMP"/whl-batch.json
node -e '
  const fs = require("fs");
  const second = JSON.parse(process.argv[1]);
  const b = JSON.parse(fs.readFileSync(process.env.SMOKE_TMP + "/whl-batch.json", "utf8"));
  const assert = (cond, msg) => { if (!cond) { console.error("  ✗ " + msg); process.exit(1); } console.log("  ✓ " + msg); };
  assert(second.alreadyConfirmed === true, "第二次确认返回 alreadyConfirmed");
  assert(Number(second.batchId) === Number(b.batch.id), `两次确认指向同一批次 #${b.batch.id}`);
  assert(b.items.length === 2, `批次仍是 2 笔（未重复建项，实得 ${b.items.length}）`);
  assert(b.items.every(i => i.status === "credited"), `2 笔均到账（实得 ${b.items.map(i => i.status).join("/")}）`);
' "$SECOND"

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
node -e '
    const crypto=require("crypto");
    const [secret,base]=process.argv.slice(1);
    const ts=Math.floor(Date.now()/1000);
    const sign=crypto.createHmac("sha256",secret).update(`GET|/api/reports/pending|${ts}|`).digest("hex");
    fetch(base+"/api/reports/pending",{headers:{"X-Timestamp":String(ts),"X-Sign":sign}}).then(r=>r.text()).then(t=>{
      const rs=JSON.parse(t).reports||[];
      const hit=rs.find(r=>r.content.includes("猜胜负"));
      const assert=(cond,msg)=>{if(!cond){console.error("  ✗ "+msg);process.exit(1);}console.log("  ✓ "+msg);};
      assert(!!hit, "待发战报里有猜胜负那一次的");
      if (hit) {
        console.log("--- 战报片段 ---");
        console.log(hit.content);
        assert(hit.content.includes("🎯 猜胜负"), "战报含「🎯 猜胜负」独立段");
        assert(hit.content.includes("胜负中 2 场") && hit.content.includes("sm1"), "战报标出「胜负中 2 场」与中奖人");
      }
    });
  ' "$SECRET" "$BASE"

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
node -e '
  const crypto=require("crypto");
  const [secret,base]=process.argv.slice(1);
  const ts=Math.floor(Date.now()/1000);
  const sign=crypto.createHmac("sha256",secret).update(`GET|/api/reports/pending|${ts}|`).digest("hex");
  fetch(base+"/api/reports/pending",{headers:{"X-Timestamp":String(ts),"X-Sign":sign}}).then(r=>r.text()).then(t=>{
    const rs=JSON.parse(t).reports||[];
    const hit=rs.find(r=>r.content.includes("pure wdl 10 matches"));
    const assert=(cond,msg)=>{if(!cond){console.error("  ✗ "+msg);process.exit(1);}console.log("  ✓ "+msg);};
    assert(!!hit, "待发战报里有 10 场纯猜胜负那一次的");
    if (hit) {
      assert(hit.content.includes("🎯 猜胜负"), "战报含「🎯 猜胜负」独立段");
      assert(hit.content.includes("胜负中 4 场") && hit.content.includes("（+300）"), "标出「胜负中 4 场 （+300）」");
      assert(hit.content.includes("胜负中 6 场") && hit.content.includes("（+500）"), "标出「胜负中 6 场 （+500）」");
    }
  });
' "$SECRET" "$BASE"

echo
echo "✅ 冒烟测试跑完，请人工核对上方各步骤返回与期望值"
