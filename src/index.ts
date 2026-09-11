// WHL 竞猜系统 — 纯 Worker 入口
// /api/* → handleApi（业务路由，原 Pages Functions 迁移而来）；其余 → 静态资源（public/）
// cron 直接进程内调用，不再依赖外部 cron-worker

import { handleApi, runRecon } from './api';
import { dispatchPending } from './_lib/sync';
import { sendDueReminders } from './_lib/notify';

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handleApi({ request, env });
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event: any, env: any) {
    if (event.cron === '*/5 * * * *') {
      const s = await dispatchPending(env);
      const rem = await sendDueReminders(env);
      console.log('[cron] retry:', JSON.stringify(s), 'remind:', JSON.stringify(rem));
    } else if (event.cron === '0 9 * * *') {
      const r = await runRecon(env);
      console.log('[cron] recon:', JSON.stringify(r));
    }
  },
};
