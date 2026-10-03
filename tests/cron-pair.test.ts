import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// wrangler.jsonc 的 crons 与 src/index.ts scheduled 分支串是手工双写：
// 错配 = 对应任务静默停跑且系统无 cron 告警（v1.0.2 修的 8 小时错配就发生在这类双写上）。
// 静态锁保证两处永远一致，改任何一侧必须同步另一侧并改本测试。
const root = fileURLToPath(new URL('..', import.meta.url));
const crons: string[] = JSON.parse(
  readFileSync(root + 'wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''),
).triggers.crons;
const indexSrc = readFileSync(root + 'src/index.ts', 'utf8');
const branches = [...indexSrc.matchAll(/event\.cron === '([^']+)'/g)].map((m) => m[1]);

describe('cron 表达式双写一致性（wrangler.jsonc ↔ src/index.ts）', () => {
  it('每个 crons 条目都有对应 scheduled 分支（防漏触发）', () => {
    for (const c of crons) expect(branches, `缺分支：${c}`).toContain(c);
  });

  it('每个 scheduled 分支都登记在 crons 里（防死分支）', () => {
    for (const b of branches) expect(crons, `死分支：${b}`).toContain(b);
  });

  // 对账承诺是「每天 09:00 北京时间」；CF cron 按 UTC 解释，0 1 * * * = 北京 09:00。
  // 改这条必须连带核对注释/管理台/README/DEPLOY 的时间承诺文案。
  it('对账表达式为 0 1 * * *（UTC，= 北京时间 09:00）', () => {
    expect(crons).toContain('0 1 * * *');
  });
});
