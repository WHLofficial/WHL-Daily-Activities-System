#!/usr/bin/env bash
# WHL 竞猜系统 本地冒烟测试
# 前置：全新本地库（npx wrangler d1 migrations apply whl-guess --local）
#       dev 服务已起（npx wrangler pages dev public，.dev.vars 提供测试密钥）
# 验证：建号→开盘→HMAC 绑定→提交预测→截止→录结果→结算→确认发奖（发往不可达地址→unknown）→cron 重试→对账
set -e
BASE="http://127.0.0.1:8789"
SECRET="${SYNC_SECRET:-testsecret}"
TOKEN="${SETUP_TOKEN:-testtoken}"
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

say "0. /api/me 未登录"
curl -sf "$BASE/api/me"; echo

say "1. setup 管理员"
curl -sf -c "$J" -X POST "$BASE/api/setup" -H 'Content-Type: application/json' \
  -d "{\"setupToken\":\"$TOKEN\",\"username\":\"boss\",\"password\":\"secret123\",\"displayName\":\"老板\"}"; echo
curl -sf -b "$J" "$BASE/api/me" | head -c 200; echo

say "2. 创建三个群友账号"
curl -sf -b "$J" -X POST "$BASE/api/admin/users" -H 'Content-Type: application/json' -d '{"username":"u1","password":"pass111","displayName":"小张"}'; echo
curl -sf -b "$J" -X POST "$BASE/api/admin/users" -H 'Content-Type: application/json' -d '{"username":"u2","password":"pass222","displayName":"小李"}'; echo
curl -sf -b "$J" -X POST "$BASE/api/admin/users" -H 'Content-Type: application/json' -d '{"username":"u3","password":"pass333","displayName":"小王"}'; echo

say "3. 登录三个群友"
curl -sf -c "$U1" -X POST "$BASE/api/login" -H 'Content-Type: application/json' -d '{"username":"u1","password":"pass111"}'; echo
curl -sf -c "$U2" -X POST "$BASE/api/login" -H 'Content-Type: application/json' -d '{"username":"u2","password":"pass222"}'; echo
curl -sf -c "$U3" -X POST "$BASE/api/login" -H 'Content-Type: application/json' -d '{"username":"u3","password":"pass333"}'; echo

say "4. 创建竞猜期（1 场 4 项，立即开放）"
DEADLINE=$(node -e "console.log(new Date(Date.now()+3600e3).toISOString())")
CREATE=$(curl -sf -b "$J" -X POST "$BASE/api/admin/events" -H 'Content-Type: application/json' -d "{
  \"title\":\"英超第3轮\", \"deadline\":\"$DEADLINE\", \"rewardCap\":1000, \"openNow\":true,
  \"matches\":[{\"home\":\"阿森纳\",\"away\":\"切尔西\",\"items\":[
    {\"type\":\"score\",\"tiers\":{\"score\":300,\"goals\":100,\"wdl\":50}},
    {\"type\":\"wdl\",\"tiers\":{\"wdl\":50}},
    {\"type\":\"goals\",\"tiers\":{\"goals\":100}},
    {\"type\":\"fun\",\"question\":\"谁先进球\",\"tiers\":{\"fun\":80}}
  ]}]}")
echo "$CREATE"
EID=$(echo "$CREATE" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).eventId))")
ok "eventId=$EID"

say "5. 生成绑定码 + HMAC 回调绑定（u1→QQ10001, u2→QQ10002, u3 故意不绑）"
C1=$(curl -sf -b "$U1" -X POST "$BASE/api/bind/new" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).code))")
C2=$(curl -sf -b "$U2" -X POST "$BASE/api/bind/new" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).code))")
claim "$C1" 10001
claim "$C2" 10002
ok "错误码验证：重放同一码应被拒"
claim "$C1" 99999 || true

say "6. 提交预测（玩法项 id：1=比分 2=胜平负 3=总进球 4=趣味）"
curl -sf -b "$U1" -X PUT "$BASE/api/events/$EID/predictions" -H 'Content-Type: application/json' \
  -d '{"predictions":[{"playItemId":1,"content":{"home":2,"away":1}},{"playItemId":2,"content":"home"},{"playItemId":3,"content":3},{"playItemId":4,"content":"萨卡"}]}'; echo
curl -sf -b "$U2" -X PUT "$BASE/api/events/$EID/predictions" -H 'Content-Type: application/json' \
  -d '{"predictions":[{"playItemId":1,"content":{"home":3,"away":0}},{"playItemId":2,"content":"home"},{"playItemId":3,"content":2}]}'; echo
ok "u3 未绑定 QQ，提交应被拒（403 need_binding）："
curl -s -b "$U3" -X PUT "$BASE/api/events/$EID/predictions" -H 'Content-Type: application/json' \
  -d '{"predictions":[{"playItemId":1,"content":{"home":2,"away":1}}]}'; echo

say "7. 提前截止 → 录比分 2:1 + 趣味题命中 u1"
curl -sf -b "$J" -X POST "$BASE/api/admin/events/$EID/seal"; echo
curl -sf -b "$J" -X POST "$BASE/api/admin/events/$EID/result" -H 'Content-Type: application/json' \
  -d "{\"results\":[{\"matchId\":1,\"home\":2,\"away\":1}],\"fun\":[{\"itemId\":4,\"hits\":[2]}]}"; echo
ok "期望：u1=300+50+100+80=530；u2=100+50=150；u3 未绑定不能参与（总计 680）"

say "8. 确认发奖（SYNC_BASE_URL 指向 mock → 直接 credited；不可达时则 unknown 进重试队列）"
curl -sf -b "$J" -X POST "$BASE/api/admin/events/$EID/confirm" -H 'Content-Type: application/json' -d '{"overrideCap":false}'; echo

say "9. cron 重试通道"
curl -sf -X POST "$BASE/api/internal/retry" -H "X-Cron-Key: $CRON"; echo
ok "cron key 错误应被拒："
curl -s -X POST "$BASE/api/internal/retry" -H "X-Cron-Key: wrong" ; echo

say "10. 每日对账（插件不可达 → error 记录）"
curl -sf -X POST "$BASE/api/internal/recon" -H "X-Cron-Key: $CRON"; echo
curl -sf -b "$J" "$BASE/api/admin/recon"; echo

say "11. 战报待发队列（插件将拉取的内容）"
node -e '
    const crypto=require("crypto");
    const [secret,base]=process.argv.slice(1);
    const ts=Math.floor(Date.now()/1000);
    const sign=crypto.createHmac("sha256",secret).update(`GET|/api/reports/pending|${ts}|`).digest("hex");
    fetch(base+"/api/reports/pending",{headers:{"X-Timestamp":String(ts),"X-Sign":sign}}).then(r=>r.text()).then(t=>console.log(t));
  ' "$SECRET" "$BASE"

say "12. 数据库核对（发放项/流水镜像/同步日志）"
npx wrangler d1 execute whl-guess --local --command \
  "SELECT display_name, pi.qq_id, pi.amount, pi.status, pi.retry_count FROM payout_item pi JOIN users u ON u.id=pi.user_id" --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s)[0].results)))"
npx wrangler d1 execute whl-guess --local --command "SELECT payout_id, qq_id, amount, type FROM ledger_mirror" --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s)[0].results)))"
npx wrangler d1 execute whl-guess --local --command "SELECT attempt, outcome, substr(detail,1,60) AS detail FROM sync_log" --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s)[0].results)))"

echo
echo "✅ 冒烟测试跑完，请人工核对上方各步骤返回与期望值"
