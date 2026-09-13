// 一次性迁移：guess.user_binding → auth.identity（auth 项目 PRD P0-8，TECH_DESIGN §9 步骤②）。
//
// 背景：绑定真源迁到认证中心 identity 表（provider='qq'）。本脚本从竞猜库读出存量绑定，
// 生成可直接灌入 auth 库的 SQL。注意 user_binding.user_id 锚在本地镜像 users.id，
// 必须经 users.tour_id 折算成 auth 的账号 id（过渡期 = tour user.id）。
//
// 用法：
//   node scripts/migrate-user-binding-to-auth.mjs           # 读本地库（联调预演）
//   node scripts/migrate-user-binding-to-auth.mjs --remote  # 读线上竞猜库（正式切换）
//
// 正式切换步骤（TECH_DESIGN §9 步骤②切 guess 当天）：
//   1) 本脚本 --remote 跑一遍，把输出的 SQL 用
//      `npx wrangler d1 execute whl-auth --remote --command "$SQL"` 灌入 auth 库
//   2) 核对脚本末尾附的对账 SQL 两侧计数一致
//   3) 插件配置 bind_claim_url + bind_secret，guess 开 OIDC_* 环境变量
// 脚本可重复执行：INSERT ... ON CONFLICT DO NOTHING，重复灌入不产生重复行。
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const remote = process.argv.includes('--remote');
const cwd = fileURLToPath(new URL('../', import.meta.url));

function d1Json(db, sql) {
  const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
  const out = execFileSync(
    process.execPath,
    [wrangler, 'd1', 'execute', db, '--json', remote ? '--remote' : '--local', '--command', sql],
    { cwd, encoding: 'utf8' },
  );
  // wrangler 偶发在 JSON 前后带非 JSON 行，取最后一个 '[' 起
  return JSON.parse(out.slice(out.indexOf('[')));
}

const rows = d1Json(
  'whl-guess',
  `SELECT u.tour_id, b.qq_id, b.bound_at FROM user_binding b JOIN users u ON u.id = b.user_id
    WHERE u.tour_id IS NOT NULL ORDER BY u.tour_id`,
)[0]?.results ?? [];
const orphan = d1Json(
  'whl-guess',
  `SELECT COUNT(*) AS n FROM user_binding b JOIN users u ON u.id = b.user_id WHERE u.tour_id IS NULL`,
)[0]?.results?.[0]?.n ?? 0;

if (orphan > 0) console.error(`⚠ ${orphan} 行绑定缺 tour_id 锚点（users 镜像不全），已跳过，请人工核对`);
if (rows.length === 0) {
  console.log('竞猜库没有存量绑定，无需迁移。');
  process.exit(0);
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

// stdout 只输出一行可执行 SQL（Windows 下 wrangler --command 传多行会被截断，
// 与 seed 脚本同一约定）；说明与对账语句全走 stderr
console.error(`共 ${rows.length} 行待迁移${orphan ? `，另有 ${orphan} 行缺 tour_id 已跳过` : ''}。`);
console.error('灌入 auth 库：  SQL=$(node scripts/migrate-user-binding-to-auth.mjs [--remote]) && npx wrangler d1 execute whl-auth --command "$SQL"   （读线上库时加 --remote，灌线上 auth 库时 d1 execute 加 --remote）');
console.error('对账（两侧计数应一致）：auth 库 SELECT COUNT(*) FROM identity WHERE provider=\'qq\';  竞猜库 SELECT COUNT(*) FROM user_binding;');
console.log(stmts.join(' '));
