// 发奖同步客户端（TECH_DESIGN 第二节）：
// - 请求带 HMAC 签名（X-Timestamp / X-Sign）
// - 每次调用 10 秒中止信号；超时/网络错误记「unknown」而非失败（F1）
// - 同键（payout_id）重试，插件侧幂等兜底（F2）
// - 指数退避 1/5/15/60 分钟，最多 5 次后停自动重试转人工

import { hmacSign } from './auth.ts';
import { nowSql } from './http.ts';

const BACKOFF_MIN = [1, 5, 15, 60];
const MAX_RETRY = 5;
// 认领锁有效期：单条派发最多一次 10 秒 HTTP，超过 5 分钟视为上一轮进程已死，可被重新认领
const CLAIM_STALE_MS = 5 * 60_000;

export async function signAndFetch(
  env: any, method: 'GET' | 'POST', pathWithQuery: string, bodyObj: any = undefined, timeoutMs = 10_000,
): Promise<Response> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const raw = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
  const canonical = `${method}|${pathWithQuery}|${ts}|${raw}`;
  const sign = await hmacSign(env.SYNC_SECRET, canonical);
  return fetch(`${env.SYNC_BASE_URL}${pathWithQuery}`, {
    method,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Timestamp': ts, 'X-Sign': sign },
    body: raw === '' ? undefined : raw,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

type Outcome = 'credited' | 'duplicate' | 'unknown' | 'failed';

/** 对单个发放项执行一次 credit 调用并落日志/状态。attempt 从 1 开始。 */
export async function creditPayoutItem(env: any, item: any, attempt: number): Promise<Outcome> {
  const breakdown = JSON.parse(item.breakdown_json);
  const body = {
    payout_id: item.payout_id,
    qq_id: item.qq_id,
    // 契约：amount 负数=冲正；payout_item.amount 因 CHECK>0 恒为正，出站时翻号
    amount: breakdown.kind === 'reversal' ? -item.amount : item.amount,
    type: breakdown.kind === 'reversal' ? 'reversal' : 'reward',
    event_id: item.event_id,
    ts: new Date().toISOString(),
  };
  let outcome: Outcome;
  let detail = '';

  try {
    const res = await signAndFetch(env, 'POST', '/sync/credit', body);
    if (res.ok) {
      const j: any = await res.json().catch(() => ({}));
      outcome = j.duplicate === true ? 'duplicate' : 'credited';
      detail = `HTTP ${res.status} balance=${j.balance ?? '?'}`;
    } else {
      outcome = 'failed';
      detail = `HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`;
    }
  } catch (e: any) {
    // 超时/中断/网络错误：状态未知——钱可能已到账，同键重试（F1）
    outcome = 'unknown';
    detail = `${e?.name || 'Error'}: ${String(e?.message || e).slice(0, 200)}`;
  }

  let updateSql: string;
  let args: any[];
  if (outcome === 'credited' || outcome === 'duplicate') {
    updateSql = `UPDATE payout_item SET status='credited', credited_at=?, last_error=?, claim_at=NULL WHERE id=?`;
    args = [nowSql(), detail, item.id];
  } else if (outcome === 'failed') {
    updateSql = `UPDATE payout_item SET status='failed', last_error=?, claim_at=NULL WHERE id=?`;
    args = [detail, item.id];
  } else if (attempt >= MAX_RETRY) {
    // 重试耗尽：停自动重试转人工；批次「重试」按钮可重新拉起（exhausted → pending）
    updateSql = `UPDATE payout_item SET status='exhausted', last_error=?, claim_at=NULL WHERE id=?`;
    args = [detail, item.id];
  } else {
    updateSql = `UPDATE payout_item SET retry_count=?, last_error=?, next_retry_at=?, claim_at=NULL WHERE id=?`;
    args = [
      attempt, detail,
      new Date(Date.now() + BACKOFF_MIN[Math.min(attempt - 1, BACKOFF_MIN.length - 1)] * 60_000)
        .toISOString(),
      item.id,
    ];
  }
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sync_log (payout_id, attempt, outcome, detail) VALUES (?, ?, ?, ?)')
      .bind(item.payout_id, attempt, outcome, detail),
    env.DB.prepare(updateSql).bind(...args),
  ]);
  return outcome;
}

/** 扫描到期未发的发放项并逐条派发（发奖确认 / 手动重试 / cron 共用）。 */
export async function dispatchPending(env: any, batchId?: number) {
  const nowIso = new Date().toISOString();
  const staleIso = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
  const items = (await env.DB.prepare(
    `SELECT pi.*, e.id AS event_id FROM payout_item pi
       JOIN payout_batch b ON b.id = pi.batch_id JOIN event e ON e.id = b.event_id
      WHERE pi.status = 'pending' AND pi.retry_count < ${MAX_RETRY}
        AND (pi.next_retry_at IS NULL OR pi.next_retry_at <= ?)
        AND (pi.claim_at IS NULL OR pi.claim_at < ?)
        ${batchId ? 'AND pi.batch_id = ?' : ''}
      ORDER BY pi.id`,
  ).bind(...(batchId ? [nowIso, staleIso, batchId] : [nowIso, staleIso])).all()).results;

  let credited = 0, duplicate = 0, unknown = 0, failed = 0, skipped = 0;
  for (const item of items) {
    // 原子抢锁：并发派发时只有抢到的那个进程真正调用插件，抢不到的直接跳过
    const claim = await env.DB.prepare(
      `UPDATE payout_item SET claim_at = ? WHERE id = ? AND status = 'pending'
         AND (claim_at IS NULL OR claim_at < ?)`,
    ).bind(nowIso, item.id, staleIso).run();
    if (claim.meta.changes !== 1) { skipped++; continue; }
    const outcome = await creditPayoutItem(env, item, item.retry_count + 1);
    if (outcome === 'credited') credited++;
    else if (outcome === 'duplicate') duplicate++;
    else if (outcome === 'unknown') unknown++;
    else failed++;
  }

  const ids = new Set<number>(items.map((i: any) => i.batch_id));
  if (batchId) ids.add(batchId);
  for (const id of ids) {
    const t = (await env.DB.prepare(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN status='credited' THEN 1 ELSE 0 END) AS c,
              SUM(CASE WHEN status IN ('failed','exhausted') THEN 1 ELSE 0 END) AS f
         FROM payout_item WHERE batch_id = ?`,
    ).bind(id).first()) as any;
    const total = Number(t?.n || 0), creditedN = Number(t?.c || 0), failedN = Number(t?.f || 0);
    const leftN = total - creditedN - failedN;
    const status = leftN > 0 ? (creditedN > 0 ? 'partial' : 'pending')
      : failedN > 0 && creditedN < total ? 'partial' : 'paid';
    await env.DB.prepare('UPDATE payout_batch SET status = ? WHERE id = ?').bind(status, id).run();
  }
  return { total: items.length, credited, duplicate, unknown, failed, skipped };
}
