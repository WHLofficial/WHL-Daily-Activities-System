// 认证与会话（统一认证：账号真源在 auth 认证中心，本地 users 表只是镜像锚点）
// 插件方向请求用 HMAC-SHA256 签名验证（SYNC_SECRET 共享密钥）。

import { HttpError } from './http.ts';
import { isOidc, OIDC_SESSION_COOKIE } from './oidc.ts';

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256hex(s: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

export function randomHex(nBytes: number): string {
  const b = new Uint8Array(nBytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function hmac(secret: string, canonical: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(canonical)));
}

// ---- 会话 ----

const SESSION_COOKIE = 'whl_sess';
const SESSION_DAYS = 30;

export async function createSession(env: any, userId: number): Promise<string> {
  const token = randomHex(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256hex(token), userId, expires).run();
  return token;
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

// ---- 认证双模式（统一认证：真源在 auth，兼容模式只读赛事库）----
// 账号真源在 auth 认证中心；本地只存镜像（users.tour_id = auth account.id，唯一键）。
// OIDC 模式下登录/注册/改密全部移交认证中心，姓名/角色/状态来自 claims（见 resolveOidcUser）；
// 赛事库 `whl` 的 user 表已退化为镜像，仅兼容模式的旧账密登录还会只读校验它（见 api.ts）。
// 兼容模式另有赛事系统发的 whl_session（HttpOnly，域属性由其 COOKIE_DOMAIN 决定），会话真源在其 KV：
//   sess:<token> -> {"userId":n}。已登录比赛平台的用户打开竞猜站自动镜像登录。
// 角色映射：admin/superadmin -> admin；coach（含 locked=1 的观众号）-> user。
// locked 是赛事系统「未解锁绑队」的观众号，不是封禁 —— 放行；
// must_change_pw=1（被管理员重置过密码）照常登录，但除改密/登出/查看自身状态外一律 403，
// 由 requirePwChanged 统一拦下（与赛事系统 worker/middleware/auth.ts 同规则）。
const TOUR_COOKIE = 'whl_session';

// KV 固定窗口限流（与赛事系统 worker/lib/ratelimit.ts 同款；KV 最终一致，窗口边界少量超发对朋友局可接受）
export async function rateLimit(env: any, key: string, limit: number, windowSec: number): Promise<boolean> {
  if (!env.SESSION_KV) return true;
  const bucket = Math.floor(Date.now() / 1000 / windowSec);
  const k = `rl:${key}:${bucket}`;
  const cur = Number((await env.SESSION_KV.get(k)) ?? 0);
  if (cur >= limit) return false;
  await env.SESSION_KV.put(k, String(cur + 1), { expirationTtl: windowSec });
  return true;
}

export async function mirrorTourUser(env: any, tour: any): Promise<any> {
  const role = tour.role === 'admin' || tour.role === 'superadmin' ? 'admin' : 'user';
  // 密码列填空值：本地镜像不走本地密码登录（登录验密只查赛事库）
  return env.DB.prepare(
    `INSERT INTO users (tour_id, username, display_name, role, password_salt, password_hash)
       VALUES (?, ?, ?, ?, '', '')
       ON CONFLICT(tour_id) DO UPDATE SET display_name = excluded.display_name, role = excluded.role
     RETURNING id, tour_id, username, display_name, role`,
  ).bind(tour.id, tour.name, tour.name, role).first();
}

// ---- 步骤③收口（auth P0-10，TECH_DESIGN §6.3）----
// userinfo / 会话内 claims 的统一校验：accept 对象（回调刚拉到的 userinfo）或
// JSON 串（oidc_session.claims 列），字段不齐一律视为无效（解析失败 = 未登录）。
export type OidcClaims = {
  name: string;
  locked: boolean;
  must_change_pw: boolean;
  roles: string[];
  permissions: string[];
};

export function parseOidcClaims(raw: unknown): OidcClaims | null {
  let t = raw;
  if (typeof t === 'string') {
    try { t = JSON.parse(t); } catch { return null; }
  }
  if (typeof t !== 'object' || t === null) return null;
  const c = t as Partial<OidcClaims>;
  if (
    typeof c.name !== 'string' || !c.name ||
    typeof c.locked !== 'boolean' ||
    typeof c.must_change_pw !== 'boolean' ||
    !Array.isArray(c.roles) || !c.roles.every((r) => typeof r === 'string') ||
    !Array.isArray(c.permissions) || !c.permissions.every((p) => typeof p === 'string')
  ) return null;
  return { name: c.name, locked: c.locked, must_change_pw: c.must_change_pw, roles: c.roles, permissions: c.permissions };
}

// 本地镜像锚点改由 claims 建立：账号真源在 auth 库，不再查赛事库 user 表（收口后新账号
// 在赛事库无行）。role 投影与旧映射等价（guess.admin/superadmin → admin，其余 → user）；
// 镜像 users 只服务预测/发奖的 JOIN 与绑定外键，判定一律走 claims.permissions。
export async function mirrorClaimsUser(env: any, sub: string, claims: { name: string; roles: string[] }): Promise<any> {
  const role = claims.roles.includes('guess.admin') || claims.roles.includes('superadmin') ? 'admin' : 'user';
  return env.DB.prepare(
    `INSERT INTO users (tour_id, username, display_name, role, password_salt, password_hash)
       VALUES (?, ?, ?, ?, '', '')
       ON CONFLICT(tour_id) DO UPDATE SET display_name = excluded.display_name, role = excluded.role
     RETURNING id, tour_id, username, display_name, role`,
  ).bind(Number(sub), claims.name, claims.name, role).first();
}

async function getTourSessionUser(env: any, request: Request): Promise<any | null> {
  if (!env.SESSION_KV || !env.TOUR_DB) return null;
  const token = getCookie(request, TOUR_COOKIE);
  if (!token) return null;
  const raw = await env.SESSION_KV.get(`sess:${token}`);
  if (!raw) return null;
  let userId: number;
  try { userId = JSON.parse(raw).userId; } catch { return null; }
  const tour = await env.TOUR_DB.prepare(
    'SELECT id, name, role, locked, must_change_pw FROM user WHERE id = ?',
  ).bind(userId).first() as any;
  if (!tour) return null;
  const local = await mirrorTourUser(env, tour);
  return { ...local, mustChangePw: tour.must_change_pw === 1 };
}

// ---- 鉴权按请求记忆化 ----
// requirePwChanged 与 requireUser 在同一请求里会各解析一遍鉴权，历史上等于把
// D1/TOUR_DB/KV 往返翻倍。Request 实例每次请求唯一、随请求一起被回收，
// 用 WeakMap 挂缓存即可，不需要改任何调用方的签名。
const authMemo = new WeakMap<Request, { resolved?: boolean; user?: any; initiator?: Map<number, boolean> }>();

function memoFor(request: Request) {
  let m = authMemo.get(request);
  if (!m) { m = {}; authMemo.set(request, m); }
  return m;
}

export async function getAuthUser(env: any, request: Request): Promise<any | null> {
  const m = memoFor(request);
  if (m.resolved) return m.user;
  const user = await resolveAuthUser(env, request);
  m.user = user;
  m.resolved = true;
  return user;
}

async function resolveAuthUser(env: any, request: Request): Promise<any | null> {
  // 双模式互斥（统一认证迁移步骤②，auth 项目 PRD P0-6）：配了 OIDC_ISSUER 就只认
  // 认证中心签发的本地会话，不再回落共享 cookie / 30 天本地会话——
  // 两种登录态并存会让「登出」语义说不清
  if (isOidc(env)) return resolveOidcUser(env, request);
  const tour = await getTourSessionUser(env, request).catch((e: any) => {
    console.error('[tour-auth] failed:', e?.message || e);
    return null;
  });
  if (tour) return tour;
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const local = await env.DB.prepare(
    `SELECT u.id, u.tour_id, u.username, u.display_name, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`,
  ).bind(await sha256hex(token), new Date().toISOString()).first() as any;
  if (!local) return null;
  // 本地会话也要问一次赛事库：管理员重置密码后，旧会话同样该被拦去改密
  return { ...local, mustChangePw: await tourMustChangePw(env, local.tour_id) };
}

// OIDC 模式会话：__Host-guess_session cookie → oidc_session 表（token 哈希 + claims）→
// claims 解析 → 镜像 users（预测/发奖的 JOIN 与 user_binding 都锚在本地 users.id）。
// 步骤③收口：姓名/状态/角色/权限全部来自登录回调存档的 claims，不再查赛事库 user 表
// （账号真源在 auth 库）；claims 缺失/损坏的旧会话视为未登录，重登一次即恢复。
// 本地 30 天会话就此退役：旧 whl_sess cookie 在本模式下直接失效。
async function resolveOidcUser(env: any, request: Request): Promise<any | null> {
  const token = getCookie(request, OIDC_SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    'SELECT sub, claims FROM oidc_session WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?',
  ).bind(await sha256hex(token), new Date().toISOString()).first() as any;
  if (!row) return null;
  const claims = parseOidcClaims(row.claims);
  if (!claims) return null;
  const tourId = Number(row.sub);
  if (!Number.isInteger(tourId) || tourId <= 0) return null;
  const local = await mirrorClaimsUser(env, row.sub, claims);
  return { ...local, mustChangePw: claims.must_change_pw, permissions: claims.permissions };
}

async function tourMustChangePw(env: any, tourId: number | null): Promise<boolean> {
  if (!env.TOUR_DB || !tourId) return false;
  const row = await env.TOUR_DB.prepare('SELECT must_change_pw FROM user WHERE id = ?').bind(tourId).first() as any;
  return row?.must_change_pw === 1;
}

export async function isInitiator(env: any, userId: number, request?: Request): Promise<boolean> {
  if (!request) {
    const row = await env.DB.prepare('SELECT 1 AS ok FROM initiators WHERE user_id = ?').bind(userId).first();
    return !!row;
  }
  const m = memoFor(request);
  if (!m.initiator) m.initiator = new Map();
  if (m.initiator.has(userId)) return m.initiator.get(userId)!;
  const row = await env.DB.prepare('SELECT 1 AS ok FROM initiators WHERE user_id = ?').bind(userId).first();
  const ok = !!row;
  m.initiator.set(userId, ok);
  return ok;
}

// 开放竞猜/截止/录比分/结算/确认发奖：管理员或发起人。步骤③判定口径：
// OIDC 模式按权限点（guess.admin 经 guess.event.manage 下发；发起人经 guess.initiator
// 角色由 auth 播种同一权限点，本地 initiators 名单兜底）；兼容模式回落旧角色判定。
export async function requireManager(env: any, request: Request): Promise<any> {
  const user = await requireUser(env, request);
  const adminOk = isOidc(env)
    ? (user.permissions ?? []).includes('guess.event.manage')
    : user.role === 'admin';
  if (!adminOk && !(await isInitiator(env, user.id, request))) {
    throw new HttpError(403, '仅管理员或发起人可进行此操作');
  }
  return user;
}

// 管理台内部判定（发起人不可用的管理端点）：OIDC 按权限点；兼容模式回落 admin 角色。
// guess.users.manage / guess.payout.reverse / guess.recon.view 的持有人与旧 admin 角色完全重合
export async function requireAdminPerm(env: any, request: Request, user: any, perm: string, message: string): Promise<void> {
  const ok = isOidc(env) ? (user.permissions ?? []).includes(perm) : user.role === 'admin';
  if (!ok) throw new HttpError(403, message);
}

export async function requireUser(env: any, request: Request): Promise<any> {
  const user = await getAuthUser(env, request);
  if (!user) throw new HttpError(401, '未登录');
  return user;
}

// 被重置过密码的账号：业务接口前统一拦下，只放行改密/登出/查看自身状态这几条入口
export async function requirePwChanged(env: any, request: Request): Promise<void> {
  const user = await getAuthUser(env, request);
  if (user?.mustChangePw) {
    // 改密地点随模式：OIDC 模式下本站没有改密入口，去认证中心
    throw new HttpError(403, isOidc(env) ? '密码刚被重置，请先到认证中心设置新密码' : '密码刚被重置，请先设置新密码', 'password_change_required');
  }
}

export async function requireRole(env: any, request: Request, roles: string[]): Promise<any> {
  const user = await requireUser(env, request);
  if (!roles.includes(user.role)) throw new HttpError(403, '没有权限进行此操作');
  return user;
}

// ---- 插件方向 HMAC 验签 ----
// 签名串：`${method}|${pathWithQuery}|${ts}|${rawBody}`，X-Sign = HMAC-SHA256(SYNC_SECRET, 签名串) 的 hex。
// 时间窗 ±300 秒防重放。GET 的 body 为空串。与 docs/astrbot-sync-api.md 的 Python 实现严格对应。

export const SIGN_WINDOW_SEC = 300;

export async function hmacSign(secret: string, canonical: string): Promise<string> {
  return hmac(secret, canonical);
}

export async function verifyPluginRequest(env: any, request: Request, rawBody: string): Promise<void> {
  const ts = request.headers.get('X-Timestamp') || '';
  const sign = request.headers.get('X-Sign') || '';
  if (!ts || !sign) throw new HttpError(401, '缺少签名头');
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(ts)) > SIGN_WINDOW_SEC) throw new HttpError(401, '签名时间窗超限');
  const pathWithQuery = new URL(request.url).pathname + new URL(request.url).search;
  const canonical = `${request.method}|${pathWithQuery}|${ts}|${rawBody}`;
  const expect = await hmac(env.SYNC_SECRET, canonical);
  if (sign.length !== expect.length) throw new HttpError(401, '签名错误');
  let diff = 0;
  for (let i = 0; i < expect.length; i++) diff |= sign.charCodeAt(i) ^ expect.charCodeAt(i);
  if (diff !== 0) throw new HttpError(401, '签名错误');
}

export async function assertCronKey(env: any, request: Request): Promise<void> {
  const key = request.headers.get('X-Cron-Key') || '';
  const expect = env.CRON_SECRET || '';
  if (!expect || key.length !== expect.length) throw new HttpError(403, 'cron key 错误');
  let diff = 0;
  for (let i = 0; i < expect.length; i++) diff |= key.charCodeAt(i) ^ expect.charCodeAt(i);
  if (diff !== 0) throw new HttpError(403, 'cron key 错误');
}
