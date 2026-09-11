// 管理端 SPA：新建竞猜 / 状态流转 / 录结果 / 结算预览 / 确认发奖 / 批次状态 / 冲正 / 对账
import {
  api, fmtTime, countdown, STATUS_LABEL, STATUS_CLASS, esc, toast,
  TYPE_NAME, TIER_LABEL, CREATE_TYPES, ROLE_NAME, formatContent, roleLabel,
  BATCH_STATUS, PAYOUT_STATUS, statusPill, PASSWORD_FORM, wirePassword,
} from './core.js';

const app = document.getElementById('app');
let me = null;
let view = { tab: 'events', eventId: null };

// ---------- 登录 ----------
function renderLogin() {
  app.innerHTML = `
    <div class="card auth-card">
      <h3>登录管理台</h3>
      <div class="muted">账号与赛事系统通用。管理员或发起人才能进入管理台。</div>
      <label class="field"><span>昵称</span><input id="li-u" autocomplete="username"></label>
      <label class="field"><span>密码</span><input id="li-p" type="password" autocomplete="current-password"></label>
      <div class="row mt"><button class="grow" id="li-go">登录</button></div>
    </div>`;
  const go = async () => {
    try {
      await api('/login', { method: 'POST', body: { username: v('li-u'), password: v('li-p') } });
      me = await api('/me'); route();
    } catch (e) { toast(e.message, true); }
  };
  document.getElementById('li-go').onclick = go;
  app.querySelectorAll('input').forEach((i) => i.addEventListener('keydown', (e) => e.key === 'Enter' && go()));
}
const v = (id) => document.getElementById(id)?.value?.trim();

// ---------- 竞猜列表 ----------
async function renderEvents() {
  const { events } = await api('/admin/events');
  app.innerHTML = `
    <div class="row"><button class="grow" id="new">新建竞猜</button></div>
    <div id="list">${events.length === 0 ? '<div class="empty">还没有竞猜。点上面的「新建竞猜」开一场。</div>' : events.map((e) => `
      <a class="card" href="#/manage/${e.id}">
        <div class="row spread">
          <h3>#${e.id} ${esc(e.title)}</h3>
          <span class="badge ${STATUS_CLASS[e.status]}">${STATUS_LABEL[e.status]}</span>
        </div>
        <div class="muted">截止 ${fmtTime(e.deadline)}${e.status === 'open' ? `（${countdown(e.deadline)}）` : ''} · ${e.participants} 人参与</div>
      </a>`).join('')}</div>
    <details class="card mt">
      <summary>发起人名单（可开放竞猜、提前截止、录比分、结算）</summary>
      <div id="init-list"><div class="muted">加载中…</div></div>
    </details>`;
  document.getElementById('new').onclick = () => { location.hash = '#/new'; };
  const initBox = document.getElementById('init-list');
  if (initBox) {
    try {
      const { users } = await api('/admin/users');
      initBox.innerHTML = users.length === 0 ? '<div class="empty">还没有账号</div>' : `
        <div class="table-wrap">
        <table>
          <tr><th>编号</th><th>昵称</th><th>角色</th><th>来源</th><th>QQ</th><th>发起人</th></tr>
          ${users.map((u) => `
            <tr>
              <td>${u.id}</td>
              <td>${esc(u.display_name)}</td>
              <td>${ROLE_NAME[u.role] || '普通用户'}</td>
              <td>${u.tour_id ? `赛事系统 #${u.tour_id}` : '本地'}</td>
              <td>${u.bound ? '已绑定' : '—'}</td>
              <td><button class="link" data-init="${u.id}" data-on="${u.is_initiator ? 0 : 1}">${u.is_initiator ? '取消发起人' : '设为发起人'}</button></td>
            </tr>`).join('')}
        </table>
        </div>`;
      initBox.querySelectorAll('[data-init]').forEach((btn) => {
        btn.onclick = async () => {
          try {
            await api('/admin/initiators', { method: 'POST', body: { userId: Number(btn.dataset.init), on: btn.dataset.on === '1' } });
            toast('发起人名单已更新');
            renderEvents();
          } catch (e) { toast(e.message, true); }
        };
      });
    } catch (e) {
      initBox.innerHTML = `<div class="muted">${esc(e.message)}</div>`;
    }
  }
}

