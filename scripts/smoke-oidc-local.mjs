// 双服务本地联调冒烟（统一认证迁移步骤②，auth 项目 PRD P0-6）：
//   guess 8796（OIDC 模式，dev:oidc）× auth 8792（真认证中心，非 mock）。
// 全链路手推浏览器跳转（redirect: manual + 手写 cookie jar）：
//   guess 发起 authorize → auth 登录 → 回跳建 guess 会话 → /api/me 认人（含本地镜像）
//   → auth 主动登出推 back-channel 吊销 guess 会话 → guess RP 登出走 end_session
//   → 旧入口（login/register/password）确认 302 移交认证中心。
// 前置（顺序重要）：
//   1) auth 项目：种子用户与 guess client（node scripts/seed-local-users.mjs /
//      seed-local-oidc.mjs 的 SQL 灌入本地库），并起 wrangler dev --port 8792
//   2) guess 项目：npm run db:migrate:local；本地 TOUR_DB（whl 库）需有
//      id=6/7 的 user 行（oidctest4/oidctest5，与 auth 本地账号同 id）——
//      必须在 dev 启动【前】执行 d1 execute（dev 运行中会锁库）；然后起 npm run dev:oidc
// 注意：auth 登录限流 5 次/15 分钟/账号（成功也计数），脚本开头顺手清掉
// auth 本地 RL_KV 的限流键（跨项目调用 wrangler，失败只提示不阻断）。
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const AUTH = 'http://127.0.0.1:8792';
const GUESS = 'http://127.0.0.1:8796';
const AUTH_DIR = fileURLToPath(new URL('../../WHL-auth-service/', import.meta.url));

let pass = 0;
const fails = [];
function ok(cond, label, extra = '') {
  if (cond) pass++;
  else fails.push(label);
  console.log(`${cond ? '✓' : '✗'} ${label}${cond || !extra ? '' : ` —— ${extra}`}`);
}

// ---- 小件：cookie jar 与手动跟随跳转的请求 ----

