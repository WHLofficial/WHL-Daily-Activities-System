#!/usr/bin/env bash
# 本地环境复位：停进程 → 清空竞猜本地库业务数据 → 清赛事本地库的冒烟账号 → 清 SESSION_KV
# 冒烟测试前必须先跑这个，否则会撞上：
#   注册 409（赛事库还留着 sm1-sm3）
#   绑定 400「已绑定 QQ 10001」（竞猜库还留着上一轮的 user_binding）
#   注册 429「注册太频繁」（限流计数在 SESSION_KV，跨 dev 重启留存）
# 用法：bash scripts/reset-local.sh   然后自行启动 mock-plugin 与 wrangler dev
set -u
cd "$(dirname "$0")/.."

echo "== 停止本地进程（wrangler dev / mock-plugin / workerd）=="
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.Name -in @('node.exe','workerd.exe') -and \$_.CommandLine -match 'wrangler|mock-plugin|workerd' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" >/dev/null 2>&1
sleep 3

# 顺序按外键依赖从子到父，反过来会撞 FOREIGN KEY constraint failed
TABLES="payout_item payout_batch settlement report prediction play_item match event initiators user_binding bind_codes sessions users sync_log ledger_mirror recon_run settings"
SQL=""
for t in $TABLES; do SQL="$SQL DELETE FROM $t;"; done

echo "== 清空竞猜本地库 whl-guess 的业务数据（保留表结构与 d1_migrations）=="
npx wrangler d1 execute whl-guess --local --command "$SQL" 2>&1 | grep -E '"success"|error' | head -2

echo "== 清空赛事本地库的冒烟账号（保留 smboss 与 organization #1）=="
npx wrangler d1 execute whl --local --command "DELETE FROM user WHERE name LIKE 'sm%' AND name <> 'smboss'" 2>&1 | grep -E '"success"|error' | head -2

echo "== 预置「密码被管理员重置」账号 sm4（must_change_pw=1，冒烟步 16 用）=="
# 必须在 dev 启动【前】写：dev 运行中跑 d1 execute 的写操作会锁库静默失败
SM4_HASH=$(node scripts/gen-tour-hash.mjs pass4444)
npx wrangler d1 execute whl --local --command "INSERT OR REPLACE INTO user (name,password_hash,role,locked,must_change_pw) VALUES ('sm4','$SM4_HASH','coach',0,1)" 2>&1 | grep -E '"success"|error' | head -2

echo "== 清空本地 SESSION_KV（会话与注册/登录限流计数都在这）=="
rm -rf .wrangler/state/v3/kv/*
echo
echo "复位完成。接着启动：node scripts/mock-plugin.js 与 npx wrangler dev --port 8789"
