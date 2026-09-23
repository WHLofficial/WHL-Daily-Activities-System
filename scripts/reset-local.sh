#!/usr/bin/env bash
# 本地环境复位：停进程 → 清空竞猜本地库业务数据 → 重播赛事本地库的冒烟账号 → 清 SESSION_KV
# 冒烟测试前必须先跑这个，否则会撞上：
#   登录 429「尝试太频繁」（限流计数在 SESSION_KV，跨 dev 重启留存）
#   绑定 400「已绑定 QQ 10001」（竞猜库还留着上一轮的 user_binding）
# 用法：bash scripts/reset-local.sh   然后自行启动 mock-plugin 与 npm run dev
set -u
cd "$(dirname "$0")/.."

# 只停【本仓】起的进程。不能按进程名通配 wrangler|workerd——那会把同机其他仓库
# （WHL-auth-service 的 wrangler dev 就跑在 7415，还带着一整套测试进程）一起杀掉。
# 也不能只按仓库绝对路径过滤：CommandLine 原样保留启动时写的路径，而 mock 插件通常用
# 相对路径启动（node scripts/mock-plugin.js 9991），命令行里没有仓库路径，会漏掉它 →
# 残留实例占住 9991，下一轮插件 EADDRINUSE 秒退，冒烟步 12 读到的日志就是空的。
# 故按三个特征之一匹配：仓库绝对路径 / 本仓 mock 插件脚本 + 端口 / 本仓 dev 端口。
ROOT="$(pwd -W 2>/dev/null || pwd)"
ROOT_WIN="$(cygpath -w "$ROOT" 2>/dev/null || echo "$ROOT")"

echo "== 停止本仓的本地进程（wrangler dev / mock-plugin / workerd）=="
# 注意 PowerShell 的数组字面量必须用逗号分隔：@(1 2 3) 是语法错误，会静默失败
PID_CSV=$(powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.Name -in @('node.exe','workerd.exe') -and \$_.CommandLine } | ForEach-Object { '{0} {1}' -f \$_.ProcessId, \$_.CommandLine }" 2>/dev/null \
  | tr -d '\r' \
  | grep -F -e "$ROOT_WIN" -e 'scripts/mock-plugin.js 9991' -e '--port 8789' \
  | cut -d' ' -f1 | sort -u | paste -sd, -)
if [ -n "$PID_CSV" ]; then
  echo "   已停止 PID：${PID_CSV//,/ }"
  powershell -NoProfile -Command "foreach (\$p in @($PID_CSV)) { Stop-Process -Id \$p -Force -ErrorAction SilentlyContinue }" >/dev/null 2>&1
else
  echo "   没有本仓进程在跑"
fi
sleep 3

# 顺序按外键依赖从子到父，反过来会撞 FOREIGN KEY constraint failed
TABLES="payout_item payout_batch settlement report prediction play_item match event initiators user_binding bind_codes sessions users sync_log ledger_mirror recon_run settings"
SQL=""
for t in $TABLES; do SQL="$SQL DELETE FROM $t;"; done

echo "== 清空竞猜本地库 whl-guess 的业务数据（保留表结构与 d1_migrations）=="
npx wrangler d1 execute whl-guess --local --command "$SQL" 2>&1 | grep -E '"success"|error' | head -2

echo "== 重播赛事本地库的冒烟账号 sm1-sm3（保留 smboss 与 organization #1）=="
# 兼容模式已无自助注册（POST /api/register 一律 410），群友账号只能先播种赛事库再走 /api/login
# 必须在 dev 启动【前】写：dev 运行中跑 d1 execute 的写操作会锁库静默失败
npx wrangler d1 execute whl --local --command "DELETE FROM user WHERE name LIKE 'sm%' AND name <> 'smboss'" 2>&1 | grep -E '"success"|error' | head -2
SM1_HASH=$(node scripts/gen-tour-hash.mjs pass1111)
SM2_HASH=$(node scripts/gen-tour-hash.mjs pass2222)
SM3_HASH=$(node scripts/gen-tour-hash.mjs pass3333)
npx wrangler d1 execute whl --local --command "INSERT INTO user (name,password_hash,role) VALUES ('sm1','$SM1_HASH','coach'),('sm2','$SM2_HASH','coach'),('sm3','$SM3_HASH','coach')" 2>&1 | grep -E '"success"|error' | head -2

echo "== 清空本地 SESSION_KV（会话与注册/登录限流计数都在这）=="
# Windows 上刚杀掉的 workerd 可能还攥着 sqlite 句柄几秒，rm 会报 Device or resource busy
for _ in 1 2 3; do
  rm -rf .wrangler/state/v3/kv 2>/dev/null
  [ -z "$(ls -A .wrangler/state/v3/kv 2>/dev/null)" ] && break
  sleep 2
done
if [ -n "$(ls -A .wrangler/state/v3/kv 2>/dev/null)" ]; then
  echo "   ⚠ SESSION_KV 没清干净（文件仍被占用）：$(ls -A .wrangler/state/v3/kv | tr '\n' ' ')"
  echo "     残留会让冒烟撞 429 限流；确认本仓 dev/mock 已停后重跑本脚本"
fi
mkdir -p .smoke-tmp
echo
echo "复位完成。接着启动："
echo "  SYNC_SECRET=testsecret node scripts/mock-plugin.js 9991 > .smoke-tmp/mock.log 2>&1"
echo "  npm run dev"
echo "然后：MOCK_LOG=.smoke-tmp/mock.log bash scripts/smoke-test.sh"