// ---------- 新建竞猜 ----------
async function renderNew() {
  const { tiers: defT, rewardCap: defCap } = await api('/admin/defaults');
  const mkItem = (t = { type: 'score', question: '', tiers: defT }) => `
    <div class="item i-row">
      <div class="row">
        <select class="type-select" data-f="type">
          ${CREATE_TYPES.map((val) => `<option value="${val}" ${t.type === val ? 'selected' : ''}>${TYPE_NAME[val]}</option>`).join('')}
        </select>
        <input class="grow" data-f="question" placeholder="题目（可留空用默认）" value="${esc(t.question)}">
        <button class="ghost small i-del" type="button">删</button>
      </div>
      <div class="row tier-boxes mt-s"></div>
    </div>`;
  const mkMatch = () => `
    <div class="card m-row">
      <div class="row">
        <input class="grow" data-f="home" placeholder="主队">
        <span class="muted">vs</span>
        <input class="grow" data-f="away" placeholder="客队">
        <button class="ghost small m-del" type="button">删</button>
      </div>
      <label class="field"><span>开赛时间（可选）</span><input data-f="kickoff" type="datetime-local"></label>
      <div class="i-list"></div>
      <div class="row mt-s i-add-row"><button class="ghost small i-add" type="button">＋ 加玩法项</button></div>
    </div>`;

  app.innerHTML = `
    <a class="muted" href="#/">← 返回列表</a>
    <div class="card">
      <h3>新建竞猜</h3>
      <div class="row mt-s">
        <span class="muted">玩法形式</span>
        <div class="seg" id="f-form">
          <label class="on"><input type="radio" name="f-form" value="pure" checked>纯猜胜负</label>
          <label><input type="radio" name="f-form" value="items">标准</label>
        </div>
      </div>
      <div class="muted" id="f-form-hint"></div>
      <label class="field"><span>标题</span><input id="f-title" maxlength="60" placeholder="如：英超第 3 轮竞猜"></label>
      <label class="field"><span>提交截止时间</span><input id="f-deadline" type="datetime-local"></label>
      <label class="field"><span>玩法项默认奖励上限（单个玩法项发分总数）</span><input id="f-cap" type="number" value="${defCap}"></label>
      <label class="field row"><input id="f-open" type="checkbox"> <span>创建后立即开放</span></label>
      <div id="m-list"></div>
      <div class="row mt-s"><button class="ghost small" id="m-add" type="button">＋ 加一场比赛（最多 3 场）</button></div>
      <div class="card">
        <h3>猜胜负</h3>
        <label class="field row" id="c-on-row"><input type="checkbox" id="c-on"> <span>覆盖全部场次，按命中场数算分</span></label>
        <div id="c-body" hidden>
          <div class="muted" id="c-lead"></div>
          <label class="field"><span>题目</span><input id="c-q" maxlength="60" placeholder="猜胜负"></label>
          <label class="field"><span>计分方式</span>
            <select id="c-mode">
              <option value="tiered">按命中场数分档（取满足的最高档）</option>
              <option value="per_hit">每中一场给固定分</option>
            </select>
          </label>
          <div id="c-tiers"></div>
          <div class="muted" id="c-hint"></div>
        </div>
      </div>
      <div class="row mt"><button class="grow" id="create">创建竞猜</button></div>
    </div>`;

  const mList = document.getElementById('m-list');
  const cOn = document.getElementById('c-on');
  const cBody = document.getElementById('c-body');
  const cMode = document.getElementById('c-mode');
  const cOnRow = document.getElementById('c-on-row');
  const cLead = document.getElementById('c-lead');
  const mAdd = document.getElementById('m-add');
  const fForm = document.getElementById('f-form');
  const fHint = document.getElementById('f-form-hint');
  let form = 'pure';
  const pickForm = () => fForm.querySelector('input:checked').value;
  // 档位输入框跟着比赛场数和计分方式变：2 场不可能命中 3 场，就别给 hit3 的框
  const drawCrossTiers = () => {
    const n = mList.children.length;
    const mode = cMode.value;
    const keys = mode === 'per_hit' ? ['perHit'] : Array.from({ length: n }, (_, i) => `hit${i + 1}`);
    const def = mode === 'per_hit' ? defT.wdl_all_per_hit : defT.wdl_all;
    const tip = mode === 'per_hit'
      ? ''
      : '<div class="muted">留空或填 0 表示不设这一档：命中场数没单独设档时，按比它低的一档给分</div>';
    document.getElementById('c-tiers').innerHTML = keys.map((k) =>
      `<label class="field"><span>${k === 'perHit' ? '每命中一场' : TIER_LABEL[k]} +分</span><input type="number" data-t="${k}" value="${def?.[k] ?? ''}" placeholder="0"></label>`).join('') + tip;
  };
  const syncCross = () => {
    const n = mList.children.length;
    const pure = form === 'pure';
    const ok = n >= 2;
    cOn.disabled = !ok;
    cOn.checked = pure ? ok : (ok && cOn.checked);
    cOnRow.hidden = pure;
    cBody.hidden = !cOn.checked;
    document.getElementById('c-hint').textContent = pure
      ? (ok ? `本局共 ${n} 场，每场都要选` : '纯猜胜负至少要 2 场比赛')
      : (ok ? `覆盖全部 ${n} 场，最多命中 ${n} 场` : '至少 2 场比赛才能加「猜胜负」');
    cLead.textContent = pure ? '本局只有这一道题，每场都要选。' : '';
    if (cOn.checked) drawCrossTiers();
  };
  cOn.onchange = syncCross;
  cMode.onchange = drawCrossTiers;
  const applyForm = () => {
    form = pickForm();
    const pure = form === 'pure';
    [...mList.children].forEach((card) => {
      card.querySelector('.i-list').hidden = pure;
      card.querySelector('.i-add-row').hidden = pure;
      if (!pure && card.querySelectorAll('.i-row').length === 0) addItem(card.querySelector('.i-list'));
    });
    fForm.querySelectorAll('label').forEach((l) => l.classList.toggle('on', l.querySelector('input').checked));
    fHint.textContent = pure
      ? '纯猜胜负：一组比赛只出一道题，每场都要选出胜负，按猜中的场数给分。'
      : '标准：每场比赛可设若干个玩法项，另可加一道覆盖全部场次的「猜胜负」。';
    mAdd.textContent = pure ? '＋ 加一场比赛（最多 10 场）' : '＋ 加一场比赛（最多 3 场）';
    syncCross();
  };
  fForm.onchange = () => {
    if (pickForm() === 'items' && mList.children.length > 3) {
      while (mList.children.length > 3) mList.lastElementChild.remove();
      toast('标准形式最多 3 场比赛，已保留前 3 场', true);
    }
    applyForm();
  };
  const addItem = (box) => {
    box.insertAdjacentHTML('beforeend', mkItem());
    const row = box.lastElementChild;
    drawTiers(row, defT.score);
    row.querySelector('[data-f="type"]').onchange = (e) => drawTiers(row, defT[e.target.value]);
    row.querySelector('.i-del').onclick = () => row.remove();
  };
  const addMatch = () => {
    mList.insertAdjacentHTML('beforeend', mkMatch());
    const card = mList.lastElementChild;
    card.querySelector('.m-del').onclick = () => { card.remove(); syncCross(); };
    card.querySelector('.i-add').onclick = () => addItem(card.querySelector('.i-list'));
    if (form === 'items') addItem(card.querySelector('.i-list'));
    syncCross();
  };
  mAdd.onclick = () => {
    const max = form === 'pure' ? 10 : 3;
    if (mList.children.length >= max) {
      return toast(form === 'pure' ? '纯猜胜负最多 10 场比赛' : '标准形式最多 3 场比赛', true);
    }
    addMatch();
  };
  addMatch();
  // 纯猜胜负最少 2 场，开场就给两场，省得先看到一句「至少要 2 场比赛」
  if (form === 'pure') addMatch();
  applyForm();

  document.getElementById('create').onclick = async () => {
    const pure = form === 'pure';
    const matches = [...mList.children].map((card) => ({
      home: card.querySelector('[data-f="home"]').value.trim(),
      away: card.querySelector('[data-f="away"]').value.trim(),
      kickoff: card.querySelector('[data-f="kickoff"]').value ? new Date(card.querySelector('[data-f="kickoff"]').value).toISOString() : null,
      items: pure ? [] : [...card.querySelectorAll('.i-row')].map((row) => ({
        type: row.querySelector('[data-f="type"]').value,
        question: row.querySelector('[data-f="question"]').value.trim(),
        tiers: Object.fromEntries([...row.querySelectorAll('.tier-boxes input')].map((i) => [i.dataset.t, Number(i.value)]).filter(([, n]) => Number.isInteger(n) && n > 0)),
        cap: null,
      })),
    }));
    const cross = (pure || cOn.checked) ? {
      type: 'wdl_all',
      question: document.getElementById('c-q').value.trim(),
      tiers: {
        mode: cMode.value,
        ...Object.fromEntries([...document.querySelectorAll('#c-tiers input')]
          .map((i) => [i.dataset.t, Number(i.value)]).filter(([, n]) => Number.isInteger(n) && n > 0)),
      },
    } : null;
    try {
      const r = await api('/admin/events', {
        method: 'POST',
        body: {
          form: pure ? 'pure' : 'items',
          title: document.getElementById('f-title').value.trim(),
          deadline: new Date(document.getElementById('f-deadline').value).toISOString(),
          rewardCap: Number(document.getElementById('f-cap').value),
          openNow: document.getElementById('f-open').checked,
          matches,
          cross,
        },
      });
      toast(`已创建竞猜 #${r.eventId}`);
      location.hash = `#/manage/${r.eventId}`;
    } catch (e) { toast(e.message, true); }
  };

  function drawTiers(row, def) {
    const type = row.querySelector('[data-f="type"]').value;
    const keys = type === 'score' ? ['score', 'goals', 'wdl'] : [type];
    row.querySelector('.tier-boxes').innerHTML = keys.map((k) =>
      `<label class="field"><span>${TIER_LABEL[k]} +分</span><input type="number" data-t="${k}" value="${def?.[k] ?? ''}"></label>`).join('');
  }
}

