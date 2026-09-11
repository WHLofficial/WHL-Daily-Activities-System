// 展示用「最高可得」：把一个竞猜里每个玩法项的最高档相加。
// 这是玩家全对时的真实满分，和 event.reward_cap 那种「兑奖上限」不是一回事。

export function maxRewardOf(items: { type: string; tier_json: string }[], matchCount: number): number {
  let sum = 0;
  for (const it of items) {
    let tiers: any = {};
    try {
      tiers = JSON.parse(it.tier_json || '{}');
    } catch {
      continue; // 档位损坏不影响展示，跳过该项
    }
    sum += maxTierOf(it.type, tiers, matchCount);
  }
  return sum;
}

function maxTierOf(type: string, tiers: any, matchCount: number): number {
  if (type === 'wdl_all') {
    if (tiers.mode === 'per_hit') return (Number(tiers.perHit) || 0) * matchCount;
    let best = 0;
    for (const [k, v] of Object.entries(tiers)) {
      if (/^hit\d+$/.test(k) && Number(v) > best) best = Number(v);
    }
    return best;
  }
  // 猜比分的三个档是「命中取最高一个」，不是相加
  const keys = type === 'score' ? ['score', 'goals', 'wdl'] : [type];
  return Math.max(0, ...keys.map((k) => Number(tiers[k]) || 0));
}
