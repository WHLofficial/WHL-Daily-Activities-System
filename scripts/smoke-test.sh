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
J=/tmp/whl-admin.jar; U1=/tmp/whl-u1.jar; U2=/tmp/whl-u2.jar; U3=/tmp/whl-u3.jar
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
ok "sm1 本地镜像 id=$U1ID"
ok "重复昵称注册应被拒（409）："
curl -s -X POST "$BASE/api/register" -H 'Content-Type: application/json' -d '{"name":"sm1","password":"pass9999"}'; echo
ok "弱密码注册应被拒（400）："
curl -s -X POST "$BASE/api/register" -H 'Content-Type: application/json' -d '{"name":"sm9","password":"pass111"}'; echo

say "3. 创建竞猜（1 场 4 项，立即开放）"
DEADLINE=$(node -e "console.log(new Date(Date.now()+3600e3).toISOString())")
# 含中文的请求体一律走文件：Windows 的 curl.exe 会用本地代码页解码命令行参数，直接 -d 传中文会变乱码
cat > /tmp/whl-create.json <<JSON
{
  "title": "英超第3轮", "deadline": "$DEADLINE", "rewardCap": 1000, "openNow": true,
  "matches": [{"home": "阿森纳", "away": "切尔西", "items": [
    {"type": "score", "tiers": {"score": 300, "goals": 100, "wdl": 50}},
    {"type": "wdl", "tiers": {"wdl": 50}},
    {"type": "goals", "tiers": {"goals": 100}},
    {"type": "fun", "question": "谁先进球", "tiers": {"fun": 80}}
  ]}]
}
JSON
CREATE=$(curl -sf -b "$J" -X POST "$BASE/api/admin/events" -H 'Content-Type: application/json' -d @/tmp/whl-create.json)
echo "$CREATE"
EID=$(echo "$CREATE" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).eventId))")
ok "eventId=$EID"
# 玩法项与场次 id 必须从刚建的竞猜里取：本地库 AUTOINCREMENT 会累积，写死 1-4 只对全新库成立
IDS=$(curl -sf -b "$J" "$BASE/api/events/$EID" | node -e "
  let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    const d=JSON.parse(s); const byType={};
    for(const i of d.items) byType[i.type]=i.id;
    console.log([byType.score,byType.wdl,byType.goals,byType.fun,(d.matches[0]||{}).id].join(' '));
  })")
P_SCORE=$(echo "$IDS" | cut -d' ' -f1); P_WDL=$(echo "$IDS" | cut -d' ' -f2)
P_GOALS=$(echo "$IDS" | cut -d' ' -f3); P_FUN=$(echo "$IDS" | cut -d' ' -f4); MID=$(echo "$IDS" | cut -d' ' -f5)
ok "比分=$P_SCORE 胜平负=$P_WDL 总进球=$P_GOALS 趣味=$P_FUN 场次=$MID"

say "4. 生成绑定码 + HMAC 回调绑定（sm1→QQ10001, sm2→QQ10002, sm3 故意不绑）"
C1=$(curl -sf -b "$U1" -X POST "$BASE/api/bind/new" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).code))")
C2=$(curl -sf -b "$U2" -X POST "$BASE/api/bind/new" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).code))")
claim "$C1" 10001
claim "$C2" 10002
ok "错误码验证：重放同一码应被拒"
claim "$C1" 99999 || true

say "5. 提交预测（玩法项 id 由本次竞猜动态取出）"
cat > /tmp/whl-p1.json <<JSON
{"predictions":[{"playItemId":$P_SCORE,"content":{"home":2,"away":1}},{"playItemId":$P_WDL,"content":"home"},{"playItemId":$P_GOALS,"content":3},{"playItemId":$P_FUN,"content":"萨卡"}]}
JSON
curl -sf -b "$U1" -X PUT "$BASE/api/events/$EID/predictions" -H 'Content-Type: application/json' -d @/tmp/whl-p1.json; echo
curl -sf -b "$U2" -X PUT "$BASE/api/events/$EID/predictions" -H 'Content-Type: application/json' \
  -d "{\"predictions\":[{\"playItemId\":$P_SCORE,\"content\":{\"home\":3,\"away\":0}},{\"playItemId\":$P_WDL,\"content\":\"home\"},{\"playItemId\":$P_GOALS,\"content\":2}]}"; echo
ok "sm3 未绑定 QQ，提交应被拒（403 need_binding）："
curl -s -b "$U3" -X PUT "$BASE/api/events/$EID/predictions" -H 'Content-Type: application/json' \
  -d "{\"predictions\":[{\"playItemId\":$P_SCORE,\"content\":{\"home\":2,\"away\":1}}]}"; echo

say "6. 提前截止 → 录比分 2:1 + 趣味题命中 sm1（本地 id $U1ID）"
curl -sf -b "$J" -X POST "$BASE/api/admin/events/$EID/seal"; echo
curl -sf -b "$J" -X POST "$BASE/api/admin/events/$EID/result" -H 'Content-Type: application/json' \
  -d "{\"results\":[{\"matchId\":$MID,\"home\":2,\"away\":1}],\"fun\":[{\"itemId\":$P_FUN,\"hits\":[$U1ID]}]}"; echo
ok "期望：sm1=300+50+100+80=530；sm2=100+50=150；sm3 未绑定不能参与（总计 680）"

say "7. 确认发奖（SYNC_BASE_URL 指向 mock → 直接 credited；不可达时则 unknown 进重试队列）"
curl -sf -b "$J" -X POST "$BASE/api/admin/events/$EID/confirm" -H 'Content-Type: application/json' -d '{"overrideCap":false}'; echo

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

echo
echo "✅ 冒烟测试跑完，请人工核对上方各步骤返回与期望值"
