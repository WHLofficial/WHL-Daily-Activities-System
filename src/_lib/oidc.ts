// 统一认证接入（迁移步骤②③，auth 项目 PRD P0-6/P0-10）：OIDC RP 侧小件 + 四端点。
// 与 club 平台同构（__Host- 会话 cookie / PKCE S256 / JWKS 缓存 / back-channel 吊销）；
// 签发侧在 auth 服务，这里只做客户端。配置 OIDC_ISSUER + OIDC_CLIENT_ID 即切换，
// 未配置 = 兼容模式（共享 cookie 透传 + 本地 30 天会话），/api/auth/* 端点按需退化。
// 步骤③收口：回调拉 userinfo 存 claims（角色/权限/状态），判定不再查赛事库 user 表；
// QQ 绑定镜像随回调的 userinfo 快照同步本地 user_binding（绑定全流程搬 auth 属 PRD P0-8）。
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { HttpError } from './http.ts';
// 运行时才引用（函数声明，无模块求值期依赖）：auth.ts 也反向导入本文件，ESM 环安全
import { mirrorClaimsUser, parseOidcClaims } from './auth.ts';

export const OIDC_SESSION_COOKIE = '__Host-guess_session';
// authorize 跳转前的 state/nonce/verifier 中转（10 分钟寿命，登录完成后即删）
export const OIDC_TEMP_COOKIE = '__Host-guess_oidc';
// 静默同步探测（prompt=none，进站即探测）的冷却标记：无会话访客 10 分钟内不重复探测
export const OIDC_PROBE_COOKIE = '__Host-guess_probe';
const PROBE_COOLDOWN_SECONDS = 600;
// 对齐 auth 会话 7 天（TECH_DESIGN §8-6：client 本地会话 ≤ auth 会话；退役旧 30 天口径）
export const SESSION_TTL_SECONDS = 7 * 24 * 3600;
// 兼容模式下若有人点了 OIDC 入口（理论不可达），回赛事系统老路
export const TOUR_HOME = 'https://whleague.win/';

export const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

export function isOidc(env: any): boolean {
  return Boolean(env.OIDC_ISSUER && env.OIDC_CLIENT_ID);
}

function sha256hex(s: string): Promise<string> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)).then((buf) =>
    [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join(''),
  );
}

