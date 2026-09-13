// 统一认证接入测试（迁移步骤②，auth 项目 PRD P0-6）：
// in-process 伪认证服务器——stub 全局 fetch 提供 jwks/token 两端点，用 jose 现签
// id_token / logout_token（独立密钥对，challenge 哈希用 node:crypto 独立实现），
// 驱动 RP 全流程：发起登录 → 回调建会话 → 登出吊销 → back-channel 通知；
// 兼容模式（未配 OIDC_*）回归旧行为（共享 cookie / 本地会话 / 账密登录）。
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { handleApi } from '../src/api.ts';
import { tourHashPassword } from '../src/_lib/tourcrypto.ts';
import { BACKCHANNEL_LOGOUT_EVENT } from '../src/_lib/oidc.ts';

const ISSUER = 'https://auth.example';
const CLIENT_ID = 'guess';
const nowSec = () => Math.floor(Date.now() / 1000);

// ---- 密钥与令牌（独立于 guess 代码的验签材料） ----

interface KeyMaterial {
  privateKey: CryptoKey;
  jwk: { kid: string; kty: string; n: string; e: string };
}

let signing: KeyMaterial;
let rogue: KeyMaterial;
let smbossHash = ''; // tourHashPassword 是异步的，先算好再进夹具

beforeAll(async () => {
  const make = async (kid: string): Promise<KeyMaterial> => {
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    const jwk = (await exportJWK(publicKey)) as { kty: string; n: string; e: string };
    return { privateKey, jwk: { ...jwk, kid } };
  };
  signing = await make('test-key-1');
  rogue = await make('rogue-key');
  smbossHash = await tourHashPassword('secret123');
});

function mint(key: KeyMaterial, claims: JWTPayload): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: key.jwk.kid }).sign(key.privateKey);
}

// ---- 伪认证服务器：stub 全局 fetch，只服务 /jwks.json 与 /token ----

interface StubState {
  code: string;
  challenge: string;
  nonce: string;
  sub: string;
  sid: string;
  idToken?: string;
  tokenStatus?: number;
  tokenCalls: URLSearchParams[];
}

