// 管理端 SPA：建期 / 状态流转 / 录结果 / 结算预览 / 确认发奖 / 批次状态 / 冲正 / 对账
import { api, fmtTime, countdown, STATUS_LABEL, STATUS_CLASS, esc, toast } from './core.js';

const app = document.getElementById('app');
let me = null;
let view = { tab: 'events', eventId: null };

// ---------- 登录 ----------
function renderLogin() {
  app.innerHTML = `
    <div class="card" style="margin-top:40px">
      <h3>管理员登录</h3>
      <label class="field"><span>用户名</span><input id="li-u" autocomplete="username"></label>
      <label class="field"><span>密码</span><input id="li-p" type="password" autocomplete="current-password"></label>
      <div class="row" style="margin-top:16px"><button id="li-go" style="flex:1">登 录</button></div>
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

// ---------- 期列表 ----------
async function renderEvents() {
  const { events } = await api('/admin/events');
  app.innerHTML = `
    <div class="row"><button id="new" style="flex:1">＋ 新建竞猜期</button></div>
    <div id="list">${events.length === 0 ? '<div class="empty">还没有竞猜期</div>' : events.map((e) => `
      <a class="card" href="#/manage/${e.id}" style="display:block;text-decoration:none;color:inherit">
        <div class="row spread">
          <h3>#${e.id} ${esc(e.title)}</h3>
          <span class="badge ${STATUS_CLASS[e.status]}">${STATUS_LABEL[e.status]}</span>
        </div>
        <div class="muted">截止 ${fmtTime(e.deadline)}${e.status === 'open' ? `（${countdown(e.deadline)}）` : ''} · ${e.participants} 人参与</div>
      </a>`).join('')}</div>
    <details class="card" style="margin-top:16px">
      <summary style="cursor:pointer;font-weight:600">🎯 发起人名单（可开期/截止/录比分/结算）</summary>
      <div id="init-list"><div class="muted">加载中…</div></div>
    </details>`;
  document.getElementById('new').onclick = () => { location.hash = '#/new'; };
  const initBox = document.getElementById('init-list');
  if (initBox) {
    try {
      const { users } = await api('/admin/users');
      initBox.innerHTML = users.length === 0 ? '<div class="empty">还没有账号</div>' : `
        <table>
          <tr><th>ID</th><th>用户名</th><th>昵称</th><th>角色</th><th>来源</th><th>QQ</th><th>发起人</th></tr>
          ${users.map((u) => `
            <tr>
              <td>${u.id}</td><td>${esc(u.username)}</td><td>${esc(u.display_name)}</td>
              <td>${u.role === 'admin' ? '管理员' : u.role}</td>
              <td>${u.tour_id ? `赛事系统#${u.tour_id}` : '本站'}</td>
              <td>${u.bound ? '✅' : '—'}</td>
              <td><button class="link" data-init="${u.id}" data-on="${u.is_initiator ? 0 : 1}">${u.is_initiator ? '✅ 是' : '否'}</button></td>
            </tr>`).join('')}
        </table>`;
      initBox.querySelectorAll('[data-init]').forEach((btn) => {
        btn.onclick = async () => {
          try {
            await api('/admin/initiators', { method: 'POST', body: { userId: Number(btn.dataset.init), on: btn.dataset.on === '1' } });
            toast('已更新发起人名单');
            renderEvents();
          } catch (e) { toast(e.message, true); }
        };
      });
    } catch (e) {
      initBox.innerHTML = `<div class="muted">${esc(e.message)}</div>`;
    }
  }
}

