// A9：开放通知与截止前提醒。文本在 report.ts，两条都以 report 行的形式排队，
// 插件侧脚本照旧拉 /api/reports/pending 就行，不需要新接口（kind 字段区分类型）。

import { nowSql } from './http.ts';
import { buildOpenNotice, buildRemindNotice } from './report.ts';
import { maxRewardOf } from './reward.ts';

const REMIND_AHEAD_MS = 4 * 3600 * 1000;

// 开放时调用：入队一条开放通知。距截止已不足 4 小时的（先存草稿再开放，或开放时就卡着点），
// 顺手把 reminded_at 填上，免得刚开放紧跟一条「还有 4 小时截止」。
export async function enqueueOpenNotice(env: any, eventId: number): Promise<boolean> {
  const event = await env.DB.prepare('SELECT * FROM event WHERE id = ?').bind(eventId).first() as any;
  if (!event) return false;
  const matches = (await env.DB.prepare('SELECT id FROM match WHERE event_id = ?').bind(eventId).all()).results as any[];
  const items = (await env.DB.prepare('SELECT type, tier_json FROM play_item WHERE event_id = ?').bind(eventId).all()).results as any[];

  const content = buildOpenNotice(event.title, matches.length, event.deadline, maxRewardOf(items, matches.length));
  const stmts: any[] = [
    env.DB.prepare('INSERT INTO report (id, event_id, content, kind) VALUES (?, ?, ?, ?)')
      .bind(`nt-${crypto.randomUUID()}`, eventId, content, 'open'),
  ];
  if (new Date(event.deadline).getTime() - Date.now() <= REMIND_AHEAD_MS) {
    stmts.push(env.DB.prepare('UPDATE event SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL')
      .bind(nowSql(), eventId));
  }
  await env.DB.batch(stmts);
  return true;
}

// 截止前 4 小时提醒，挂在每 5 分钟的 cron 上。提前量可传参覆盖（补扫/临时调整用）。
// 先原子认领（reminded_at 从 NULL 改掉，改动行数必须为 1）再入队：cron 重叠触发只会有一条进队列。
export async function sendDueReminders(env: any, aheadMs = REMIND_AHEAD_MS): Promise<{ scanned: number; sent: number }> {
  const rows = (await env.DB.prepare(
    `SELECT id, title, deadline FROM event WHERE status = 'open' AND reminded_at IS NULL`,
  ).all()).results as any[];

  const now = Date.now();
  const due = rows
    .map((r) => ({ ...r, left: new Date(r.deadline).getTime() - now }))
    .filter((r) => r.left > 0 && r.left <= aheadMs);

  let sent = 0;
  for (const r of due) {
    const claim = await env.DB.prepare(
      `UPDATE event SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL AND status = 'open'`,
    ).bind(nowSql(), r.id).run();
    if (claim.meta.changes !== 1) continue;

    const joined = await env.DB.prepare(
      `SELECT COUNT(DISTINCT p.user_id) AS n FROM prediction p
         JOIN play_item i ON i.id = p.play_item_id WHERE i.event_id = ?`,
    ).bind(r.id).first() as any;
    const hoursLeft = Math.max(1, Math.round(r.left / 3600_000));
    await env.DB.prepare('INSERT INTO report (id, event_id, content, kind) VALUES (?, ?, ?, ?)')
      .bind(`nt-${crypto.randomUUID()}`, r.id, buildRemindNotice(r.title, joined?.n || 0, hoursLeft), 'remind').run();
    sent++;
  }
  return { scanned: rows.length, sent };
}