let stub: StubState;

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = input instanceof URL ? input : new URL(String(input));
  if (url.pathname.endsWith('/jwks.json')) {
    return new Response(JSON.stringify({ keys: [signing.jwk] }), {
      headers: { 'content-type': 'application/json' },
    });
  }
  if (url.pathname.endsWith('/token')) {
    const form = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams(String(init?.body ?? ''));
    stub.tokenCalls.push(form);
    if (stub.tokenStatus) {
      return new Response(JSON.stringify({ error: 'server_error' }), { status: stub.tokenStatus });
    }
    const ok =
      form.get('grant_type') === 'authorization_code' &&
      form.get('code') === stub.code &&
      form.get('client_id') === CLIENT_ID &&
      form.get('redirect_uri') === 'http://localhost/api/auth/callback' &&
      createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === stub.challenge;
    if (!ok) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    const idToken =
      stub.idToken ??
      (await mint(signing, {
        iss: ISSUER,
        aud: CLIENT_ID,
        sub: stub.sub,
        sid: stub.sid,
        nonce: stub.nonce,
        iat: nowSec(),
        exp: nowSec() + 600,
      }));
    return new Response(
      JSON.stringify({
        access_token: 'fake-at', token_type: 'Bearer', expires_in: 1800,
        refresh_token: 'fake-rt', scope: 'openid', id_token: idToken,
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  }
  return new Response('not found', { status: 404 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---- 测试环境（guess 全部迁移 + tour 用户夹具） ----

// 把 node:sqlite 包成 D1 兼容接口（guess 代码用 .prepare().bind().first()/all()/run()/batch）
function createTestD1(sqlite: DatabaseSync): any {
  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...bound: unknown[]) {
          args = bound;
          return stmt;
        },
        async first<T = Record<string, unknown>>(): Promise<T | null> {
          return (sqlite.prepare(sql).get(...(args as never[])) ?? null) as T | null;
        },
        async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
          return { results: sqlite.prepare(sql).all(...(args as never[])) as T[] };
        },
        async run() {
          const r = sqlite.prepare(sql).run(...(args as never[]));
          return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
        },
      };
      return stmt;
    },
    async batch(statements: { run(): Promise<{ meta: { changes: number } }> }[]) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const out: { meta: { changes: number } }[] = [];
        for (const s of statements) out.push(await s.run());
        sqlite.exec('COMMIT');
        return out;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

interface Fixture {
  env: any;
  sqlite: DatabaseSync;
}

function freshEnv(oidc: boolean): Fixture {
  const sqlite = new DatabaseSync(':memory:');
  for (const f of ['0001_init.sql', '0002_tour_auth.sql', '0003_exhausted.sql', '0004_payout_claim.sql', '0005_wdl_all.sql', '0006_notify_remind.sql', '0007_indexes.sql', '0008_oidc_session.sql']) {
    sqlite.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
  }
  const tour = new DatabaseSync(':memory:');
  tour.exec(
    `CREATE TABLE user (id INTEGER PRIMARY KEY, name TEXT, role TEXT, locked INTEGER DEFAULT 0, must_change_pw INTEGER DEFAULT 0, password_hash TEXT);
     INSERT INTO user (id, name, role, locked, must_change_pw, password_hash) VALUES
       (1, 'smboss', 'admin', 0, 0, '${smbossHash}'),
       (6, 'oidctest4', 'admin', 0, 0, ''),
       (7, 'oidctest5', 'admin', 0, 0, '');`,
  );
  const kv = new Map<string, string>([['sess:tok-legacy', JSON.stringify({ userId: 6 })]]);
  const env: any = {
    DB: createTestD1(sqlite),
    TOUR_DB: createTestD1(tour),
    SESSION_KV: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      delete: async (k: string) => void kv.delete(k),
    },
    ...(oidc ? { OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: CLIENT_ID } : {}),
  };
  return { env, sqlite };
}

// guess 没有 Hono：直接调 handleApi
function call(env: any, method: string, path: string, opts: { cookie?: string; body?: unknown; form?: Record<string, string> } = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  let body: string | undefined;
  if (opts.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(opts.form).toString();
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  return handleApi({ request: new Request(`http://localhost${path}`, { method, headers, body }), env });
}

function cookieOf(res: Response, name: string): string | undefined {
  for (const line of res.headers.getSetCookie()) {
    const m = new RegExp(`^${name}=([^;]*)`).exec(line);
    if (m) return m[1];
  }
  return undefined;
}

/** 完整登录：发起 → 伪 auth 发码 → 回调。返回回调响应与会话 cookie。 */
async function oidcLogin(env: any, opts?: { sub?: string; sid?: string }) {
  const start = await call(env, 'GET', '/api/auth/login');
  expect(start.status).toBe(302);
  const authUrl = new URL(start.headers.get('Location')!);
  const temp = cookieOf(start, '__Host-guess_oidc');
  expect(temp).toBeTruthy();
  stub = {
    code: 'CODE-1',
    challenge: authUrl.searchParams.get('code_challenge')!,
    nonce: authUrl.searchParams.get('nonce')!,
    sub: opts?.sub ?? '6',
    sid: opts?.sid ?? 'sid-1',
    tokenCalls: [],
  };
  const cb = await call(env, 'GET', `/api/auth/callback?code=${stub.code}&state=${authUrl.searchParams.get('state')}&iss=${encodeURIComponent(ISSUER)}`, { cookie: `__Host-guess_oidc=${temp}` });
  return { start, authUrl, cb, session: cookieOf(cb, '__Host-guess_session') };
}

describe('统一认证接入（步骤② OIDC RP）', () => {
  it('兼容模式：login/logout 跳赛事系统，回调与通知端点 404，/api/me authMode=shared，旧账密登录照常', async () => {
    const { env } = freshEnv(false);
    const start = await call(env, 'GET', '/api/auth/login');
    expect(start.status).toBe(302);
    expect(start.headers.get('Location')).toBe('https://whleague.win/');

    const cb = await call(env, 'GET', '/api/auth/callback?code=x&state=y');
    expect(cb.status).toBe(404);
    const bcl = await call(env, 'POST', '/api/auth/backchannel-logout');
    expect(bcl.status).toBe(404);

    const logout = await call(env, 'POST', '/api/auth/logout');
    expect(logout.status).toBe(302);
    expect(logout.headers.get('Location')).toBe('https://whleague.win/');

    // 旧账密登录链路不受影响：验密走赛事库 → 建 30 天本地会话
    const login = await call(env, 'POST', '/api/login', { body: { username: 'smboss', password: 'secret123' } });
    expect(login.status).toBe(200);
    const legacy = cookieOf(login, 'whl_sess');
    expect(legacy).toBeTruthy();
    const me = await call(env, 'GET', '/api/me', { cookie: `whl_sess=${legacy}` });
    const meBody = await me.json();
    expect(meBody.user.username).toBe('smboss');
    expect(meBody.authMode).toBe('shared');
    expect(meBody.authHome).toBeNull();
  });

  it('发起登录：302 到 authorize，scope=openid + PKCE S256 + __Host- 临时 cookie', async () => {
    vi.stubGlobal('fetch', fakeFetch);
    const { env } = freshEnv(true);
    const start = await call(env, 'GET', '/api/auth/login');
    expect(start.status).toBe(302);
    const u = new URL(start.headers.get('Location')!);
    expect(`${u.protocol}//${u.host}${u.pathname}`).toBe(`${ISSUER}/authorize`);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost/api/auth/callback');
    expect(u.searchParams.get('scope')).toBe('openid');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.has('nonce')).toBe(true);
    const sc = start.headers.getSetCookie().find((l) => l.startsWith('__Host-guess_oidc='));
    expect(sc).toContain('HttpOnly');
    expect(sc).toContain('SameSite=Lax');
    expect(sc).toContain('Max-Age=600');
    expect(sc).toContain('Secure');
  });

  it('回调建会话：换票验签入库 + 镜像用户，/api/me 认出人，旧 whl_session 被无视', async () => {
    vi.stubGlobal('fetch', fakeFetch);
    const { env, sqlite } = freshEnv(true);
    const { cb, session } = await oidcLogin(env);

    expect(cb.status).toBe(302);
    expect(cb.headers.get('Location')).toBe('/');
    expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const deleted = cb.headers.getSetCookie().find((l) => l.startsWith('__Host-guess_oidc='));
    expect(deleted).toMatch(/^__Host-guess_oidc=;/);
    const sc = cb.headers.getSetCookie().find((l) => l.startsWith('__Host-guess_session='));
    expect(sc).toContain('Secure');
    expect(sc).toContain('Max-Age=604800');

    const row = sqlite.prepare('SELECT token_hash, sub, auth_sid, revoked_at FROM oidc_session').get() as any;
    expect(row).toEqual({
      token_hash: createHash('sha256').update(session!).digest('hex'),
      sub: '6',
      auth_sid: 'sid-1',
      revoked_at: null,
    });

    // /api/me 认人 + 本地镜像（users.tour_id=6，预测/发奖 JOIN 的锚点）
    const me = await call(env, 'GET', '/api/me', { cookie: `__Host-guess_session=${session}` });
    const meBody = await me.json();
    expect(meBody.user.username).toBe('oidctest4');
    expect(meBody.user.role).toBe('admin');
    expect(meBody.authMode).toBe('oidc');
    expect(meBody.authHome).toBe(ISSUER);
    const mirror = sqlite.prepare('SELECT id, tour_id, username, role FROM users WHERE tour_id = 6').get() as any;
    expect(mirror?.username).toBe('oidctest4');

    // 模式互斥：OIDC 模式下共享会话 cookie 不再生效
    const legacy = await call(env, 'GET', '/api/me', { cookie: 'whl_session=tok-legacy' });
    expect(((await legacy.json()).user)).toBeNull();
  });

  it('回调异常路径：state/临时 cookie/iss → 400；换票/验签/nonce/sub/PKCE → 502', async () => {
    vi.stubGlobal('fetch', fakeFetch);
    const { env } = freshEnv(true);
    const start = await call(env, 'GET', '/api/auth/login');
    const authUrl = new URL(start.headers.get('Location')!);
    const temp = cookieOf(start, '__Host-guess_oidc')!;
    const state = authUrl.searchParams.get('state')!;

    const bad = (query: string, cookie?: string) => call(env, 'GET', `/api/auth/callback?${query}`, { cookie: cookie ? `__Host-guess_oidc=${cookie}` : undefined });

    expect((await bad(`code=C&state=other&iss=${encodeURIComponent(ISSUER)}`, temp)).status).toBe(400);
    expect((await bad(`code=C&state=${state}&iss=${encodeURIComponent(ISSUER)}`)).status).toBe(400);
    expect((await bad(`code=C&state=${state}&iss=https://evil.example`, temp)).status).toBe(400);

    stub = { code: 'CODE-2', challenge: authUrl.searchParams.get('code_challenge')!, nonce: authUrl.searchParams.get('nonce')!, sub: '6', sid: 'sid-1', tokenStatus: 500, tokenCalls: [] };
    expect((await bad(`code=CODE-2&state=${state}&iss=${encodeURIComponent(ISSUER)}`, temp)).status).toBe(502);

    stub = { ...stub, tokenStatus: undefined, idToken: await mint(rogue, { iss: ISSUER, aud: CLIENT_ID, sub: '6', sid: 'sid-1', nonce: stub.nonce, iat: nowSec(), exp: nowSec() + 600 }) };
    expect((await bad(`code=CODE-2&state=${state}&iss=${encodeURIComponent(ISSUER)}`, temp)).status).toBe(502);

    stub = { ...stub, idToken: await mint(signing, { iss: ISSUER, aud: CLIENT_ID, sub: '6', sid: 'sid-1', nonce: 'other', iat: nowSec(), exp: nowSec() + 600 }) };
    expect((await bad(`code=CODE-2&state=${state}&iss=${encodeURIComponent(ISSUER)}`, temp)).status).toBe(502);

    // sub 不是数字串 → 502
    stub = { ...stub, idToken: await mint(signing, { iss: ISSUER, aud: CLIENT_ID, sub: 'abc', sid: 'sid-1', nonce: stub.nonce, iat: nowSec(), exp: nowSec() + 600 }) };
    expect((await bad(`code=CODE-2&state=${state}&iss=${encodeURIComponent(ISSUER)}`, temp)).status).toBe(502);

    // PKCE verifier 与 challenge 不符：伪 auth 拒绝换票（400）→ guess 502
    stub = { ...stub, idToken: undefined, challenge: 'A'.repeat(43) };
    expect((await bad(`code=CODE-2&state=${state}&iss=${encodeURIComponent(ISSUER)}`, temp)).status).toBe(502);
    expect(stub.tokenCalls.at(-1)!.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('OIDC 模式下旧入口移交：login/register/password 302，旧 logout 吊销本地会话并给出认证中心地址', async () => {
    vi.stubGlobal('fetch', fakeFetch);
    const { env, sqlite } = freshEnv(true);
    expect((await call(env, 'POST', '/api/login', { body: { username: 'x', password: 'y' } })).headers.get('Location')).toBe('http://localhost/api/auth/login');
    expect((await call(env, 'POST', '/api/register', { body: {} })).headers.get('Location')).toBe(`${ISSUER}/register`);
    expect((await call(env, 'POST', '/api/password', { body: {} })).headers.get('Location')).toBe(`${ISSUER}/password`);

    const { session } = await oidcLogin(env);
    const oldLogout = await call(env, 'POST', '/api/logout', { cookie: `__Host-guess_session=${session}` });
    const oldBody = await oldLogout.json();
    expect(oldBody.ok).toBe(true);
    expect(oldBody.redirect).toBe(`${ISSUER}/logout?post_logout_redirect_uri=http%3A%2F%2Flocalhost%2F`);
    const row = sqlite.prepare('SELECT revoked_at FROM oidc_session').get() as any;
    expect(row?.revoked_at).not.toBeNull();
  });

  it('登出：吊销本地会话行，302 跳认证中心 end_session 带白名单回跳', async () => {
    vi.stubGlobal('fetch', fakeFetch);
    const { env, sqlite } = freshEnv(true);
    const { session } = await oidcLogin(env);

    const logout = await call(env, 'POST', '/api/auth/logout', { cookie: `__Host-guess_session=${session}` });
    expect(logout.status).toBe(302);
    const target = new URL(logout.headers.get('Location')!);
    expect(`${target.protocol}//${target.host}${target.pathname}`).toBe(`${ISSUER}/logout`);
    expect(target.searchParams.get('post_logout_redirect_uri')).toBe('http://localhost/');

    const row = sqlite.prepare('SELECT revoked_at FROM oidc_session').get() as any;
    expect(row?.revoked_at).not.toBeNull();
    const me = await call(env, 'GET', '/api/me', { cookie: `__Host-guess_session=${session}` });
    expect(((await me.json()).user)).toBeNull();
  });

  it('back-channel：按 sid 吊销会话并回 200 空体；坏 token 400；未知 sid 不动既有会话', async () => {
    vi.stubGlobal('fetch', fakeFetch);
    const { env, sqlite } = freshEnv(true);
    const { session } = await oidcLogin(env, { sid: 'sid-bc-1' });

    const post = async (token: string) =>
      call(env, 'POST', '/api/auth/backchannel-logout', { form: { logout_token: token } });
    const logoutClaims = (sid: string, extra: JWTPayload = {}): JWTPayload => ({
      iss: ISSUER, aud: CLIENT_ID, sub: '6', sid, jti: 'jti-1', iat: nowSec(),
      events: { [BACKCHANNEL_LOGOUT_EVENT]: {} }, ...extra,
    });

    expect((await post(await mint(rogue, logoutClaims('sid-bc-1')))).status).toBe(400);
    expect((await post(await mint(signing, logoutClaims('sid-bc-1', { nonce: 'x' })))).status).toBe(400);
    const { events: _drop, ...noEvent } = logoutClaims('sid-bc-1');
    expect((await post(await mint(signing, noEvent))).status).toBe(400);

    const okRes = await post(await mint(signing, logoutClaims('sid-bc-1')));
    expect(okRes.status).toBe(200);
    expect(await okRes.text()).toBe('');
    const row = sqlite.prepare('SELECT revoked_at FROM oidc_session').get() as any;
    expect(row?.revoked_at).not.toBeNull();
    const me = await call(env, 'GET', '/api/me', { cookie: `__Host-guess_session=${session}` });
    expect(((await me.json()).user)).toBeNull();

    const other = await oidcLogin(env, { sid: 'sid-bc-2' });
    expect(other.cb.status).toBe(302);
    expect((await post(await mint(signing, logoutClaims('sid-unknown')))).status).toBe(200);
    const alive = sqlite.prepare("SELECT revoked_at FROM oidc_session WHERE auth_sid = 'sid-bc-2'").get() as any;
    expect(alive?.revoked_at).toBeNull();
  });
});
