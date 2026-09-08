// WHL 竞猜系统 — Cron Worker（薄壳）
// 定时触发后调用 Pages 的内部端点，重试/对账逻辑只维护一份（在 functions/api/[[path]].ts）。
// 部署时配置：var APP_URL = Pages 站点地址；secret CRON_SECRET = 与 Pages 一致。

export default {
  async scheduled(event, env, ctx) {
    const base = (env.APP_URL || '').replace(/\/$/, '');
    if (!base || !env.CRON_SECRET) {
      console.error('cron worker 未配置 APP_URL / CRON_SECRET');
      return;
    }
    if (event.cron === '*/5 * * * *') {
      await call(env, `${base}/api/internal/retry`);      // F2/F3：重试未到账发放项
    } else if (event.cron === '0 9 * * *') {
      await call(env, `${base}/api/internal/recon`);      // F5：每日对账（北京时间 09:00，对昨天）
    }
  },
};

async function call(env, url) {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'X-Cron-Key': env.CRON_SECRET } });
    console.log(`[cron] ${url} -> ${res.status} ${(await res.text()).slice(0, 500)}`);
  } catch (e) {
    console.error(`[cron] ${url} failed: ${e}`);
  }
}
