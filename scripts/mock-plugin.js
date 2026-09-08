// 模拟 AstrBot 插件侧 HTTP 端点：用于本地验证发奖成功/重试/对账闭环。
// 用法：SYNC_SECRET=testsecret node scripts/mock-plugin.js [port]
const http = require('http');
const crypto = require('crypto');

const SECRET = process.env.SYNC_SECRET || 'testsecret';
const PORT = Number(process.argv[2] || 9991);
const seen = new Set(); // payout_id 去重
const credits = []; // {payout_id, qq_id, amount, date(UTC+8), ts}

function verifySign(method, pathWithQuery, ts, rawBody, sign) {
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(ts)) > 300) return false;
  const expect = crypto.createHmac('sha256', SECRET)
    .update(`${method}|${pathWithQuery}|${ts}|${rawBody}`).digest('hex');
  const a = Buffer.from(expect), b = Buffer.from(String(sign || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function shanghaiDate(d) {
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const ok = (j) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    const bad = (code, j) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    const u = new URL(req.url, 'http://x');
    const pathWithQuery = req.url;

    if (req.method === 'POST' && u.pathname === '/sync/credit') {
      if (!verifySign('POST', pathWithQuery, req.headers['x-timestamp'], raw, req.headers['x-sign']))
        return bad(401, { error: 'bad sign' });
      const b = JSON.parse(raw || '{}');
      if (!b.payout_id || !b.qq_id || !Number.isInteger(b.amount)) return bad(400, { error: 'bad body' });
      const dup = seen.has(b.payout_id);
      seen.add(b.payout_id);
      if (!dup) credits.push({ ...b, date: shanghaiDate(new Date()), ts: Date.now() });
      console.log(`[mock] credit payout_id=${b.payout_id} qq=${b.qq_id} amount=${b.amount} duplicate=${dup}`);
      return ok({ ok: true, duplicate: dup });
    }

    if (req.method === 'GET' && u.pathname === '/sync/summary') {
      if (!verifySign('GET', pathWithQuery, req.headers['x-timestamp'], '', req.headers['x-sign']))
        return bad(401, { error: 'bad sign' });
      const date = u.searchParams.get('date') || shanghaiDate(new Date());
      const map = new Map();
      for (const c of credits) {
        if (c.date !== date) continue;
        map.set(String(c.qq_id), (map.get(String(c.qq_id)) || 0) + c.amount);
      }
      const items = [...map.entries()].map(([qq_id, total]) => ({ qq_id, total }));
      console.log(`[mock] summary date=${date} -> ${JSON.stringify(items)}`);
      return ok({ date, items });
    }

    bad(404, { error: 'not found' });
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`[mock] plugin listening on http://127.0.0.1:${PORT} secret=${SECRET ? '(set)' : '(empty)'}`));
