// A8：战报文本生成（插件拉取后原样发回 QQ 群）

interface DetailRow { user_id: number; name: string; total: number; items: any[] }

const TIER_LABEL: Record<string, string> = {
  score: '比分全中', goals: '总进球', wdl: '胜平负', fun: '趣味命中',
};

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
      const winners = detail.flatMap((d) =>
        d.items.filter((i) => i.itemId === item.id && i.hit)
          .map((i) => ({ name: d.name, reward: i.reward })));
      if (winners.length === 0) continue;
      const byReward = new Map<number, string[]>();
      for (const w of winners) {
        if (!byReward.has(w.reward)) byReward.set(w.reward, []);
        byReward.get(w.reward)!.push(w.name);
      }
      for (const [reward, names] of [...byReward.entries()].sort((a, b) => b[0] - a[0])) {
        lines.push(`  ${TIER_LABEL[item.type] || item.question}: ${names.join('、')} (+${reward})`);
      }
    }
  }

  lines.push('──────────────');
  lines.push(`本期 ${detail.length} 人命中，共发放 ${totalAmount} 积分`);
  lines.push('积分已自动到账，感谢参与 🎉');
  return lines.join('\n');
}