// ---------- 新建 ----------
async function renderNew() {
  const { tiers: defT, rewardCap: defCap } = await api('/admin/defaults');
  const mkItem = (t = { type: 'score', question: '', tiers: defT }) => `
    <div class="item i-row">
      <div class="row">
        <select data-f="type" style="width:110px">
          ${['score:猜比分', 'wdl:胜平负', 'goals:总进球', 'fun:趣味题'].map((x) => {
            const [val, label] = x.split(':');
            return `<option value="${val}" ${t.type === val ? 'selected' : ''}>${label}</option>`;
          }).join('')}
        </select>
        <input data-f="question" placeholder="题目（可留空用默认）" value="${esc(t.question)}" style="flex:1">
        <button class="ghost small i-del" type="button">删</button>
      </div>
      <div class="row tier-boxes" style="margin-top:6px"></div>
    </div>`;
  const mkMatch = () => `
    <div class="card m-row">
      <div class="row">
        <input data-f="home" placeholder="主队" style="flex:1">
        <span class="muted">vs</span>
        <input data-f="away" placeholder="客队" style="flex:1">
        <button class="ghost small m-del" type="button">删</button>
      </div>
      <label class="field"><span>开赛时间（可选）</span><input data-f="kickoff" type="datetime-local"></label>
      <div class="i-list"></div>
      <div class="row" style="margin-top:8px"><button class="ghost small i-add" type="button">＋ 加玩法项</button></div>
    </div>`;

  app.innerHTML = `
    <a class="muted" href="#/">← 返回列表</a>
    <div class="card">
      <h3>新建竞猜期</h3>
      <label class="field"><span>标题</span><input id="f-title" maxlength="60" placeholder="如：第 3 轮英超竞猜"></label>
      <label class="field"><span>提交截止时间</span><input id="f-deadline" type="datetime-local"></label>
      <label class="field"><span>玩法项默认奖励上限（单个玩法项发分总数）</span><input id="f-cap" type="number" value="${defCap}"></label>
      <label class="field row"><input id="f-open" type="checkbox" style="width:auto"> <span>创建后立即开放</span></label>
      <div id="m-list"></div>
      <div class="row"><button class="ghost small" id="m-add" type="button">＋ 加一场比赛（最多 3 场）</button></div>
      <div class="row" style="margin-top:16px"><button id="create" style="flex:1">创建</button></div>
    </div>`;

  const mList = document.getElementById('m-list');
  const addItem = (box) => {
    box.insertAdjacentHTML('beforeend', mkItem());
    const row = box.lastElementChild;
    drawTiers(row, defT.score);
    row.querySelector('[data-f="type"]').onchange = (e) => drawTiers(row, defT[e.target.value === 'score' ? 'score' : e.target.value]);
    row.querySelector('.i-del').onclick = () => row.remove();
  };
  const addMatch = () => {
    mList.insertAdjacentHTML('beforeend', mkMatch());
    const card = mList.lastElementChild;
    card.querySelector('.m-del').onclick = () => card.remove();
    card.querySelector('.i-add').onclick = () => addItem(card.querySelector('.i-list'));
    addItem(card.querySelector('.i-list'));
  };
  document.getElementById('m-add').onclick = () => {
    if (mList.children.length >= 3) return toast('最多 3 场', true);
    addMatch();
  };
  addMatch();

  document.getElementById('create').onclick = async () => {
    const matches = [...mList.children].map((card) => ({
      home: card.querySelector('[data-f="home"]').value.trim(),
      away: card.querySelector('[data-f="away"]').value.trim(),
      kickoff: card.querySelector('[data-f="kickoff"]').value ? new Date(card.querySelector('[data-f="kickoff"]').value).toISOString() : null,
      items: [...card.querySelectorAll('.i-row')].map((row) => ({
        type: row.querySelector('[data-f="type"]').value,
        question: row.querySelector('[data-f="question"]').value.trim(),
        tiers: Object.fromEntries([...row.querySelectorAll('.tier-boxes input')].map((i) => [i.dataset.t, Number(i.value)]).filter(([, n]) => Number.isInteger(n) && n > 0)),
        cap: null,
      })),
    }));
    try {
      const r = await api('/admin/events', {
        method: 'POST',
        body: {
          title: document.getElementById('f-title').value.trim(),
          deadline: new Date(document.getElementById('f-deadline').value).toISOString(),
          rewardCap: Number(document.getElementById('f-cap').value),
          openNow: document.getElementById('f-open').checked,
          matches,
        },
      });
      toast(`已创建 #${r.eventId}`);
      location.hash = `#/manage/${r.eventId}`;
    } catch (e) { toast(e.message, true); }
  };

  function drawTiers(row, def) {
    const type = row.querySelector('[data-f="type"]').value;
    const keys = type === 'score' ? ['score', 'goals', 'wdl'] : [type];
    const labels = { score: '比分全中', goals: '总进球', wdl: '胜平负', fun: '命中' };
    row.querySelector('.tier-boxes').innerHTML = keys.map((k) =>
      `<label class="field" style="margin:0"><span>${labels[k]} +分</span><input type="number" data-t="${k}" value="${def?.[k] ?? ''}"></label>`).join('');
  }
}

