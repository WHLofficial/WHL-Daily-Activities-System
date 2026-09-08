// 认证与会话（B1 退路：自建账号密码；对接赛事系统时替换 getAuthUser 的实现）
// 插件方向请求用 HMAC-SHA256 签名验证（SYNC_SECRET 共享密钥）。

import { HttpError } from './http.ts';

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

// ---- 密码（PBKDF2-SHA256, 100k 迭代）----

export async function hashPassword(password: string): Promise<{ salt: string; hash: string }> {
  const salt = randomHex(16);
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100_000, hash: 'SHA-256' }, key, 256,
  );
  return { salt, hash: toHex(bits) };
}

export async function verifyPassword(password: string, salt: string, expected: string): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100_000, hash: 'SHA-256' }, key, 256,
  );
  const got = toHex(bits);
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
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

// TODO(B1)：对接赛事系统时，在此处校验共享登录 cookie 并映射到 users.external_id；
// 自建会话为 TECH_DESIGN 第四节约定的退路实现。
// ---- 赛事系统共享会话（B1 主通道）----
// 赛事系统发 whl_session（HttpOnly，域属性由其 COOKIE_DOMAIN 决定），会话真源在其 KV：
//   sess:<token> -> {"userId":n}；用户表在其 D1 `whl` 库 user 表。
// 本库只存镜像（users.tour_id 唯一键）。角色映射：
//   admin/superadmin -> admin；coach（含 locked=1 的观众号）-> user。
// locked 是赛事系统「未解锁绑队」的观众号，不是封禁 —— 放行；
// must_change_pw 视为未登录（需先回赛事系统改密）。
const TOUR_COOKIE = 'whl_session';

async function mirrorTourUser(env: any, tour: any): Promise<any> {
  const role = tour.role === 'admin' || tour.role === 'superadmin' ? 'admin' : 'user';
  // 密码列填空值：赛事系统身份不走本地密码登录（verifyPassword 永不匹配空哈希）
  return env.DB.prepare(
    `INSERT INTO users (tour_id, username, display_name, role, password_salt, password_hash)
       VALUES (?, ?, ?, ?, '', '')
       ON CONFLICT(tour_id) DO UPDATE SET display_name = excluded.display_name, role = excluded.role
     RETURNING id, username, display_name, role`,
  ).bind(tour.id, tour.name, tour.name, role).first();
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
  if (tour.must_change_pw === 1) return null;
  return mirrorTourUser(env, tour);
}

export async function getAuthUser(env: any, request: Request): Promise<any | null> {
  const tour = await getTourSessionUser(env, request).catch((e: any) => {
    console.error('[tour-auth] failed:', e?.message || e);
    return null;
  });
  if (tour) return tour;
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  return env.DB.prepare(
    `SELECT u.id, u.username, u.display_name, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`,
  ).bind(await sha256hex(token), new Date().toISOString()).first();
}

export async function isInitiator(env: any, userId: number): Promise<boolean> {
  const row = await env.DB.prepare('SELECT 1 AS ok FROM initiators WHERE user_id = ?').bind(userId).first();
  return !!row;
}

// 建期/开盘/截止/录比分/结算/确认：管理员或发起人名单内
export async function requireManager(env: any, request: Request): Promise<any> {
  const user = await requireUser(env, request);
  if (user.role !== 'admin' && !(await isInitiator(env, user.id))) {
    throw new HttpError(403, '仅管理员或发起人可操作');
  }
  return user;
}

export async function requireUser(env: any, request: Request): Promise<any> {
  const user = await getAuthUser(env, request);
  if (!user) throw new HttpError(401, '未登录');
  return user;
}

export async function requireRole(env: any, request: Request, roles: string[]): Promise<any> {
  const user = await requireUser(env, request);
  if (!roles.includes(user.role)) throw new HttpError(403, '没有权限');
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