// ---------- 单场竞猜管理 ----------
async function renderManage(id) {
  const d = await api(`/admin/events/${id}`);
  const e = d.event;
  const acts = [];
  if (e.status === 'draft') acts.push(['open', '开放提交', '']);
  if (e.status === 'open') acts.push(['seal', '提前截止', '']);
  if (['open', 'sealed'].includes(e.status)) acts.push(['result', '录结果', 'ghost']);
  if (e.status === 'settled') acts.push(['result', '重算结算', 'ghost'], ['confirm', '确认发奖', '']);
  if (e.status === 'paid') acts.push(['archive', '归档', 'ghost']);

  app.innerHTML = `
    <a class="muted" href="#/">← 返回列表</a>
    <div class="card">
      <div class="row spread">
        <h3>#${e.id} ${esc(e.title)}</h3>
        <span class="badge ${STATUS_CLASS[e.status]}">${STATUS_LABEL[e.status]}</span>
        ${e.status === 'paid' && !d.batch ? '<span class="badge orange">无人命中</span>' : ''}
      </div>
      <div class="muted">截止 ${fmtTime(e.deadline)} · ${new Set(d.predictions.map((p) => p.userId)).size} 人已提交 · 每项上限 ${e.reward_cap} 分${d.items.some((i) => i.match_id == null) ? ` · 含「猜胜负」（全部 ${d.matches.length} 场）` : ''}</div>
      <div class="row mt-s">
        ${acts.map(([a, label, cls]) => `<button class="${cls} small" data-act="${a}">${label}</button>`).join('')}
      </div>
    </div>
    <div id="panel"></div>
    <div id="settle-panel"></div>`;

  app.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = async () => {
      const act = b.dataset.act;
      try {
        if (['open', 'seal', 'archive'].includes(act)) {
          await api(`/admin/events/${id}/${act}`, { method: 'POST' });
          toast('状态已更新'); renderManage(id);
        } else if (act === 'result') {
          renderResultEntry(d);
        } else if (act === 'confirm') {
          doConfirm(d, false);
        }
      } catch (e2) { toast(e2.message, true); }
    };
  });

  if (d.settlement) renderSettlementPreview(d, e.status === 'settled');
  if (d.batch) showBatchInto(document.getElementById('panel'), d.batch.id);
}

