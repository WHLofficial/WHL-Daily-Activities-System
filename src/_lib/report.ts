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

// 东八区展示时间（MM-DD HH:mm）：文案面向国内群聊，直接给本地时间，不让人自己换算
export function fmtE8(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const g = (t: string) => parts.find((p) => p.type === t)?.value || '';
  return `${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}

const SITE_URL = 'https://guess.whleague.win';

// 开放通知：机器人拉取后原样发群；不 @ 任何人，「谁还没交」由插件侧自己决定要不要点名
export function buildOpenNotice(title: string, matchCount: number, deadline: string, maxReward: number): string {
  return [
    `🎯 新竞猜开放《${title}》`,
    `共 ${matchCount} 场比赛，${fmtE8(deadline)} 截止，最高可得 ${maxReward} 分`,
    `快去填预测：${SITE_URL}`,
  ].join('\n');
}

// 截止提醒：扫描每 5 分钟一轮，首次进入「距截止 4 小时以内」时入队，
// 所以 hoursLeft 正常就是 4（最多差 5 分钟），提前量被改时才不会是 4。
export function buildRemindNotice(title: string, joined: number, hoursLeft: number): string {
  return [
    `⏰ 《${title}》还有约 ${hoursLeft} 小时截止`,
    `已有 ${joined} 人提交，还没填的快去：${SITE_URL}`,
  ].join('\n');
}
