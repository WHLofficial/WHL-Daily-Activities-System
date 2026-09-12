// 到点自动截止：把已过 deadline 的 open 竞猜置为 sealed。
// 提交接口本来就有「status==='open' 且未过 deadline」双保险，这里收敛的是
// 状态展示（列表一直「进行中」）与提醒扫描（过期单每 5 分钟被扫出来再丢掉）的脏数据。

import { nowISO } from './http.ts';

export async function sealExpiredEvents(env: any): Promise<number> {
  const r = await env.DB.prepare(
    `UPDATE event SET status = 'sealed' WHERE status = 'open' AND deadline <= ?`,
  ).bind(nowISO()).run();
  return r.meta?.changes ?? 0;
}