// ---------- 发放批次（管理页内嵌 / 独立视图共用） ----------
async function showBatchInto(container, batchId) {
  const { batch, items } = await api(`/admin/batches/${batchId}`);
  container.innerHTML = `
    <div class="card">
      <div class="row spread">
        <h3>发放批次 #${batch.id}</h3>
        ${statusPill(BATCH_STATUS, batch.status)}
      </div>
      <div class="muted">共 ${batch.total_amount} 分 · 创建于 ${fmtTime(batch.created_at)}</div>
      <div class="row mt-s"><button class="ghost small" id="retry">重试未到账与失败项</button></div>
      <div class="table-wrap mt-s">
      <table>
        <tr><th>账号</th><th>QQ</th><th class="num">积分</th><th>状态</th><th>备注</th><th></th></tr>
        ${items.map((i) => `
          <tr>
            <td>${esc(i.display_name)}</td><td>${esc(i.qq_id)}</td>
            <td class="num">${i.amount}</td>
            <td>${statusPill(PAYOUT_STATUS, i.status)}</td>
            <td class="muted">${i.status === 'credited' ? '—' : `${esc(i.last_error || '')}${i.retry_count ? ` 重试 ${i.retry_count} 次` : ''}`}</td>
            <td>${i.status === 'credited' ? `<button class="ghost small" data-rev="${esc(i.payout_id)}">冲正</button>` : ''}</td>
          </tr>`).join('')}
      </table>
      </div>
    </div>`;
  container.querySelector('#retry').onclick = async () => {
    try {
      const r = await api(`/admin/batches/${batchId}/retry`, { method: 'POST' });
      toast(`重试完成：到账 ${r.dispatch.credited + r.dispatch.duplicate} 笔，待重试 ${r.dispatch.unknown} 笔，失败 ${r.dispatch.failed} 笔`);
      showBatchInto(container, batchId);
    } catch (e) { toast(e.message, true); }
  };
  container.querySelectorAll('[data-rev]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('确认冲正这笔发放？会向该 QQ 发一笔等额反向流水。')) return;
      try {
        await api(`/admin/payouts/${b.dataset.rev}/reverse`, { method: 'POST' });
        toast('冲正已提交');
        showBatchInto(container, batchId);
      } catch (e) { toast(e.message, true); }
    };
  });
}

