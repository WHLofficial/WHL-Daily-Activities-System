// WHL 竞猜系统 — 纯 Worker 入口
// /api/* → handleApi（业务路由，原 Pages Functions 迁移而来）；其余 → 静态资源（public/）
// cron 直接进程内调用，不再依赖外部 cron-worker

import { handleApi, runRecon } from './api';
import { dispatchPending } from './_lib/sync';
import { sendDueReminders } from './_lib/notify';
import { sealExpiredEvents } from './_lib/seal';

export default {
  async fetch(request: Request, env: any, ctx: any): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      // waitUntil 透传给 API 层：发奖同步这类慢外呼转后台跑，响应立即返回
      return handleApi({ request, env, waitUntil: (p: Promise<any>) => ctx.waitUntil(p) });
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event: any, env: any) {
    if (event.cron === '*/5 * * * *') {
      // 先把到点的单子封盘，提醒扫描就不用每轮把过期 open 单扫出来再丢掉
      const seal = await sealExpiredEvents(env);
      const s = await dispatchPending(env);
      const rem = await sendDueReminders(env);
      console.log('[cron] seal:', seal, 'retry:', JSON.stringify(s), 'remind:', JSON.stringify(rem));
    } else if (event.cron === '0 9 * * *') {
      const r = await runRecon(env);
      console.log('[cron] recon:', JSON.stringify(r));
    }
  },
};