// ---------- 期管理 ----------
async function renderManage(id) {
  const d = await api(`/admin/events/${id}`);
  const e = d.event;
  const acts = [];
  if (e.status === 'draft') acts.push(['open', '开盘（开放提交）', '']);
  if (e.status === 'open') acts.push(['seal', '提前截止', '']);
  if (['open', 'sealed'].includes(e.status)) acts.push(['result', '录结果 & 计算结算', 'ghost']);
  if (e.status === 'settled') acts.push(['result', '重算结算', 'ghost'], ['confirm', '确认发奖', '']);
  if (e.status === 'paid') acts.push(['archive', '归档', 'ghost']);

  app.innerHTML = `
    <a class="muted" href="#/">← 返回列表</a>
    <div class="card">
      <div class="row spread">
        <h3>#${e.id} ${esc(e.title)}</h3>
        <span class="badge ${STATUS_CLASS[e.status]}">${STATUS_LABEL[e.status]}</span>
      </div>
      <div class="muted">截止 ${fmtTime(e.deadline)} · ${d.predictions.length} 份预测 · ${e.reward_cap} 分/项上限</div>
      <div class="row" style="margin-top:10px">
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
          toast('已更新'); renderManage(id);
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

// ---------- 批次卡片（管理页内嵌 / 独立视图共用） ----------
async function showBatchInto(container, batchId) {
  const { batch, items } = await api(`/admin/batches/${batchId}`);
  container.innerHTML = `
    <div class="card">
      <div class="row spread">
        <h3>发放批次 #${batch.id}</h3>
        <span class="badge ${batch.status === 'paid' ? 'green' : batch.status === 'partial' ? 'orange' : 'gray'}">
          ${batch.status === 'paid' ? '已全部到账' : batch.status === 'partial' ? '部分到账' : '待发'}</span>
      </div>
      <div class="muted">总额 ${batch.total_amount} 分 · 创建于 ${fmtTime(batch.created_at)}</div>
      <div class="row" style="margin-top:8px"><button class="ghost small" id="retry">重试未到账/失败</button></div>
      <table style="margin-top:8px">
        <tr><th>用户</th><th>QQ</th><th class="num">金额</th><th>状态</th><th>备注</th><th></th></tr>
        ${items.map((i) => `
          <tr>
            <td>${esc(i.display_name)}</td><td>${esc(i.qq_id)}</td>
            <td class="num">${i.amount}</td>
            <td>${statusBadge(i.status)}</td>
            <td class="muted">${esc(i.last_error || '')}${i.retry_count ? ` 重试${i.retry_count}次` : ''}</td>
            <td>${i.status === 'credited' ? `<button class="ghost small" data-rev="${esc(i.payout_id)}">冲正</button>` : ''}</td>
          </tr>`).join('')}
      </table>
    </div>`;
  container.querySelector('#retry').onclick = async () => {
    try {
      const r = await api(`/admin/batches/${batchId}/retry`, { method: 'POST' });
      toast(`重试完成：成功 ${r.dispatch.credited + r.dispatch.duplicate}，仍重试 ${r.dispatch.unknown}，失败 ${r.dispatch.failed}`);
      showBatchInto(container, batchId);
    } catch (e) { toast(e.message, true); }
  };
  container.querySelectorAll('[data-rev]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('确认冲正这笔发放？将向该 QQ 发一笔等额反向流水。')) return;
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

async function renderResultEntry(d) {
  const panel = document.getElementById('panel');
  panel.innerHTML = `
    <div class="card">
      <h3>录结果</h3>
      ${d.matches.map((m) => `
        <div class="item" data-match="${m.id}">
          <div class="q">⚽ ${esc(m.home)} vs ${esc(m.away)}</div>
          <div class="row">
            <input class="score-in r-home" type="number" min="0" max="99" placeholder="主">
            <span class="muted">:</span>
            <input class="score-in r-away" type="number" min="0" max="99" placeholder="客">
          </div>
        </div>`).join('')}
      ${d.items.filter((i) => i.type === 'fun').map((i) => `
        <div class="item" data-fun="${i.id}">
          <div class="q">🎯 ${esc(i.question)}</div>
          ${d.predictions.filter((p) => p.playItemId === i.id).map((p) => `
            <label class="row" style="margin:4px 0">
              <input type="checkbox" data-uid="${p.userId}" style="width:auto">
              <span>${esc(p.name)}：${esc(String(p.content))}</span>
            </label>`).join('') || '<div class="muted">无人作答</div>'}
        </div>`).join('')}
      <div class="row" style="margin-top:10px"><button id="calc" style="flex:1">计算结算</button></div>
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
      if (r.breaches?.length) toast(`⚠ ${r.breaches.length} 个玩法项超上限`, true);
      renderManage(d.event.id);
    } catch (e) { toast(e.message, true); }
  };
}