// 独立批次视图（#/batch/:id）
async function renderBatch(batchId) {
  app.innerHTML = '<a class="muted" href="#/">← 返回列表</a><div id="bpanel"></div>';
  await showBatchInto(document.getElementById('bpanel'), batchId);
}

// ---------- 录结果 ----------
async function renderResultEntry(d) {
  const panel = document.getElementById('panel');
  panel.innerHTML = `
    <div class="card">
      <h3>录结果</h3>
      ${d.matches.map((m) => `
        <div class="item" data-match="${m.id}">
          <div class="q">${esc(m.home)} vs ${esc(m.away)}</div>
          <div class="row">
            <input class="score-in r-home" type="number" min="0" max="99" placeholder="主">
            <span class="muted">:</span>
            <input class="score-in r-away" type="number" min="0" max="99" placeholder="客">
          </div>
        </div>`).join('')}
      ${d.items.filter((i) => i.type === 'fun').map((i) => `
        <div class="item" data-fun="${i.id}">
          <div class="q">${esc(i.question)} <span class="muted">趣味题</span></div>
          ${d.predictions.filter((p) => p.playItemId === i.id).map((p) => `
            <label class="row">
              <input type="checkbox" data-uid="${p.userId}">
              <span>${esc(p.name)}：${esc(String(p.content))}</span>
            </label>`).join('') || '<div class="muted">还没有人作答</div>'}
        </div>`).join('')}
      <div class="row mt"><button class="grow" id="calc">计算结算</button></div>
    </div>`;
  document.getElementById('calc').onclick = async () => {
    try {
      const results = [...panel.querySelectorAll('[data-match]')].map((box) => ({
        matchId: Number(box.dataset.match),
        home: Number(box.querySelector('.r-home').value),
        away: Number(box.querySelector('.r-away').value),
      }));
      const fun = [...panel.querySelectorAll('[data-fun]')].map((box) => ({
        itemId: Number(box.dataset.fun),
        hits: [...box.querySelectorAll('input:checked')].map((c) => Number(c.dataset.uid)),
      }));
      const r = await api(`/admin/events/${d.event.id}/result`, { method: 'POST', body: { results, fun } });
      toast(`结算完成：${r.players} 人命中，共 ${r.total} 分`);
      if (r.breaches?.length) toast(`${r.breaches.length} 个玩法项超出上限`, true);
      renderManage(d.event.id);
    } catch (e) { toast(e.message, true); }
  };
}

