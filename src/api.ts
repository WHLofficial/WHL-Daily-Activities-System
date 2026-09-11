// 全部 API 路由（Pages Functions catch-all）
// 分组：认证/绑定（用户）· 插件方向（HMAC）· 竞猜（用户）· 管理 · 内部（cron）

import { HttpError, json, readBody, nowISO } from './_lib/http.ts';
import {
  sha256hex, createSession, sessionCookie, clearSessionCookie,
  getAuthUser, requireUser, requireRole, requireManager, isInitiator, verifyPluginRequest, assertCronKey,
  rateLimit, mirrorTourUser,
} from './_lib/auth.ts';
import { sha256Hex, tourHashPassword, tourVerifyPassword } from './_lib/tourcrypto.ts';
import { computeSettlement, type ResultInput } from './_lib/judge.ts';
import { dispatchPending, signAndFetch } from './_lib/sync.ts';
import { buildReportText } from './_lib/report.ts';

function uuid(): string {
  return crypto.randomUUID();
}

function sixDigitCode(): string {
  return String(new Uint32Array(crypto.getRandomValues(new Uint32Array(1)))[0] % 1_000_000).padStart(6, '0');
}

// ---- 内容校验 ----

function validateContent(type: string, content: any): string {
  if (type === 'score') {
    const { home, away } = content || {};
    if (![home, away].every((v: any) => Number.isInteger(v) && v >= 0 && v <= 99)) {
      throw new HttpError(400, '比分必须是 0~99 的整数');
    }
    return JSON.stringify({ home, away });
  }
  if (type === 'wdl') {
    if (!['home', 'draw', 'away'].includes(content)) throw new HttpError(400, '胜平负答案不合法');
    return JSON.stringify(content);
  }
  if (type === 'goals') {
    if (!Number.isInteger(content) || content < 0 || content > 20) throw new HttpError(400, '总进球必须是 0~20 的整数');
    return JSON.stringify(content);
  }
  if (type === 'fun') {
    if (typeof content !== 'string' || !content.trim() || content.length > 200) throw new HttpError(400, '趣味题答案不合法');
    return JSON.stringify(content.trim());
  }
  throw new HttpError(400, `未知玩法类型 ${type}`);
}

function validateTiers(type: string, tiers: any): string {
  if (!tiers || typeof tiers !== 'object') throw new HttpError(400, '档位配置不合法');
  const out: Record<string, number> = {};
  const keys = type === 'score' ? ['score', 'goals', 'wdl'] : [type];
  for (const k of keys) {
    const v = tiers[k];
    if (v !== undefined && (!Number.isInteger(v) || v <= 0 || v > 100000)) {
      throw new HttpError(400, `档位 ${k} 必须是 1~100000 的整数`);
    }
    if (v !== undefined) out[k] = v;
  }
  if (!out[type === 'score' ? 'score' : type]) {
    throw new HttpError(400, `${type} 玩法必须配置 ${type === 'score' ? 'score' : type} 档位`);
  }
  return JSON.stringify(out);
}

// ---- 路由 ----

