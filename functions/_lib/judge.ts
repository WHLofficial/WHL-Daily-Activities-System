// A5：自动判定。输入实际比分 + 趣味题命中名单，输出每人每题的档位判定。
// 规则（PRD 开放问题 1 的假设）：一份比分预测可同时命中多档，奖励取最高档；
// 档位优先级按金额（score 档通常最高）。总进球/胜平负/趣味题单档。

import { nowSql } from './http.ts';

export interface ResultInput {
  results: { matchId: number; home: number; away: number }[];
  fun: { itemId: number; hits: number[] }[]; // 趣味题命中名单（user_id）
}

interface ItemRow {
  id: number; match_id: number; type: string; question: string;
  tier_json: string; reward_cap: number | null;
}

interface PredRow { play_item_id: number; user_id: number; content_json: string }

export function wdlOf(home: number, away: number): 'home' | 'draw' | 'away' {
  return home > away ? 'home' : home < away ? 'away' : 'draw';
}

export function computeSettlement(
  eventRow: any,
  items: ItemRow[],
  predictions: PredRow[],
  names: Record<number, string>,
  input: ResultInput,
) {
  const actualByMatch = new Map<number, { home: number; away: number }>(
    input.results.map((r) => [r.matchId, { home: r.home, away: r.away }]),
  );
  const funHits = new Map<number, Set<number>>(input.fun.map((f) => [f.itemId, new Set(f.hits)]));

  const perUser = new Map<number, { user_id: number; name: string; total: number; items: any[] }>();
  const perItemTotal = new Map<number, number>();

  for (const item of items) {
    const cap = item.reward_cap ?? eventRow.reward_cap;
    const tiers = JSON.parse(item.tier_json);
    let itemTotal = 0;

    for (const p of predictions.filter((x) => x.play_item_id === item.id)) {
      const content = JSON.parse(p.content_json);
      let hit = false;
      let tier: string | null = null;
      let reward = 0;
      const hitTiers: string[] = [];

      if (item.type === 'score') {
        const actual = actualByMatch.get(item.match_id);
        if (actual) {
          if (content.home === actual.home && content.away === actual.away) hitTiers.push('score');
          if (content.home + content.away === actual.home + actual.away) hitTiers.push('goals');
          if (wdlOf(content.home, content.away) === wdlOf(actual.home, actual.away)) hitTiers.push('wdl');
        }
        // 取最高档：命中档中金额最大者
        for (const t of hitTiers) {
          if (tiers[t] > reward) { reward = tiers[t]; tier = t; }
        }
        hit = hitTiers.length > 0;
      } else if (item.type === 'wdl') {
        const actual = actualByMatch.get(item.match_id);
        if (actual && content === wdlOf(actual.home, actual.away)) {
          hit = true; tier = 'wdl'; reward = tiers.wdl || 0;
        }
      } else if (item.type === 'goals') {
        const actual = actualByMatch.get(item.match_id);
        if (actual && content === actual.home + actual.away) {
          hit = true; tier = 'goals'; reward = tiers.goals || 0;
        }
      } else if (item.type === 'fun') {
        if (funHits.get(item.id)?.has(p.user_id)) {
          hit = true; tier = 'fun'; reward = tiers.fun || 0;
        }
      }

      itemTotal += reward;
      if (!perUser.has(p.user_id)) {
        perUser.set(p.user_id, { user_id: p.user_id, name: names[p.user_id] || `用户${p.user_id}`, total: 0, items: [] });
      }
      perUser.get(p.user_id)!.items.push({
        matchId: item.match_id, itemId: item.id, type: item.type, question: item.question,
        content, hit, tier, reward, hitTiers,
      });
    }
    perItemTotal.set(item.id, itemTotal);
  }

  const rows = [...perUser.values()].map((r) => {
    r.total = r.items.reduce((s: number, i: any) => s + i.reward, 0);
    return r;
  }).sort((a, b) => b.total - a.total);

  const totalAmount = rows.reduce((s, r) => s + r.total, 0);
  const breaches = items
    .filter((i) => (perItemTotal.get(i.id) || 0) > (i.reward_cap ?? eventRow.reward_cap))
    .map((i) => ({
      itemId: i.id, question: i.question,
      total: perItemTotal.get(i.id), cap: i.reward_cap ?? eventRow.reward_cap,
    }));

  return {
    rows, totalAmount, breaches,
    resultJson: JSON.stringify({ results: input.results, fun: input.fun, computedAt: nowSql() }),
  };
}