async function renderSettlementPreview(d, withConfirm) {
  const st = d.settlement;
  const panel = document.getElementById('settle-panel');
  const breaches = st.breaches || [];
  const bound = new Map(d.predictions.map((p) => [p.userId, p.qq]));
  panel.innerHTML = `
    <div class="card">
      <h3>结算预览 · 共 ${st.total} 分</h3>
      ${breaches.length ? `<div class="banner warn">⚠ 超上限玩法项：${breaches.map((b) => `${esc(b.question)}（${b.total}/${b.cap}）`).join('、')}。确认发奖需勾选“知晓超限”。</div>` : ''}
      <table>
        <tr><th>用户</th><th>QQ</th><th class="num">得分</th><th>明细</th></tr>
        ${st.detail.map((row) => `
          <tr>
            <td>${esc(row.name)}</td>
            <td>${bound.get(row.user_id) ? esc(bound.get(row.user_id)) : '<span class="badge red">未绑定</span>'}</td>
            <td class="num"><b>${row.total}</b></td>
            <td>${row.items.filter((i) => i.hit).map((i) =>
              `<div class="subitem">✔ ${esc(i.question)} +${i.reward}（我的答案 ${esc(formatContent(i.type, i.content))}）</div>`).join('') || '<span class="muted">未命中</span>'}</td>
          </tr>`).join('')}
      </table>
      ${withConfirm ? `
        <label class="field row ${breaches.length ? '' : 'muted'}" id="ov-row" ${breaches.length ? '' : 'hidden'}>
          <input type="checkbox" id="ov" style="width:auto"> <span>知晓超限，仍要发奖</span>
        </label>
        <div class="row" style="margin-top:10px"><button id="do-confirm" style="flex:1">✅ 确认发奖（生成批次并同步积分）</button></div>` : ''}
    </div>`;
  const btn = document.getElementById('do-confirm');
  if (btn) btn.onclick = () => doConfirm(d, document.getElementById('ov').checked);
}

async function doConfirm(d, overrideCap) {
  try {
    const r = await api(`/admin/events/${d.event.id}/confirm`, { method: 'POST', body: { overrideCap } });
    toast(`发奖批次已创建：${r.payoutCount} 人，成功 ${r.dispatch.credited}，重试中 ${r.dispatch.unknown}，失败 ${r.dispatch.failed}`);
    if (r.unbound?.length) toast(`⚠ 未绑定 QQ 未发：${r.unbound.join('、')}`, true);
    renderManage(d.event.id);
  } catch (e) {
    toast(e.message, true);
    if (e.data?.error === '存在奖励超限的玩法项，需勾选“知晓超限”后才能确认') {
      document.getElementById('ov-row')?.removeAttribute('hidden');
    }
  }
}

function statusBadge(s) {
  const m = { pending: ['待发', 'orange'], credited: ['已到账', 'green'], failed: ['失败', 'red'], reversed: ['已冲正', 'gray'], exhausted: ['重试耗尽', 'orange'] };
  const [label, cls] = m[s] || [s, 'gray'];
  return `<span class="badge ${cls}">${label}</span>`;
}

// ---------- 对账 ----------
async function renderRecon() {
  const { runs } = await api('/admin/recon');
  app.innerHTML = `
    <div class="card">
      <h3>每日对账（应收 vs 实发）</h3>
      ${runs.length === 0 ? '<div class="muted">还没有对账记录。每日 09:00（北京时间）自动跑一次，对昨天的账。</div>' : `
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
      </table>`}
    </div>`;
}

// ---------- 框架 ----------
function formatContent(type, c) {
  if (type === 'score') return `${c.home}:${c.away}`;
  if (type === 'wdl') return { home: '主胜', draw: '平', away: '客胜' }[c] || c;
  if (type === 'goals') return `${c} 球`;
  return String(c);
}

function switchTab(tab) {
  view.tab = tab;
  document.getElementById('tab-events').style.fontWeight = tab === 'events' ? '800' : '400';
  document.getElementById('tab-recon').style.fontWeight = tab === 'recon' ? '800' : '400';
  route();
}

document.getElementById('tab-events').onclick = () => switchTab('events');
document.getElementById('tab-recon').onclick = () => switchTab('recon');
document.getElementById('nav-logout').onclick = async () => {
  await api('/logout', { method: 'POST' });
  me = null; renderLogin();
};

window.addEventListener('hashchange', route);
function route() {
  if (!me?.user) { renderLogin(); return; }
  if (me.user.role === 'user' && !me.is_initiator) {
    app.innerHTML = '<div class="banner bad">没有管理权限</div>';
    return;
  }
  const h = location.hash || '#/';
  if (h.startsWith('#/manage/')) renderManage(Number(h.split('/')[2])).catch(showErr);
  else if (h.startsWith('#/batch/')) renderBatch(Number(h.split('/')[2])).catch(showErr);
  else if (h === '#/new') renderNew().catch(showErr);
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
