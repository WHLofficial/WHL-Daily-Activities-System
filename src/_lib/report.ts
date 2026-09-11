// A8：战报文本生成（插件拉取后原样发回 QQ 群）

interface DetailRow { user_id: number; name: string; total: number; items: any[] }

const TIER_LABEL: Record<string, string> = {
  score: '比分全中', goals: '总进球', wdl: '胜平负', fun: '趣味命中',
};

// 猜胜负按命中场数记档（hit1/hit2/hit3…），场数由题面决定，不写死
function tierLabel(item: { type: string; question: string }, tier: string): string {
  const n = /^hit(\d+)$/.exec(tier || '');
  if (n) return `胜负中 ${n[1]} 场`;
  return TIER_LABEL[tier] || TIER_LABEL[item.type] || item.question;
}

// 按「实际命中的档位 + 分额」分组：猜比分的玩法项也可能只吃到总进球/胜平负档，
// 按玩法项类型贴标签会把 +100 写成「比分全中」，读起来是错的。
function hitLines(item: { id: number; type: string; question: string }, detail: DetailRow[]): string[] {
  const groups = new Map<string, { label: string; reward: number; names: string[] }>();
  for (const d of detail) {
    for (const i of d.items) {
      if (i.itemId !== item.id || !i.hit) continue;
      const label = tierLabel(item, i.tier);
      const key = `${label}|${i.reward}`;
      if (!groups.has(key)) groups.set(key, { label, reward: i.reward, names: [] });
      groups.get(key)!.names.push(d.name);
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.reward - a.reward)
    .map((g) => `  ${g.label}: ${g.names.join('、')} （+${g.reward}）`);
}

export function buildReportText(
  eventRow: any,
  matches: { id: number; home: string; away: string }[],
  items: { id: number; match_id: number; type: string; question: string }[],
  actualScores: Record<number, { home: number; away: number }>,
  detail: DetailRow[],
  totalAmount: number,
): string {
  const lines: string[] = [];
  lines.push(`🏆 竞猜战报 · ${eventRow.title}`);
  lines.push('──────────────');

  for (const m of matches) {
    const actual = actualScores[m.id];
    lines.push(`⚽ ${actual ? `${m.home} ${actual.home}:${actual.away} ${m.away}` : `${m.home} vs ${m.away}`}`);
    for (const item of items.filter((i) => i.match_id === m.id)) {
      lines.push(...hitLines(item, detail));
    }
  }

  // 猜胜负覆盖全部场次，match_id 为空：按场次过滤会整项漏掉，所以单列一段
  for (const item of items.filter((i) => i.match_id === null || i.match_id === undefined)) {
    const ls = hitLines(item, detail);
    if (ls.length === 0) continue;
    lines.push(`🎯 ${item.question}`);
    lines.push(...ls);
  }

  lines.push('──────────────');
  lines.push(`本次竞猜 ${detail.length} 人命中，共发放 ${totalAmount} 积分`);
  lines.push('积分已自动到账，感谢参与 🎉');
  return lines.join('\n');
}