// ---------- 结算预览 ----------
async function renderSettlementPreview(d, withConfirm) {
  const st = d.settlement;
  const panel = document.getElementById('settle-panel');
  const breaches = st.breaches || [];
  const noHit = !st.total;
  const bound = new Map(d.predictions.map((p) => [p.userId, p.qq]));
  panel.innerHTML = `
    <div class="card">
      <h3>结算预览 · 共 ${st.total} 分</h3>
      ${breaches.length ? `<div class="banner warn">超上限玩法项：${breaches.map((b) => `${esc(b.question)}（${b.total}/${b.cap}）`).join('、')}。确认发奖前请勾选「知晓超限」。</div>` : ''}
      ${noHit ? '<div class="banner info">本次无人命中，确认后直接结案，不会生成发放批次。</div>' : ''}
      <div class="table-wrap">
      <table>
        <tr><th>账号</th><th>QQ</th><th class="num">积分</th><th>明细</th></tr>
        ${st.detail.map((row) => `
          <tr>
            <td>${esc(row.name)}</td>
            <td>${bound.get(row.user_id) ? esc(bound.get(row.user_id)) : '<span class="badge red">未绑定</span>'}</td>
            <td class="num"><b>${row.total}</b></td>
            <td>${row.items.filter((i) => i.hit).map((i) =>
              `<div class="subitem"><span class="hit">命中</span> ${esc(i.question)}${/^hit\d+$/.test(i.tier) ? ` · ${esc(TIER_LABEL[i.tier] || i.tier)}` : ''} +${i.reward}（答案 ${esc(formatContent(i.type, i.content, d.matches))}）</div>`).join('') || '<span class="muted">未命中</span>'}</td>
          </tr>`).join('')}
      </table>
      </div>
      ${withConfirm ? `
        <label class="field row ${breaches.length ? '' : 'muted'}" id="ov-row" ${breaches.length ? '' : 'hidden'}>
          <input type="checkbox" id="ov"> <span>知晓超限，仍要发奖</span>
        </label>
        <div class="row mt"><button class="grow" id="do-confirm">${noHit ? '确认结案（无人命中）' : '确认发奖（生成批次并同步积分）'}</button></div>` : ''}
    </div>`;
  const btn = document.getElementById('do-confirm');
  if (btn) btn.onclick = () => doConfirm(d, document.getElementById('ov').checked);
}

async function doConfirm(d, overrideCap) {
  try {
    const r = await api(`/admin/events/${d.event.id}/confirm`, { method: 'POST', body: { overrideCap } });
    if (r.skipped) toast('本次无人命中，没有积分需要发放');
    else if (r.alreadyConfirmed) toast(`这笔竞猜已发过奖（批次 #${r.batchId}）：本次补发到账 ${r.dispatch.credited} 笔`);
    else toast(`发奖批次已创建：${r.payoutCount} 人，已到账 ${r.dispatch.credited} 笔，待重试 ${r.dispatch.unknown} 笔，失败 ${r.dispatch.failed} 笔`);
    if (r.unbound?.length) toast(`未绑定 QQ，未发奖：${r.unbound.join('、')}`, true);
    renderManage(d.event.id);
  } catch (e) {
    toast(e.message, true);
    if (e.data?.error === '存在奖励超限的玩法项，需勾选「知晓超限」后才能确认') {
      document.getElementById('ov-row')?.removeAttribute('hidden');
    }
  }
}