export async function handleApi(ctx: { request: Request; env: any }): Promise<Response> {
  const { request, env } = ctx;
  const url = new URL(request.url);
  const seg = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const method = request.method;

  try {
    if (!env.SYNC_SECRET && (seg[0] === 'bind' || seg[0] === 'reports' || seg[0] === 'internal')) {
      throw new HttpError(500, '服务端未配置 SYNC_SECRET');
    }

    // ---------- 插件方向（HMAC）----------
    if (method === 'POST' && seg[0] === 'bind' && seg[1] === 'claim') {
      const raw = await request.text();
      await verifyPluginRequest(env, request, raw);
      const { code, qq_id } = JSON.parse(raw);
      if (!code || !qq_id) throw new HttpError(400, '缺少 code 或 qq_id');
      const row = await env.DB.prepare(
        `SELECT bc.*, u.display_name FROM bind_codes bc JOIN users u ON u.id = bc.user_id
          WHERE bc.code = ? AND bc.used_at IS NULL AND bc.expires_at > ?`,
      ).bind(String(code), nowISO()).first();
      if (!row) return json({ error: 'invalid_code', message: '绑定码无效或已过期' }, 400);
      const bound = await env.DB.prepare(
        'SELECT user_id, qq_id FROM user_binding WHERE user_id = ? OR qq_id = ?',
      ).bind(row.user_id, String(qq_id)).first();
      if (bound) {
        return json({
          error: bound.qq_id === String(qq_id) ? 'qq_bound' : 'user_bound',
          message: bound.qq_id === String(qq_id) ? '该 QQ 已绑定过账号' : '该账号已绑定过其他 QQ',
        }, 400);
      }
      await env.DB.batch([
        env.DB.prepare('INSERT INTO user_binding (user_id, qq_id) VALUES (?, ?)').bind(row.user_id, String(qq_id)),
        env.DB.prepare('UPDATE bind_codes SET used_at = ? WHERE code = ?').bind(nowISO(), String(code)),
      ]);
      return json({ ok: true, displayName: row.display_name });
    }

    if (method === 'GET' && seg[0] === 'reports' && seg[1] === 'pending') {
      await verifyPluginRequest(env, request, '');
      const rows = (await env.DB.prepare(
        `SELECT id, event_id, content, created_at FROM report WHERE status = 'pending' ORDER BY created_at LIMIT 5`,
      ).all()).results;
      return json({ reports: rows });
    }

    if (method === 'POST' && seg[0] === 'reports' && seg[1] === 'ack') {
      const raw = await request.text();
      await verifyPluginRequest(env, request, raw);
      const { ids } = JSON.parse(raw);
      if (!Array.isArray(ids) || ids.length === 0) throw new HttpError(400, '缺少 ids');
      const stmts = ids.map((id: string) =>
        env.DB.prepare(`UPDATE report SET status = 'sent', sent_at = ? WHERE id = ? AND status = 'pending'`)
          .bind(nowISO(), String(id)));
      await env.DB.batch(stmts);
      return json({ ok: true, acked: ids.length });
    }

    // ---------- 认证 ----------
    // 注册：账号真源在赛事系统 user 表（写入即全站通用），校验规则与赛事系统 /register 逐字一致。
    // 门槛与赛事系统同一套：注册码优先；无码需组织 allow_open_reg 开关放开，产生 locked=1 观众号。
    if (method === 'POST' && seg[0] === 'register') {
      if (!env.TOUR_DB) throw new HttpError(500, '未配置赛事库');
      const ip = request.headers.get('CF-Connecting-IP') || 'local';
      if (!(await rateLimit(env, `reg:${ip}`, 5, 3600))) throw new HttpError(429, '注册太频繁，请一小时后再试');
      const body = await readBody(request);
      const name = String(body.name ?? '').trim();
      const password = String(body.password ?? '');
      if (name.length < 1 || name.length > 32) throw new HttpError(400, '昵称需要 1-32 个字符');
      if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
        throw new HttpError(400, '密码至少 8 位，且要同时包含字母和数字');
      }
      const email = String(body.email ?? '').trim() || null;
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, '邮箱格式不对');

      let locked = 0;
      const code = String(body.signupCode ?? '').trim();
      if (code) {
        const sc = await env.TOUR_DB.prepare(
          'SELECT id, expires_at, max_uses, used_count FROM signup_code WHERE code_hash = ?',
        ).bind(await sha256Hex(code)).first() as any;
        if (!sc) throw new HttpError(400, '注册码无效');
        if (sc.expires_at && sc.expires_at < nowISO()) throw new HttpError(400, '注册码已过期');
        if (sc.max_uses !== null && sc.used_count >= sc.max_uses) throw new HttpError(400, '注册码已用完');
      } else {
        const org = await env.TOUR_DB.prepare('SELECT allow_open_reg FROM organization WHERE id = 1').first() as any;
        if (!org?.allow_open_reg) throw new HttpError(400, '需要注册码');
        locked = 1;
      }

      const dup = await env.TOUR_DB.prepare('SELECT id FROM user WHERE name = ?').bind(name).first();
      if (dup) throw new HttpError(409, '这个昵称已被占用');

      if (code) {
        // 原子核销（与赛事系统同款守卫条件），防并发多用
        const upd = await env.TOUR_DB.prepare(
          'UPDATE signup_code SET used_count = used_count + 1 WHERE code_hash = ? AND (max_uses IS NULL OR used_count < max_uses) AND (expires_at IS NULL OR expires_at > ?)',
        ).bind(await sha256Hex(code), nowISO()).run();
        if (upd.meta.changes !== 1) throw new HttpError(400, '注册码无效或已用完');
      }

      let tourId: number;
      try {
        const ins = await env.TOUR_DB.prepare(
          "INSERT INTO user (name, email, password_hash, role, locked) VALUES (?, ?, ?, 'coach', ?)",
        ).bind(name, email, await tourHashPassword(password), locked).run();
        tourId = Number(ins.meta.last_row_id);
      } catch {
        throw new HttpError(409, '这个昵称已被占用'); // UNIQUE 撞名
      }
      const local = await mirrorTourUser(env, { id: tourId, name, role: 'coach' });
      const token = await createSession(env, local.id);
      return json({ ok: true, locked: locked === 1 }, 200, { 'Set-Cookie': sessionCookie(token) });
    }

    // 改密：写回赛事系统 user 表（共享账号池），两边任一站改密全站生效
    if (method === 'POST' && seg[0] === 'password') {
      const user = await requireUser(env, request);
      if (!env.TOUR_DB) throw new HttpError(500, '未配置赛事库');
      if (!user.tour_id) throw new HttpError(400, '当前账号未关联赛事系统身份');
      const body = await readBody(request);
      const newPassword = String(body.newPassword ?? '');
      if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
        throw new HttpError(400, '密码至少 8 位，且要同时包含字母和数字');
      }
      const row = await env.TOUR_DB.prepare('SELECT password_hash FROM user WHERE id = ?')
        .bind(user.tour_id).first() as any;
      if (!row) throw new HttpError(404, '赛事系统账号不存在');
      if (!(await tourVerifyPassword(String(body.oldPassword ?? ''), row.password_hash))) {
        throw new HttpError(401, '当前密码不正确');
      }
      await env.TOUR_DB.prepare('UPDATE user SET password_hash = ?, must_change_pw = 0 WHERE id = ?')
        .bind(await tourHashPassword(newPassword), user.tour_id).run();
      return json({ ok: true });
    }

    // 登录：验密走赛事系统 user 表（共享账号池，两边注册的账号互通），本地只建会话。
    // must_change_pw=1 与赛事系统同规则：视为不可登录，需先回赛事系统改密。
    if (method === 'POST' && seg[0] === 'login') {
      if (!env.TOUR_DB) throw new HttpError(500, '未配置赛事库');
      const ip = request.headers.get('CF-Connecting-IP') || 'local';
      if (!(await rateLimit(env, `login-ip:${ip}`, 10, 900))) throw new HttpError(429, '尝试太频繁，请 15 分钟后再来');
      const body = await readBody(request);
      const name = String(body.username ?? '').trim();
      if (!name) throw new HttpError(400, '请输入昵称');
      if (!(await rateLimit(env, `login-name:${name}`, 5, 900))) throw new HttpError(429, '这个账号尝试太频繁，请 15 分钟后再来');
      const tour = await env.TOUR_DB.prepare(
        'SELECT id, name, role, locked, must_change_pw, password_hash FROM user WHERE name = ?',
      ).bind(name).first() as any;
      if (!tour || !(await tourVerifyPassword(String(body.password ?? ''), tour.password_hash))) {
        throw new HttpError(401, '昵称或密码不正确');
      }
      if (tour.must_change_pw === 1) throw new HttpError(403, '该账号需先修改密码，请到赛事系统登录修改');
      const local = await mirrorTourUser(env, tour);
      const token = await createSession(env, local.id);
      return json({ ok: true, role: local.role }, 200, { 'Set-Cookie': sessionCookie(token) });
    }

    if (method === 'POST' && seg[0] === 'logout') {
      const token = (request.headers.get('Cookie') || '').match(/whl_sess=([a-f0-9]+)/)?.[1];
      if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256hex(token)).run();
      return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
    }

    if (method === 'GET' && seg[0] === 'me') {
      const user = await getAuthUser(env, request);
      if (!user) return json({ user: null });
      const binding = await env.DB.prepare('SELECT qq_id, bound_at FROM user_binding WHERE user_id = ?').bind(user.id).first();
      // 发起人标记：role=user 但在发起人名单内，前端据此放行管理台
      const isInit = user.role === 'admin' ? true : await isInitiator(env, user.id);
      return json({ user, binding: binding || null, is_initiator: isInit });
    }

    if (method === 'POST' && seg[0] === 'bind' && seg[1] === 'new') {
      const user = await requireUser(env, request);
      const exists = await env.DB.prepare('SELECT qq_id FROM user_binding WHERE user_id = ?').bind(user.id).first();
      if (exists) throw new HttpError(400, `已绑定 QQ ${exists.qq_id}`);
      await env.DB.prepare('UPDATE bind_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL')
        .bind(nowISO(), user.id).run();
      const code = sixDigitCode();
      const expires = new Date(Date.now() + 600_000).toISOString();
      await env.DB.prepare('INSERT INTO bind_codes (code, user_id, expires_at) VALUES (?, ?, ?)')
        .bind(code, user.id, expires).run();
      return json({ code, expiresInSec: 600 });
    }

    // ---------- 竞猜（用户） ----------
    if (method === 'GET' && seg[0] === 'events' && seg.length === 1) {
      const user = await requireUser(env, request);
      const events = (await env.DB.prepare(
        `SELECT e.*, (SELECT COUNT(DISTINCT p.user_id) FROM prediction p
                        JOIN play_item i ON i.id = p.play_item_id
                        JOIN match m ON m.id = i.match_id WHERE m.event_id = e.id) AS participants
           FROM event e WHERE e.status != 'draft' ORDER BY e.created_at DESC LIMIT 20`,
      ).all()).results as any[];
      const mine = await env.DB.prepare(
        `SELECT m.event_id, COUNT(*) AS n FROM prediction p
           JOIN play_item i ON i.id = p.play_item_id JOIN match m ON m.id = i.match_id
          WHERE p.user_id = ? GROUP BY m.event_id`,
      ).bind(user.id).all();
      const mineMap = new Map(mine.results.map((r: any) => [r.event_id, r.n]));
      return json({
        events: events.map((e) => ({ ...e, myPredictions: mineMap.get(e.id) || 0 })),
      });
    }

    if (method === 'GET' && seg[0] === 'events' && seg.length === 2) {
      const user = await requireUser(env, request);
      const event = await env.DB.prepare(
        `SELECT * FROM event WHERE id = ? AND status != 'draft'`,
      ).bind(Number(seg[1])).first() as any;
      if (!event) throw new HttpError(404, '竞猜不存在');
      const matches = (await env.DB.prepare('SELECT * FROM match WHERE event_id = ? ORDER BY id').bind(event.id).all()).results as any[];
      const items = (await env.DB.prepare(
        `SELECT i.* FROM play_item i JOIN match m ON m.id = i.match_id WHERE m.event_id = ? ORDER BY m.id, i.sort, i.id`,
      ).bind(event.id).all()).results as any[];
      const myPreds = (await env.DB.prepare(
        `SELECT p.play_item_id, p.content_json FROM prediction p
           JOIN play_item i ON i.id = p.play_item_id JOIN match m ON m.id = i.match_id
          WHERE m.event_id = ? AND p.user_id = ?`,
      ).bind(event.id, user.id).all()).results as any[];
      const participants = (await env.DB.prepare(
        `SELECT COUNT(DISTINCT p.user_id) AS n FROM prediction p
           JOIN play_item i ON i.id = p.play_item_id JOIN match m ON m.id = i.match_id
          WHERE m.event_id = ?`,
      ).bind(event.id).first() as any).n;
      if (event.status === 'settled' || event.status === 'paid') {
        const st = await env.DB.prepare('SELECT detail_json, total_amount FROM settlement WHERE event_id = ?').bind(event.id).first() as any;
        if (st) {
          const detail = JSON.parse(st.detail_json);
          event.myResult = detail.find((d: any) => d.user_id === user.id) || { total: 0, items: [] };
          event.totalAmount = st.total_amount;
        }
      }
      return json({
        event, matches, items,
        myPredictions: Object.fromEntries(myPreds.map((p) => [p.play_item_id, JSON.parse(p.content_json)])),
        participants,
      });
    }

    if (method === 'PUT' && seg[0] === 'events' && seg[2] === 'predictions' && seg.length === 3) {
      const user = await requireUser(env, request);
      const bound = await env.DB.prepare('SELECT 1 AS ok FROM user_binding WHERE user_id = ?').bind(user.id).first();
      if (!bound) throw new HttpError(403, '请先完成 QQ 绑定再提交预测', 'need_binding');
      const event = await env.DB.prepare('SELECT * FROM event WHERE id = ?').bind(Number(seg[1])).first() as any;
      if (!event) throw new HttpError(404, '竞猜不存在');
      if (event.status !== 'open') throw new HttpError(400, '本次竞猜不在提交时段');
      if (new Date(event.deadline).getTime() <= Date.now()) throw new HttpError(400, '已过提交截止时间');
      const body = await readBody(request);
      const preds: any[] = body.predictions || [];
      if (!Array.isArray(preds) || preds.length === 0) throw new HttpError(400, '没有可提交的预测');
      const stmts = [];
      for (const p of preds) {
        const item = await env.DB.prepare(
          `SELECT i.* FROM play_item i JOIN match m ON m.id = i.match_id WHERE i.id = ? AND m.event_id = ?`,
        ).bind(Number(p.playItemId), event.id).first() as any;
        if (!item) throw new HttpError(400, `玩法项 ${p.playItemId} 不属于本次竞猜`);
        const contentJson = validateContent(item.type, p.content);
        stmts.push(env.DB.prepare(
          `INSERT INTO prediction (play_item_id, user_id, content_json) VALUES (?, ?, ?)
             ON CONFLICT (play_item_id, user_id)
             DO UPDATE SET content_json = excluded.content_json, updated_at = excluded.updated_at`,
        ).bind(item.id, user.id, contentJson));
      }
      await env.DB.batch(stmts);
      return json({ ok: true, saved: stmts.length });
    }

    // ---------- 管理 ----------
    if (seg[0] === 'admin') {
      const user = await requireManager(env, request);
      const eventId = seg[1] === 'events' && seg[2] ? Number(seg[2]) : 0;

      if (method === 'GET' && seg[1] === 'defaults') {
        const rows = (await env.DB.prepare('SELECT key, value FROM settings').all()).results as any[];
        const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
        return json({ tiers: JSON.parse(s.default_tiers || '{}'), rewardCap: Number(s.reward_cap_default || 1000) });
      }

      // 账号列表（含赛事系统镜像标记与发起人状态）
      if (method === 'GET' && seg[1] === 'users' && seg.length === 2) {
        if (user.role !== 'admin') throw new HttpError(403, '仅管理员可查看账号');
        const rows = (await env.DB.prepare(
          `SELECT u.id, u.username, u.display_name, u.role, u.tour_id,
                  (b.user_id IS NOT NULL) AS bound,
                  (i.user_id IS NOT NULL) AS is_initiator
             FROM users u
             LEFT JOIN user_binding b ON b.user_id = u.id
             LEFT JOIN initiators i ON i.user_id = u.id
            ORDER BY u.id LIMIT 200`,
        ).all()).results;
        return json({ users: rows });
      }

      // 发起人名单开关
      if (method === 'POST' && seg[1] === 'initiators' && seg.length === 2) {
        if (user.role !== 'admin') throw new HttpError(403, '仅管理员可设置发起人');
        const body = await readBody(request);
        const userId = Number(body.userId);
        if (!Number.isInteger(userId)) throw new HttpError(400, 'userId 不合法');
        if (body.on) {
          await env.DB.prepare('INSERT INTO initiators (user_id) VALUES (?) ON CONFLICT DO NOTHING').bind(userId).run();
        } else {
          await env.DB.prepare('DELETE FROM initiators WHERE user_id = ?').bind(userId).run();
        }
        return json({ ok: true });
      }

      // 管理列表：包含草稿
      if (method === 'GET' && seg[1] === 'events' && seg.length === 2) {
        const events = (await env.DB.prepare(
          `SELECT e.*, (SELECT COUNT(DISTINCT p.user_id) FROM prediction p
                          JOIN play_item i ON i.id = p.play_item_id
                          JOIN match m ON m.id = i.match_id WHERE m.event_id = e.id) AS participants
             FROM event e ORDER BY e.created_at DESC LIMIT 50`,
        ).all()).results;
        return json({ events });
      }

      if (method === 'POST' && seg[1] === 'events' && seg.length === 2) {
        const body = await readBody(request);
        const title = String(body.title || '').trim();
        if (!title || title.length > 60) throw new HttpError(400, '标题 1~60 字');
        if (!body.deadline || isNaN(Date.parse(body.deadline))) throw new HttpError(400, '截止时间不合法');
        if (new Date(body.deadline).getTime() <= Date.now()) throw new HttpError(400, '截止时间必须在未来');
        const rewardCap = Number(body.rewardCap);
        if (!Number.isInteger(rewardCap) || rewardCap <= 0) throw new HttpError(400, '奖励上限不合法');
        const matches: any[] = body.matches || [];
        if (matches.length < 1 || matches.length > 3) throw new HttpError(400, '比赛场次 1~3 场');

        // 先整体校验再落库：任何一项不合法都直接拒绝，不留半成品竞猜
        const matchRows: { home: string; away: string; kickoff: any }[] = [];
        const itemRows: { mi: number; type: string; question: string; tierJson: string; cap: number | null; sort: number }[] = [];
        matches.forEach((m: any, mi: number) => {
          matchRows.push({
            home: String(m.home || '').trim() || '主队',
            away: String(m.away || '').trim() || '客队',
            kickoff: m.kickoff || null,
          });
          const items: any[] = m.items || [];
          if (items.length < 1 || items.length > 6) throw new HttpError(400, '每场比赛 1~6 个玩法项');
          for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const type = String(it.type);
            if (!['score', 'wdl', 'goals', 'fun'].includes(type)) throw new HttpError(400, `未知玩法类型 ${type}`);
            const question = String(it.question || '').trim() || { score: '猜比分', wdl: '胜平负', goals: '总进球', fun: '趣味题' }[type];
            itemRows.push({ mi, type, question, tierJson: validateTiers(type, it.tiers), cap: it.cap ? Number(it.cap) : null, sort: i });
          }
        });

        const er = await env.DB.prepare(
          `INSERT INTO event (title, status, created_by, deadline, reward_cap) VALUES (?, ?, ?, ?, ?)`,
        ).bind(title, body.openNow ? 'open' : 'draft', user.id, new Date(body.deadline).toISOString(), rewardCap).run();
        const eid = er.meta.last_row_id;

        try {
          const mrs = await env.DB.batch(matchRows.map((m) =>
            env.DB.prepare('INSERT INTO match (event_id, home, away, kickoff) VALUES (?, ?, ?, ?)')
              .bind(eid, m.home, m.away, m.kickoff)));
          const mids = mrs.map((r: any) => r.meta.last_row_id);
          await env.DB.batch(itemRows.map((ir) =>
            env.DB.prepare('INSERT INTO play_item (match_id, type, question, tier_json, reward_cap, sort) VALUES (?, ?, ?, ?, ?, ?)')
              .bind(mids[ir.mi], ir.type, ir.question, ir.tierJson, ir.cap, ir.sort)));
        } catch (e) {
          // 落库中途失败（基础设施错误而非校验问题）：清掉已写入部分，不留孤儿期
          await env.DB.batch([
            env.DB.prepare('DELETE FROM play_item WHERE match_id IN (SELECT id FROM match WHERE event_id = ?)').bind(eid),
            env.DB.prepare('DELETE FROM match WHERE event_id = ?').bind(eid),
            env.DB.prepare('DELETE FROM event WHERE id = ?').bind(eid),
          ]);
          throw e;
        }
        return json({ ok: true, eventId: eid });
      }

      const isEventRoute = seg[1] === 'events' && seg.length >= 3;
      if (isEventRoute && !eventId) throw new HttpError(404, '缺少竞猜 id');
      const event = isEventRoute
        ? await env.DB.prepare('SELECT * FROM event WHERE id = ?').bind(eventId).first() as any
        : null;
      if (isEventRoute && !event) throw new HttpError(404, '竞猜不存在');

      if (isEventRoute && method === 'GET' && seg.length === 3) {
        const matches = (await env.DB.prepare('SELECT * FROM match WHERE event_id = ? ORDER BY id').bind(eventId).all()).results;
        const items = (await env.DB.prepare(
          `SELECT i.* FROM play_item i JOIN match m ON m.id = i.match_id WHERE m.event_id = ? ORDER BY m.id, i.sort, i.id`,
        ).bind(eventId).all()).results as any[];
        const preds = (await env.DB.prepare(
          `SELECT p.*, u.display_name FROM prediction p
             JOIN play_item i ON i.id = p.play_item_id JOIN match m ON m.id = i.match_id
             JOIN users u ON u.id = p.user_id
            WHERE m.event_id = ? ORDER BY u.id`,
        ).bind(eventId).all()).results as any[];
        const bindings = (await env.DB.prepare(
          `SELECT DISTINCT p.user_id, b.qq_id FROM prediction p
             JOIN play_item i ON i.id = p.play_item_id JOIN match m ON m.id = i.match_id
             LEFT JOIN user_binding b ON b.user_id = p.user_id
            WHERE m.event_id = ?`,
        ).bind(eventId).all()).results as any[];
        const qqMap = new Map(bindings.map((b) => [b.user_id, b.qq_id]));
        const st = await env.DB.prepare('SELECT * FROM settlement WHERE event_id = ?').bind(eventId).first() as any;
        const batch = await env.DB.prepare('SELECT * FROM payout_batch WHERE event_id = ?').bind(eventId).first() as any;
        return json({
          event, matches, items,
          predictions: preds.map((p) => ({
            userId: p.user_id, name: p.display_name, playItemId: p.play_item_id,
            content: JSON.parse(p.content_json), qq: qqMap.get(p.user_id) || null,
          })),
          settlement: st ? {
            detail: JSON.parse(st.detail_json), total: st.total_amount,
            breaches: JSON.parse(st.result_json).breaches || [],
            result: JSON.parse(st.result_json), confirmedBy: st.confirmed_by,
          } : null,
          batch: batch || null,
        });
      }

      if (isEventRoute && method === 'POST' && seg[3] === 'open') {
        if (event.status !== 'draft') throw new HttpError(400, '只有草稿能开放');
        await env.DB.prepare(`UPDATE event SET status = 'open' WHERE id = ?`).bind(eventId).run();
        return json({ ok: true });
      }

      if (isEventRoute && method === 'POST' && seg[3] === 'seal') {
        if (event.status !== 'open') throw new HttpError(400, '只有开放中的竞猜可以截止');
        await env.DB.prepare(`UPDATE event SET status = 'sealed' WHERE id = ?`).bind(eventId).run();
        return json({ ok: true });
      }

      if (isEventRoute && method === 'POST' && seg[3] === 'archive') {
        if (!['paid'].includes(event.status)) throw new HttpError(400, '只有已发奖的竞猜可以归档');
        await env.DB.prepare(`UPDATE event SET status = 'archived' WHERE id = ?`).bind(eventId).run();
        return json({ ok: true });
      }

      if (isEventRoute && method === 'POST' && seg[3] === 'result') {
        if (!['sealed', 'settled'].includes(event.status)) throw new HttpError(400, '先截止才能录结果');
        const body = await readBody(request);
        const input: ResultInput = { results: body.results || [], fun: body.fun || [] };
        const matches = (await env.DB.prepare('SELECT * FROM match WHERE event_id = ?').bind(eventId).all()).results as any[];
        const items = (await env.DB.prepare(
          `SELECT i.* FROM play_item i JOIN match m ON m.id = i.match_id WHERE m.event_id = ?`,
        ).bind(eventId).all()).results as any[];
        for (const r of input.results) {
          if (!matches.some((m) => m.id === r.matchId)) throw new HttpError(400, '场次不属于本次竞猜');
          if (![r.home, r.away].every((v: any) => Number.isInteger(v) && v >= 0 && v <= 99)) {
            throw new HttpError(400, '比分必须是 0~99 的整数');
          }
        }
        for (const f of input.fun) {
          if (!items.some((i) => i.id === f.itemId && i.type === 'fun')) throw new HttpError(400, '趣味题不属于本次竞猜');
        }
        const preds = (await env.DB.prepare(
          `SELECT p.play_item_id, p.user_id, p.content_json FROM prediction p
             JOIN play_item i ON i.id = p.play_item_id JOIN match m ON m.id = i.match_id WHERE m.event_id = ?`,
        ).bind(eventId).all()).results as any[];
        const users = (await env.DB.prepare(
          `SELECT DISTINCT u.id, u.display_name FROM users u
             JOIN prediction p ON p.user_id = u.id
             JOIN play_item i ON i.id = p.play_item_id JOIN match m ON m.id = i.match_id
            WHERE m.event_id = ?`,
        ).bind(eventId).all()).results as any[];
        const names = Object.fromEntries(users.map((u) => [u.id, u.display_name || u.username]));

        const s = computeSettlement(event, items, preds, names, input);
        const resultJson = JSON.stringify({ ...JSON.parse(s.resultJson), breaches: s.breaches });
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO settlement (event_id, result_json, detail_json, total_amount, cap_breached)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (event_id) DO UPDATE SET
                 result_json = excluded.result_json, detail_json = excluded.detail_json,
                 total_amount = excluded.total_amount, cap_breached = excluded.cap_breached,
                 computed_at = excluded.computed_at, confirmed_by = NULL`,
          ).bind(eventId, resultJson, JSON.stringify(s.rows), s.totalAmount, s.breaches.length > 0 ? 1 : 0),
          env.DB.prepare(`UPDATE event SET status = 'settled' WHERE id = ?`).bind(eventId),
        ]);
        return json({ ok: true, total: s.totalAmount, players: s.rows.length, breaches: s.breaches });
      }

      if (isEventRoute && method === 'POST' && seg[3] === 'confirm') {
        // 已确认过的竞猜直接回既有批次：双击、并发、确认中途出错后重来都走这里，不再撞 event_id UNIQUE
        const replyExisting = async (bid: number) => {
          const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM payout_item WHERE batch_id = ?')
            .bind(bid).first()) as any;
          const dispatch = await dispatchPending(env, bid);
          return json({
            ok: true, alreadyConfirmed: true, batchId: bid,
            payoutCount: Number(n?.n || 0), unbound: [], dispatch,
          });
        };
        const done = (await env.DB.prepare('SELECT id FROM payout_batch WHERE event_id = ?')
          .bind(eventId).first()) as any;
        if (done) return replyExisting(done.id);

        if (event.status === 'paid') {
          // 无人命中时确认发奖不建批次，只把状态推到「已发奖」，重复点击会落到这里
          return json({
            ok: true, alreadyConfirmed: true, skipped: true, reason: 'no_hits',
            batchId: null, payoutCount: 0, unbound: [], dispatch: null,
          });
        }
        if (event.status !== 'settled') throw new HttpError(400, '先录结果再确认发奖');
        const body = await readBody(request);
        const st = await env.DB.prepare('SELECT * FROM settlement WHERE event_id = ?').bind(eventId).first() as any;
        if (!st) throw new HttpError(400, '没有结算数据');
        const breaches = st.cap_breached as number;
        if (breaches && !body.overrideCap) throw new HttpError(400, '存在奖励超限的玩法项，需勾选「知晓超限」后才能确认');

        const detail = JSON.parse(st.detail_json) as any[];
        // 无人命中：跳过建批次、发放项与流水，只把状态推到「已发奖」，不留空批次占位
        if (detail.every((d) => Number(d.total) === 0)) {
          await env.DB.batch([
            env.DB.prepare('UPDATE settlement SET confirmed_by = ? WHERE event_id = ?').bind(user.id, eventId),
            env.DB.prepare(`UPDATE event SET status = 'paid' WHERE id = ?`).bind(eventId),
          ]);
          return json({
            ok: true, skipped: true, reason: 'no_hits', batchId: null,
            payoutCount: 0, unbound: [], dispatch: null, report: null,
          });
        }
        const results = JSON.parse(st.result_json);
        const bindings = (await env.DB.prepare('SELECT user_id, qq_id FROM user_binding').all()).results as any[];
        const qqMap = new Map(bindings.map((b) => [b.user_id, b.qq_id]));
        const payable = detail.filter((d: any) => d.total > 0 && qqMap.has(d.user_id));
        const unbound = detail.filter((d: any) => d.total > 0 && !qqMap.has(d.user_id)).map((d: any) => d.name);
        if (payable.length === 0) {
          throw new HttpError(400, `有 ${unbound.length} 人获得积分但没有绑定 QQ，无法发放：${unbound.join('、')}`);
        }

        const matches = (await env.DB.prepare('SELECT * FROM match WHERE event_id = ? ORDER BY id').bind(eventId).all()).results as any[];
        const items = (await env.DB.prepare(
          `SELECT i.* FROM play_item i JOIN match m ON m.id = i.match_id WHERE m.event_id = ? ORDER BY m.id, i.sort`,
        ).bind(eventId).all()).results as any[];
        const actualScores: Record<number, any> = {};
        for (const r of results.results || []) actualScores[r.matchId] = { home: r.home, away: r.away };
        const reportText = buildReportText(event, matches, items, actualScores, payable, st.total_amount as number);

        const batchTotal = payable.reduce((s: number, d: any) => s + d.total, 0);
        let batchId: number;
        try {
          const br = await env.DB.prepare(
            'INSERT INTO payout_batch (event_id, status, total_amount) VALUES (?, ?, ?)',
          ).bind(eventId, 'pending', batchTotal).run();
          batchId = br.meta.last_row_id as number;
        } catch (e: any) {
          // 并发确认：另一个请求已抢先建批次（event_id UNIQUE 拦下本次 INSERT），回既有批次
          if (String(e?.message || '').includes('UNIQUE')) {
            const again = (await env.DB.prepare('SELECT id FROM payout_batch WHERE event_id = ?')
              .bind(eventId).first()) as any;
            if (again) return replyExisting(again.id);
          }
          throw e;
        }

        const stmts: any[] = [];
        const payoutIds: string[] = [];
        for (const d of payable) {
          const payoutId = `po-${uuid()}`;
          payoutIds.push(payoutId);
          stmts.push(env.DB.prepare(
            `INSERT INTO payout_item (batch_id, user_id, qq_id, amount, breakdown_json, payout_id)
               VALUES (?, ?, ?, ?, ?, ?)`,
          ).bind(batchId, d.user_id, qqMap.get(d.user_id), d.total, JSON.stringify({ kind: 'reward', items: d.items }), payoutId));
          stmts.push(env.DB.prepare(
            `INSERT INTO ledger_mirror (payout_id, user_id, qq_id, amount, type, event_id)
               VALUES (?, ?, ?, ?, 'reward', ?)`,
          ).bind(payoutId, d.user_id, qqMap.get(d.user_id), d.total, eventId));
        }
        stmts.push(env.DB.prepare(
          'INSERT INTO report (id, event_id, content) VALUES (?, ?, ?)',
        ).bind(`rp-${uuid()}`, eventId, reportText));
        stmts.push(env.DB.prepare(
          `UPDATE settlement SET confirmed_by = ? WHERE event_id = ?`,
        ).bind(user.id, eventId));
        stmts.push(env.DB.prepare(`UPDATE event SET status = 'paid' WHERE id = ?`).bind(eventId));
        await env.DB.batch(stmts);

        const summary = await dispatchPending(env, batchId);
        return json({ ok: true, batchId, payoutCount: payable.length, unbound, dispatch: summary, report: reportText });
      }

      // ---- 批次/发放项 ----
      if (method === 'GET' && seg[1] === 'batches' && seg[2]) {
        const batch = await env.DB.prepare(
          `SELECT b.*, e.title FROM payout_batch b JOIN event e ON e.id = b.event_id WHERE b.id = ?`,
        ).bind(Number(seg[2])).first() as any;
        if (!batch) throw new HttpError(404, '批次不存在');
        const items = (await env.DB.prepare(
          `SELECT pi.id, pi.amount, pi.qq_id, pi.status, pi.retry_count, pi.next_retry_at, pi.last_error,
                  pi.payout_id, pi.credited_at, u.display_name
             FROM payout_item pi JOIN users u ON u.id = pi.user_id WHERE pi.batch_id = ? ORDER BY pi.id`,
        ).bind(batch.id).all()).results;
        return json({ batch, items });
      }

      if (method === 'POST' && seg[1] === 'batches' && seg[3] === 'retry') {
        const batchId = Number(seg[2]);
        await env.DB.prepare(
          `UPDATE payout_item SET status = 'pending', retry_count = 0, next_retry_at = NULL, claim_at = NULL
             WHERE batch_id = ? AND status IN ('pending', 'failed', 'exhausted')`,
        ).bind(batchId).run();
        const summary = await dispatchPending(env, batchId);
        return json({ ok: true, dispatch: summary });
      }

      if (method === 'POST' && seg[1] === 'payouts' && seg[3] === 'reverse') {
        if (user.role !== 'admin') throw new HttpError(403, '仅管理员可冲正');
        const item = await env.DB.prepare(
          `SELECT pi.*, b.event_id FROM payout_item pi JOIN payout_batch b ON b.id = pi.batch_id WHERE pi.payout_id = ?`,
        ).bind(seg[2]).first() as any;
        if (!item) throw new HttpError(404, '发放项不存在');
        if (item.status !== 'credited') throw new HttpError(400, '只有已入账的发放项可以冲正');
        const reversalId = `po-${uuid()}`;
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO payout_item (batch_id, user_id, qq_id, amount, breakdown_json, payout_id)
               VALUES (?, ?, ?, ?, ?, ?)`,
          ).bind(item.batch_id, item.user_id, item.qq_id, item.amount,
            JSON.stringify({ kind: 'reversal', reversalOf: item.payout_id }), reversalId),
          env.DB.prepare(
            `INSERT INTO ledger_mirror (payout_id, user_id, qq_id, amount, type, event_id)
               VALUES (?, ?, ?, ?, 'reversal', ?)`,
          ).bind(reversalId, item.user_id, item.qq_id, -item.amount, item.event_id),
          env.DB.prepare(`UPDATE payout_item SET status = 'reversed' WHERE id = ?`).bind(item.id),
        ]);
        const summary = await dispatchPending(env, item.batch_id);
        return json({ ok: true, reversalId, dispatch: summary });
      }

      if (method === 'GET' && seg[1] === 'recon') {
        if (user.role !== 'admin') throw new HttpError(403, '仅管理员可查看对账');
        const rows = (await env.DB.prepare('SELECT * FROM recon_run ORDER BY id DESC LIMIT 10').all()).results;
        return json({ runs: rows });
      }

      throw new HttpError(404, '未知管理接口');
    }

    // ---------- 内部（cron 调用） ----------
    if (method === 'POST' && seg[0] === 'internal' && seg[1] === 'retry') {
      await assertCronKey(env, request);
      return json(await dispatchPending(env));
    }

    if (method === 'POST' && seg[0] === 'internal' && seg[1] === 'recon') {
      await assertCronKey(env, request);
      const target = url.searchParams.get('date') || shanghaiDate(new Date(Date.now() - 86400_000));
      return json(await runRecon(env, target));
    }

    throw new HttpError(404, '未知接口');
  } catch (e: any) {
    if (e instanceof HttpError) {
      return e.code
        ? json({ error: e.code, message: e.message }, e.status)
        : json({ error: e.message }, e.status);
    }
    console.error('API error:', e);
    return json({ error: `服务器内部错误: ${String(e?.message || e)}` }, 500);
  }
}

function shanghaiDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(d); // YYYY-MM-DD
}

export async function runRecon(env: any, target?: string) {
  target = target || shanghaiDate(new Date(Date.now() - 86400_000));
  const expectRows = (await env.DB.prepare(
    `SELECT qq_id, SUM(amount) AS total, COUNT(*) AS n FROM ledger_mirror
      WHERE date(mirrored_at, '+8 hours') = ? GROUP BY qq_id`,
  ).bind(target).all()).results as any[];

  const expectMap = new Map<string, number>(expectRows.map((r) => [String(r.qq_id), r.total]));
  const actualMap = new Map<string, number>();
  let status = 'ok';
  let note = '';

  try {
    const res = await signAndFetch(env, 'GET', `/sync/summary?date=${encodeURIComponent(target)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j: any = await res.json();
    for (const i of j.items || []) actualMap.set(String(i.qq_id), i.total);
  } catch (e: any) {
    status = 'error';
    note = String(e?.message || e).slice(0, 300);
  }

  const dumps = {
    expect: JSON.stringify([...expectMap.entries()].map(([qq_id, total]) => ({ qq_id, total }))),
    actual: JSON.stringify([...actualMap.entries()].map(([qq_id, total]) => ({ qq_id, total }))),
  };

  if (status === 'error') {
    await env.DB.prepare(
      `INSERT INTO recon_run (target_date, expect_json, status) VALUES (?, ?, 'error')`,
    ).bind(target, dumps.expect).run();
    return { status, note };
  }

  const diffs: { qq_id: string; expect: number; actual: number; diff: number }[] = [];
  for (const qq of new Set<string>([...expectMap.keys(), ...actualMap.keys()])) {
    const eAmt = expectMap.get(qq) || 0;
    const aAmt = actualMap.get(qq) || 0;
    if (eAmt !== aAmt) diffs.push({ qq_id: qq, expect: eAmt, actual: aAmt, diff: eAmt - aAmt });
  }
  status = diffs.length ? 'diff' : 'ok';
  await env.DB.prepare(
    `INSERT INTO recon_run (target_date, expect_json, actual_json, diff_json, status)
       VALUES (?, ?, ?, ?, ?)`,
  ).bind(target, dumps.expect, dumps.actual, JSON.stringify(diffs), status).run();
  return { status, diffs, note };
}