/** base64url 随机串（32 字节 = 43 字符，也是合法的 PKCE verifier） */
export function randomB64url(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlEncode(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function b64urlDecode(s: string): string {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
}

/** 常数时间字符串比较（state/nonce 校验用） */
export function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** PKCE S256 challenge：base64url(sha256(verifier))，恒 43 字符 */
async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  let bin = '';
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

/** 旧 /api/logout 入口复用：读出当前 OIDC 会话 token（没有则 null） */
export function oidcSessionToken(request: Request): string | null {
  return getCookie(request, OIDC_SESSION_COOKIE);
}

/** 清 __Host-guess_session 的 Set-Cookie 值（旧 /api/logout 的 JSON 响应用） */
export function clearOidcSessionCookie(): string {
  return `${OIDC_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function sessionCookie(token: string): string {
  // __Host- 前缀强制 Secure + 无 Domain + Path=/：兄弟子域撒的 cookie 盖不掉本站会话；
  // 127.0.0.1 属浏览器可信源，本地 http 开发同样能收
  return `${OIDC_SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function redirect(status302: string, ...setCookies: string[]): Response {
  const headers = new Headers({ Location: status302 });
  for (const c of setCookies) headers.append('Set-Cookie', c);
  return new Response(null, { status: 302, headers });
}

/** 进站即探测钩子（index.ts 在静态资源前调用）：匿名 HTML 导航 → 302 /api/auth/sync，
 *  让认证中心里已有的会话无感同步到本站。放行条件（返回 null 走静态资源）：
 *  非 OIDC 模式 / 非 HTML 导航请求（Accept 无 text/html，或路径带扩展名且非 .html）/
 *  已有本站会话 / 在探测冷却期。放行判定保持极轻，静态资源请求零开销。 */
export function silentSyncRedirect(env: any, request: Request, url: URL): Response | null {
  if (!isOidc(env)) return null;
  if (!(request.headers.get('Accept') || '').includes('text/html')) return null;
  const path = url.pathname;
  if (!path.endsWith('.html') && path.includes('.')) return null;
  if (getCookie(request, OIDC_SESSION_COOKIE) || getCookie(request, OIDC_PROBE_COOKIE)) return null;
  return redirect(`/api/auth/sync?back=${encodeURIComponent(path + url.search)}`);
}

// JWKS 客户端按 issuer 缓存（jose 自带刷新冷却与 kid 命中）
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwksFor(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksCache.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/jwks.json`));
    jwksCache.set(issuer, jwks);
  }
  return jwks;
}

// QQ 绑定镜像（P0-8）：绑定真源在 auth 的 identity 表，登录回调用 userinfo 的 qq 快照
// 同步本地 user_binding——预测门槛、发奖批量、对账的 JOIN 全部零改动，兼容模式行为完全
// 等价。登录之后站点外的绑定/解绑变化要等下一次登录才刷进来（OIDC 模式下绑定入口已移交
// 认证中心，前端指引重登刷新）。本地锚点用镜像 users.id（user_binding 既有外键语义）。
// 步骤③收口：userinfo 由回调统一拉取校验后传入（含 claims 所需字段），镜像也从 claims 建立，
// 不再查赛事库 user 表。
async function mirrorBinding(env: any, sub: string, info: { qq?: unknown; name: string; roles: string[] }): Promise<void> {
  try {
    const local = await mirrorClaimsUser(env, sub, info);
    const qq = typeof info.qq === 'string' && info.qq ? info.qq : null;
    if (qq) {
      await env.DB.batch([
        // auth 已保证 QQ 全局唯一；本地镜像若残留同 QQ 挂在别人名下的旧行（迁移前旧数据），
        // 以认证中心为准清掉
        env.DB.prepare('DELETE FROM user_binding WHERE qq_id = ? AND user_id != ?').bind(qq, local.id),
        env.DB.prepare(
          `INSERT INTO user_binding (user_id, qq_id, bound_at) VALUES (?, ?, datetime('now'))
             ON CONFLICT(user_id) DO UPDATE SET qq_id = excluded.qq_id,
               bound_at = CASE WHEN user_binding.qq_id != excluded.qq_id
                               THEN excluded.bound_at ELSE user_binding.bound_at END`,
        ).bind(local.id, qq),
      ]);
    } else {
      await env.DB.prepare('DELETE FROM user_binding WHERE user_id = ?').bind(local.id).run();
    }
  } catch (e: any) {
    console.error('[oidc] binding mirror failed:', e?.message || e);
  }
}

// ---------- 四端点（api.ts 在认证段前分发；不受改密门拦截） ----------

export async function handleOidc(env: any, request: Request, seg: string[], method: string): Promise<Response | null> {
  if (seg[0] !== 'auth') return null;
  const url = new URL(request.url);
  // 回跳地址用请求源推导；wrangler dev 对 custom_domain 路由会把 request.url 重写成
  // http://guess.whleague.win（无端口、http），所以本地联调用 OIDC_REDIRECT_ORIGIN 覆盖——
  // 生产是 https://guess.whleague.win，无需配置
  const origin = env.OIDC_REDIRECT_ORIGIN || url.origin;

/** 只接受站内相对路径，防开放跳转与头部注入（静默探测的回跳地址） */
function safeReturn(v: unknown): string {
  if (typeof v !== 'string' || !v.startsWith('/') || v.startsWith('//') || v.includes('\\') || /[\r\n\t]/.test(v)) return '/';
  return v.slice(0, 512);
}

// 发起登录：PKCE S256 + state/nonce 中转 10 分钟
if (method === 'GET' && seg[1] === 'login' && seg.length === 2) {
    if (!isOidc(env)) return redirect(TOUR_HOME);
    const state = randomB64url(16);
    const nonce = randomB64url(16);
    const verifier = randomB64url(32);
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: env.OIDC_CLIENT_ID,
      redirect_uri: `${origin}/api/auth/callback`,
      scope: 'openid profile', // profile 供 userinfo 下发姓名（角色/权限/状态不按 scope 收费）
      state,
      nonce,
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: 'S256',
    });
    return redirect(`${env.OIDC_ISSUER}/authorize?${q}`, `${OIDC_TEMP_COOKIE}=${b64urlEncode(JSON.stringify({ state, nonce, verifier }))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  }

  // 静默同步探测（进站即探测，auth 支持 prompt=none 后启用）：index.ts 的进站钩子把
  // 匿名 HTML 导航引到这里，带 prompt=none 去 auth——有会话即静默拿码自动登录；
  // 没有则 auth 原路回 error=login_required，callback 分支原样送回来源页继续匿名。
  // 冷却标记 10 分钟，防无会话访客被反复拽去认证中心。
  if (method === 'GET' && seg[1] === 'sync' && seg.length === 2) {
    if (!isOidc(env)) return redirect(TOUR_HOME);
    const state = randomB64url(16);
    const nonce = randomB64url(16);
    const verifier = randomB64url(32);
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: env.OIDC_CLIENT_ID,
      redirect_uri: `${origin}/api/auth/callback`,
      scope: 'openid profile',
      state,
      nonce,
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: 'S256',
      prompt: 'none',
    });
    return redirect(
      `${env.OIDC_ISSUER}/authorize?${q}`,
      `${OIDC_TEMP_COOKIE}=${b64urlEncode(JSON.stringify({ state, nonce, verifier, returnTo: safeReturn(url.searchParams.get('back')) }))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      `${OIDC_PROBE_COOKIE}=1; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${PROBE_COOLDOWN_SECONDS}`,
    );
  }

  // 回调建会话：换票 + 验签 + 建 oidc_session
  if (method === 'GET' && seg[1] === 'callback' && seg.length === 2) {
    if (!isOidc(env)) throw new HttpError(404, '未知接口');
    // RFC 9207：auth 回跳带 iss，先核对响应来自配的这个认证中心
    const iss = url.searchParams.get('iss');
    if (iss !== null && iss !== env.OIDC_ISSUER) throw new HttpError(400, '登录响应来源不对，请重新登录', 'oidc_iss_mismatch');

    const tempRaw = getCookie(request, OIDC_TEMP_COOKIE);
    let temp: { state?: unknown; nonce?: unknown; verifier?: unknown; returnTo?: unknown } | null = null;
    try { temp = JSON.parse(b64urlDecode(tempRaw ?? '')); } catch { /* 走下面的统一校验 */ }
    if (
      !temp || typeof temp.state !== 'string' || typeof temp.nonce !== 'string' || typeof temp.verifier !== 'string' ||
      !timingSafeEq(url.searchParams.get('state') ?? '', temp.state)
    ) {
      throw new HttpError(400, '登录状态已失效，请重新登录', 'oidc_state_invalid');
    }
    const code = url.searchParams.get('code');
    // prompt=none 静默探测的预期分支：auth 无会话回 error，不出错页、原路送回来源页继续匿名
    // （探测永不出交互页；真正要交互的场景由用户手动点登录走完整链路）
    if (!code && url.searchParams.has('error')) {
      return redirect(safeReturn(temp.returnTo), clearCookie(OIDC_TEMP_COOKIE));
    }
    if (!code) throw new HttpError(400, '登录被取消或未完成，请重试', 'oidc_no_code');

    // code 换票（公开 client，无 secret，凭 PKCE 自证）；非 200 一律 502，不向用户区分细节
    const tokenRes = await fetch(`${env.OIDC_ISSUER}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${origin}/api/auth/callback`,
        client_id: env.OIDC_CLIENT_ID,
        code_verifier: temp.verifier,
      }),
    });
    const tokens = tokenRes.ok
      ? ((await tokenRes.json().catch(() => null)) as { id_token?: unknown; access_token?: unknown } | null)
      : null;
    if (!tokens || typeof tokens.id_token !== 'string' || typeof tokens.access_token !== 'string') {
      throw new HttpError(502, '认证中心换票失败，请稍后重试', 'oidc_token_error');
    }

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(tokens.id_token, jwksFor(env.OIDC_ISSUER), {
        issuer: env.OIDC_ISSUER,
        audience: env.OIDC_CLIENT_ID,
        algorithms: ['RS256'],
      }));
    } catch {
      throw new HttpError(502, '登录凭证校验失败，请重新登录', 'oidc_verify_error');
    }
    if (!timingSafeEq(typeof payload.nonce === 'string' ? payload.nonce : '', temp.nonce)) {
      throw new HttpError(502, '登录凭证校验失败，请重新登录', 'oidc_verify_error');
    }
    // sub 必须是数字串（过渡期 = tour user id，步骤③收口后即 auth 账号 id）；sid 供登出联动
    if (
      typeof payload.sub !== 'string' || !/^\d+$/.test(payload.sub) ||
      typeof payload.sid !== 'string' || !payload.sid
    ) {
      throw new HttpError(502, '登录凭证不完整，请重新登录', 'oidc_claim_error');
    }

    // 步骤③收口：拉 userinfo 并验形——claims（角色/权限/状态）是本地判定唯一来源，
    // 拉取失败/缺字段 → 502 不建会话；qq 快照一并在此取（绑定镜像复用这一次拉取）
    const uiRes = await fetch(`${env.OIDC_ISSUER}/userinfo`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    const info = uiRes.ok ? ((await uiRes.json().catch(() => null)) as Record<string, unknown> | null) : null;
    const claims = parseOidcClaims(info);
    if (!claims) throw new HttpError(502, '账号信息拉取失败，请重新登录', 'oidc_userinfo_error');

    const now = new Date().toISOString();
    await env.DB.prepare('DELETE FROM oidc_session WHERE expires_at < ?').bind(now).run();
    const token = randomB64url(32);
    await env.DB.prepare(
      'INSERT INTO oidc_session (token_hash, sub, auth_sid, claims, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(await sha256hex(token), payload.sub, payload.sid, JSON.stringify(claims), now,
      new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString()).run();

    await mirrorBinding(env, payload.sub, info as { qq?: unknown; name: string; roles: string[] });
    return redirect(safeReturn(temp.returnTo), sessionCookie(token), clearCookie(OIDC_TEMP_COOKIE));
  }

  // 登出：先吊销本地行，浏览器再跳认证中心 end_session（302 链由浏览器跟随）
  if (method === 'POST' && seg[1] === 'logout' && seg.length === 2) {
    const token = getCookie(request, OIDC_SESSION_COOKIE);
    if (token) {
      await env.DB.prepare('UPDATE oidc_session SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
        .bind(new Date().toISOString(), await sha256hex(token)).run();
    }
    if (!isOidc(env)) return redirect(TOUR_HOME, clearCookie(OIDC_SESSION_COOKIE));
    // 认证中心吊销自身会话后向各接入方推 back-channel（本地行已先吊销，幂等）
    return redirect(`${env.OIDC_ISSUER}/logout?post_logout_redirect_uri=${encodeURIComponent(origin + '/')}`, clearCookie(OIDC_SESSION_COOKIE));
  }

  // back-channel 登出通知（认证中心服务器间直呼，无 cookie）：坏 token 回 400，成功/未知 sid 回 200 空体
  if (method === 'POST' && seg[1] === 'backchannel-logout' && seg.length === 2) {
    if (!isOidc(env)) throw new HttpError(404, '未知接口');
    const form = await request.formData().catch(() => null);
    const token = form?.get('logout_token');
    if (typeof token !== 'string' || !token) throw new HttpError(400, '需要 logout_token');
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, jwksFor(env.OIDC_ISSUER), {
        issuer: env.OIDC_ISSUER,
        audience: env.OIDC_CLIENT_ID,
        algorithms: ['RS256'],
      }));
    } catch {
      throw new HttpError(400, 'logout_token 校验失败');
    }
    const events = payload.events;
    if (typeof events !== 'object' || events === null || !(BACKCHANNEL_LOGOUT_EVENT in events)) {
      throw new HttpError(400, 'logout_token 缺少登出事件');
    }
    if (payload.nonce !== undefined) throw new HttpError(400, 'logout_token 不应携带 nonce');
    if (typeof payload.sid !== 'string' || !payload.sid) throw new HttpError(400, 'logout_token 缺少 sid');
    await env.DB.prepare('UPDATE oidc_session SET revoked_at = ? WHERE auth_sid = ? AND revoked_at IS NULL')
      .bind(new Date().toISOString(), payload.sid).run();
    return new Response(null, { status: 200 });
  }

  throw new HttpError(404, '未知接口');
}
