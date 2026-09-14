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
// 正式切换步骤（TECH_DESIGN §9 步骤②切 guess 当天）——顺序不可颠倒，1、2 未完成禁止做 3：
//   1) 本脚本 --remote 跑一遍，把输出的 SQL 用
//      `npx wrangler d1 execute whl-auth --remote --command "$SQL"` 灌入 auth 库
//   2) 对账：auth identity 行数必须等于竞猜 user_binding 行数（对账 SQL 见脚本末尾），不一致先查清
//   3) 插件配置 bind_claim_url + bind_secret，guess 开 OIDC_* 环境变量
// 为什么必须先迁移：guess 登录时拿 /userinfo 的 qq 覆盖本地绑定（src/_lib/oidc.ts 的 mirrorBinding），
// 真源为空时 qq=null 会被当成「用户已解绑」而 DELETE 掉本地行。2026-09-14 生产踩过：
// identity 为空时切了 OIDC，WH 自己的绑定被自己的一次登录删掉（已回填恢复）。
// 脚本可重复执行：INSERT ... WHERE NOT EXISTS（双向唯一），重复灌入不产生重复行。
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
// 竞猜库 bound_at 是 SQLite datetime('now') 的 "YYYY-MM-DD HH:MM:SS"（UTC），auth 侧统一存
// nowIso() 的 ISO8601，转一下让绑定页显示与后续新绑定同口径
const iso = (s) => {
  const t = String(s);
  return t.includes('T') ? t : `${t.replace(' ', 'T')}Z`;
};

// 双向唯一：auth 的 UNIQUE 只覆盖 (provider, provider_uid)，同一账号在中心改绑过就会留下第二行，
// 所以该 QQ 或该账号任一侧已存在时整行跳过（WHERE NOT EXISTS 覆盖两个轴，也让脚本可重复执行）。
const stmts = [];
let skipped = 0;
for (const r of rows) {
  const id = Number(r.tour_id);
  if (!Number.isInteger(id)) {
    skipped += 1;
    continue;
  }
  const qq = q(r.qq_id);
  const ts = q(iso(r.bound_at));
  stmts.push(
    `INSERT INTO identity (account_id, provider, provider_uid, verified_at, bound_at) SELECT ${id}, 'qq', ${qq}, ${ts}, ${ts} WHERE NOT EXISTS (SELECT 1 FROM identity WHERE provider = 'qq' AND (provider_uid = ${qq} OR account_id = ${id}));`,
  );
}
if (skipped > 0) console.error(`⚠ ${skipped} 行 tour_id 非整数，已跳过，请人工核对`);

// stdout 只输出一行可执行 SQL（Windows 下 wrangler --command 传多行会被截断，
// 与 seed 脚本同一约定）；说明与对账语句全走 stderr
console.error(`共 ${rows.length} 行待迁移${orphan ? `，另有 ${orphan} 行缺 tour_id 已跳过` : ''}。`);
console.error('灌入 auth 库：  SQL=$(node scripts/migrate-user-binding-to-auth.mjs [--remote]) && npx wrangler d1 execute whl-auth --command "$SQL"   （读线上库时加 --remote，灌线上 auth 库时 d1 execute 加 --remote）');
console.error('对账（两侧计数应一致）：auth 库 SELECT COUNT(*) FROM identity WHERE provider=\'qq\';  竞猜库 SELECT COUNT(*) FROM user_binding;');
console.log(stmts.join(' '));
