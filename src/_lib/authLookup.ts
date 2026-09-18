// QQ 绑定真源实时查询（增量 9B）：绑定在 auth 的 identity 表，本地 user_binding 自本增量起
// 停镜像停读（表保留作历史对账），各读点改走本 helper 批量查询——一次 HMAC 机器请求、
// 单批 ≤100、禁 N+1。契约与 auth machineGate 逐字一致：
// X-Sign = HMAC-SHA256(secret, "POST|path|ts|raw") hex，时间窗 ±300s（auth hmac.ts 校验）。
// 账号口径：account_id = auth account.id = guess users.tour_id（同值迁移），调用方自行换算本地 id。
import { HttpError } from './http.ts';
import { hmacSign } from './auth.ts';

export type QqBinding = { account_id: number; qq_id: string; bound_at: string };

/**
 * 批量查绑定。返回 Map<account_id, binding>，未绑定的 id 不在 Map 里。
 * @param opts.failOpen 展示类调用方（/me、用户列表）传 true：查询失败按「未绑定」处理，
 *        不挡页面；门槛/发奖类不传（fail-closed 503），宁拒勿错。
 */
export async function lookupQqBindings(
  env: any,
  accountIds: number[],
  opts: { failOpen?: boolean } = {},
): Promise<Map<number, QqBinding>> {
  const empty = new Map<number, QqBinding>();
  const ids = [...new Set(accountIds.filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length === 0) return empty;
  const base = env.OIDC_ISSUER;
  const secret = env.AUTH_BIND_SECRET;
  if (!base || !secret) {
    if (opts.failOpen) return empty;
    throw new HttpError(503, '绑定状态通道未配置，请联系管理员');
  }
  const path = '/api/admin/identity/lookup';
  const raw = JSON.stringify({ account_ids: ids });
  const ts = String(Math.floor(Date.now() / 1000));
  const sign = await hmacSign(secret, `POST|${path}|${ts}|${raw}`);
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Timestamp': ts, 'X-Sign': sign },
      body: raw,
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    if (opts.failOpen) return empty;
    throw new HttpError(503, '绑定状态查询失败，请稍后再试');
  }
  if (!res.ok) {
    if (opts.failOpen) return empty;
    throw new HttpError(503, '绑定状态查询失败，请稍后再试');
  }
  const body = await res.json().catch(() => null) as any;
  const map = new Map<number, QqBinding>();
  for (const b of body?.bindings ?? []) {
    if (Number.isInteger(b?.account_id) && typeof b?.qq_id === 'string') {
      map.set(b.account_id, { account_id: b.account_id, qq_id: b.qq_id, bound_at: String(b.bound_at ?? '') });
    }
  }
  return map;
}

/** 本地 users.id（autoincrement）→ auth account.id 换算 + 批量查询，返回 Map<本地id, QqBinding>。
 *  发奖/对账这类入参是本地 user_id 的批量场景用；一条 IN 查询 + 一次 lookup，两次往返封顶。 */
export async function lookupQqByLocalIds(env: any, localIds: number[], opts: { failOpen?: boolean } = {}): Promise<Map<number, QqBinding>> {
  const ids = [...new Set(localIds.filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length === 0) return new Map();
  const rows = (await env.DB.prepare(
    `SELECT id, tour_id FROM users WHERE id IN (${ids.map(() => '?').join(',')})`,
  ).bind(...ids).all()).results as any[];
  const tourOf = new Map<number, number>(rows.map((r) => [r.id, r.tour_id]).filter(([, t]) => Number.isInteger(t)));
  const bound = await lookupQqBindings(env, [...tourOf.values()], opts);
  const out = new Map<number, QqBinding>();
  for (const [localId, tourId] of tourOf) {
    const b = bound.get(tourId);
    if (b) out.set(localId, b);
  }
  return out;
}