class Jar {
  #m = new Map();
  absorb(res) {
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(';')[0];
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const dead = /max-age=0/i.test(line) || /expires=thu, 01 jan 1970/i.test(line);
      if (dead || value === '') this.#m.delete(name);
      else this.#m.set(name, value);
    }
  }
  header() {
    return [...this.#m].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

async function req(jar, url, { method = 'GET', form } = {}) {
  const res = await fetch(url, {
    method,
    redirect: 'manual',
    headers: {
      ...(jar?.header() ? { cookie: jar.header() } : {}),
      ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? new URLSearchParams(form) : undefined,
  });
  if (jar) jar.absorb(res);
  return res;
}

// auth 本地限流键清理（跨项目 best-effort，失败只提示）
function clearAuthRlKeys() {
  try {
    const wrangler = fileURLToPath(new URL('../../WHL-auth-service/node_modules/wrangler/bin/wrangler.js', import.meta.url));
    const out = execFileSync(
      process.execPath,
      [wrangler, 'kv', 'key', 'list', '--binding', 'RL_KV', '--local'],
      { cwd: AUTH_DIR, encoding: 'utf8' },
    );
    const names = JSON.parse(out)
      .map((k) => k.name)
      .filter((n) => n.startsWith('rl:login-name:') || n.startsWith('rl:pwd:'));
    if (!names.length) return;
    const file = `${tmpdir()}/rl-clear-${Date.now()}.json`;
    writeFileSync(file, JSON.stringify(names));
    execFileSync(
      process.execPath,
      [wrangler, 'kv', 'bulk', 'delete', file, '--binding', 'RL_KV', '--local', '--force'],
      { cwd: AUTH_DIR, encoding: 'utf8' },
    );
    console.log(`（已清理 auth 本地限流键 ${names.length} 个）`);
  } catch (err) {
    console.log(`（提示：清理 auth 限流键失败，遇 429 请 15 分钟后重跑：${err.message}）`);
  }
}

// 完整 RP 登录链：guess 发起 → auth 登录 → authorize 回跳 → guess 回调建会话
async function rpLogin({ name, password }) {
  const guessJar = new Jar();
  const authJar = new Jar();

  const start = await req(guessJar, `${GUESS}/api/auth/login`);
  const authzUrl = new URL(start.headers.get('location'));

  const loginPage = await req(authJar, `${AUTH}/login`);
  const csrf = /name="csrf" value="([^"]+)"/.exec(await loginPage.text())?.[1];
  const doLogin = await req(authJar, `${AUTH}/login`, { method: 'POST', form: { csrf, name, password, next: '' } });
  if (doLogin.status !== 303) {
    const why = /class="error">([^<]*)</.exec(await doLogin.text())?.[1] ?? '(无错误文案)';
    throw new Error(`auth 登录没成功：HTTP ${doLogin.status} ${why}`);
  }

  const back = await req(authJar, authzUrl);
  const cbUrl = new URL(back.headers.get('location'), AUTH);

  const cb = await req(guessJar, cbUrl);
  const me = await req(guessJar, `${GUESS}/api/me`);
  return { start, authzUrl, doLogin, back, cbUrl, cb, me };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 冒烟主体 ----

clearAuthRlKeys();

// 0) 服务可达 + 初始态
const me0 = await req(new Jar(), `${GUESS}/api/me`);
const me0Body = await me0.json();
ok(me0Body.user === null && me0Body.authMode === 'oidc' && me0Body.authHome === AUTH, '未登录 /api/me：user=null 且 authMode=oidc/authHome 正确', JSON.stringify(me0Body));

// 1) 用户一（oidctest4）全链路登录
const u1 = await rpLogin({ name: 'oidctest4', password: 'TestPass123' });
ok(u1.start.status === 302 && (new URL(u1.authzUrl)).origin + u1.authzUrl.pathname === `${AUTH}/authorize`, 'guess /auth/login 302 到认证中心 authorize');
ok(u1.authzUrl.searchParams.get('client_id') === 'guess' && u1.authzUrl.searchParams.get('scope') === 'openid', 'client_id=guess，scope=openid');
ok(u1.authzUrl.searchParams.get('code_challenge_method') === 'S256' && /^[A-Za-z0-9_-]{43}$/.test(u1.authzUrl.searchParams.get('code_challenge') ?? ''), 'PKCE S256 challenge（43 位 base64url）');
ok(u1.back.status === 303 && (u1.cbUrl.origin + u1.cbUrl.pathname) === `${GUESS}/api/auth/callback`, 'authorize 303 跳回 guess callback');
ok(u1.cbUrl.searchParams.get('iss') === AUTH && !!u1.cbUrl.searchParams.get('code'), '回跳带 code 与 iss（RFC 9207）');
ok(u1.cb.status === 302 && u1.cb.headers.get('location') === '/', 'guess 回调 302 回首页');
const me1Body = await u1.me.json();
ok(me1Body.authMode === 'oidc' && me1Body.user?.username === 'oidctest4' && me1Body.user?.role === 'admin', '登录后 /api/me 认出 oidctest4（admin）', JSON.stringify(me1Body));

// 2) 用户二（oidctest5）并发登录（独立 cookie jar = 独立浏览器）
const u2 = await rpLogin({ name: 'oidctest5', password: 'TestPass123' });
const me2Body = await u2.me.json();
ok(u2.cb.status === 302 && me2Body.user?.username === 'oidctest5', '第二个会话登录并认出 oidctest5', JSON.stringify(me2Body));

// 3) auth 主动登出（用户二）：back-channel 推送吊销 guess 会话
const authOut = await req(u2.authJar, `${AUTH}/logout`);
ok(authOut.status === 303, 'auth /logout 303（end_session 生效）');
let revoked = false;
for (let i = 0; i < 20 && !revoked; i++) {
  await sleep(400);
  const me = await req(u2.guessJar, `${GUESS}/api/me`);
  revoked = ((await me.json()).user) === null;
}
ok(revoked, 'auth 登出后 back-channel 推送到达 guess，/api/me 变 null（轮询 ≤8s）');

// 4) guess RP 登出（用户一）：本地吊销 + 浏览器跳 auth end_session 回白名单地址
const rpOut = await req(u1.guessJar, `${GUESS}/api/auth/logout`, { method: 'POST' });
ok(rpOut.status === 302, 'guess /auth/logout 302');
const endSession = new URL(rpOut.headers.get('location'));
ok(endSession.origin + endSession.pathname === `${AUTH}/logout` && endSession.searchParams.get('post_logout_redirect_uri') === `${GUESS}/`, '跳 auth end_session 且带回跳白名单地址');
const backHome = await req(u1.authJar, endSession);
ok(backHome.status === 303 && backHome.headers.get('location') === `${GUESS}/`, 'auth 放行白名单回跳 guess 首页');
const meAfter = await req(u1.guessJar, `${GUESS}/api/me`);
ok(((await meAfter.json()).user) === null, 'RP 登出后 /api/me 变 null');

// 5) 旧入口移交：login/register/password 302 到认证中心
const oldLogin = await req(null, `${GUESS}/api/login`, { method: 'POST', form: { username: 'x', password: 'y' } });
ok(oldLogin.status === 302 && oldLogin.headers.get('location') === `${GUESS}/api/auth/login`, 'POST /api/login 302 移交本站 authorize 链');
const oldRegister = await req(null, `${GUESS}/api/register`, { method: 'POST', form: { name: 'x', password: 'y' } });
ok(oldRegister.status === 302 && oldRegister.headers.get('location') === `${AUTH}/register`, 'POST /api/register 302 移交认证中心注册页');
const oldPassword = await req(null, `${GUESS}/api/password`, { method: 'POST', form: { oldPassword: 'x', newPassword: 'y' } });
ok(oldPassword.status === 302 && oldPassword.headers.get('location') === `${AUTH}/password`, 'POST /api/password 302 移交认证中心改密页');

// 6) 负例：伪造 back-channel 通知必须 400
const forged = await req(null, `${GUESS}/api/auth/backchannel-logout`, { method: 'POST', form: { logout_token: 'not-a-jwt' } });
ok(forged.status === 400, '伪造 logout_token 被 guess 拒绝（400）');

console.log(`\n${fails.length ? `❌ ${fails.length} 项未过 / ` : ''}✅ ${pass} 项断言全过`);
process.exit(fails.length ? 1 : 0);

// 占位（防引用错误）：rpLogin 返回的 jar 直接挂到返回对象上
function u1JarHack() { return u1.guessJar; }
function u2JarHack() { return u2.guessJar; }