// ---------- 对账 ----------
async function renderRecon() {
  const { runs } = await api('/admin/recon');
  app.innerHTML = `
    <div class="card">
      <h3>每日对账（应收 vs 实发）</h3>
      ${runs.length === 0 ? '<div class="muted">还没有对账记录。每天 09:00（北京时间）自动跑一次，对前一天的账。</div>' : `
      <div class="table-wrap">
      <table>
        <tr><th>日期</th><th>状态</th><th>差异明细</th></tr>
        ${runs.map((r) => `
          <tr>
            <td>${esc(r.target_date)}</td>
            <td>${r.status === 'ok' ? '<span class="badge green">平</span>' : r.status === 'diff' ? '<span class="badge red">有差异</span>' : r.status === 'error' ? '<span class="badge orange">插件不可达</span>' : esc(r.status)}</td>
            <td class="muted">${r.diff_json && r.diff_json !== '[]'
              ? JSON.parse(r.diff_json).map((x) => `QQ ${esc(x.qq_id)}：应收 ${x.expect} / 实发 ${x.actual}（差 ${x.diff > 0 ? '+' : ''}${x.diff}）`).join('<br>')
              : r.status === 'error' ? esc(r.expect_json || '') : '—'}</td>
          </tr>`).join('')}
      </table>
      </div>`}
    </div>`;
}

// ---------- 顶栏 ----------
function renderTopbar() {
  const user = me?.user;
  document.getElementById('userbox').hidden = !user;
  const canManage = !!user && (user.role === 'admin' || user.role === 'superadmin' || !!me.is_initiator);
  document.querySelector('.nav-links').hidden = !canManage;
  if (user) {
    document.getElementById('user-name').textContent = user.display_name || user.username || '';
    document.getElementById('user-role').textContent = roleLabel(user, me.is_initiator);
  }
}

let logoutTimer = null;
function resetLogout() {
  clearTimeout(logoutTimer);
  const btn = document.getElementById('nav-logout');
  btn.textContent = '登出';
  btn.className = 'ghost';
}
document.getElementById('nav-logout').onclick = async () => {
  const btn = document.getElementById('nav-logout');
  if (!btn.classList.contains('danger')) {
    // 两步确认：点第一下进入待确认，5 秒内不再点就自动还原
    btn.textContent = '再点一次确认登出';
    btn.className = 'danger';
    logoutTimer = setTimeout(resetLogout, 5000);
    return;
  }
  await api('/logout', { method: 'POST' });
  me = null;
  resetLogout();
  location.hash = '';
  route();
};

// ---------- 改密码 ----------
function renderPassword() {
  app.innerHTML = `<a class="muted" href="#/">← 返回</a><div class="card">${PASSWORD_FORM}</div>`;
  wirePassword(app, () => { location.hash = '#/'; });
}

// ---------- 框架 ----------
function switchTab(tab) {
  view.tab = tab;
  if (location.hash && location.hash !== '#/') location.hash = '#/';
  else route();
}
function renderTabs() {
  document.getElementById('tab-events').classList.toggle('is-active', view.tab === 'events');
  document.getElementById('tab-recon').classList.toggle('is-active', view.tab === 'recon');
}

document.getElementById('tab-events').onclick = () => switchTab('events');
document.getElementById('tab-recon').onclick = () => switchTab('recon');

window.addEventListener('hashchange', route);
function route() {
  renderTopbar();
  renderTabs();
  if (!me?.user) { renderLogin(); return; }
  if (me.user.role !== 'admin' && !me.is_initiator) {
    app.innerHTML = '<div class="banner bad">没有权限访问管理台</div>';
    return;
  }
  const h = location.hash || '#/';
  if (h.startsWith('#/manage/')) renderManage(Number(h.split('/')[2])).catch(showErr);
  else if (h.startsWith('#/batch/')) renderBatch(Number(h.split('/')[2])).catch(showErr);
  else if (h === '#/new') renderNew().catch(showErr);
  else if (h === '#/password') renderPassword();
  else if (view.tab === 'recon') renderRecon().catch(showErr);
  else renderEvents().catch(showErr);
}
function showErr(e) {
  app.innerHTML = `<div class="banner bad">${esc(e.message)}</div><a class="muted" href="#/">← 返回</a>`;
}

(async () => {
  me = await api('/me');
  route();
})();
