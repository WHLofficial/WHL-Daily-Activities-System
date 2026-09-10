// 用户端 SPA（无框架，hash 路由）：#/ 列表 · #/event/:id 详情 · #/bind 绑定
import { api, fmtTime, countdown, STATUS_LABEL, STATUS_CLASS, esc, toast, PASSWORD_FORM, wirePassword } from './core.js';

const app = document.getElementById('app');
let me = null; // { user, binding }

// ---------- 登录 / 注册 ----------
function renderLogin(mode = 'login') {
  const reg = mode === 'register';
  app.innerHTML = `
    <div class="card" style="margin-top:40px">
      <h3>${reg ? '注册' : '登录'}</h3>
      <div class="muted">账号与比赛系统通用，任一站注册均可</div>
      <label class="field"><span>昵称</span><input id="li-u" autocomplete="username"></label>
      <label class="field"><span>密码</span><input id="li-p" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}"></label>
      ${reg ? `
      <label class="field"><span>邮箱（选填）</span><input id="li-e" type="email"></label>
      <label class="field"><span>注册码（选填）</span><input id="li-c"></label>` : ''}
      <div class="row" style="margin-top:16px"><button id="li-go" style="flex:1">${reg ? '注 册' : '登 录'}</button></div>
      <div class="muted" style="margin-top:10px;text-align:center">${reg ? '已有账号？' : '没有账号？'}<a href="#" id="li-sw">${reg ? '去登录' : '注册一个'}</a></div>
    </div>`;
  document.getElementById('li-sw').onclick = (e) => { e.preventDefault(); location.hash = reg ? '#/login' : '#/register'; };
  const go = async () => {
    try {
      if (reg) {
        await api('/register', {
          method: 'POST',
          body: { name: v('li-u'), password: v('li-p'), email: v('li-e'), signupCode: v('li-c') },
        });
        toast('注册成功，已自动登录');
      } else {
        await api('/login', { method: 'POST', body: { username: v('li-u'), password: v('li-p') } });
      }
      await loadMe(); route();
    } catch (e) { toast(e.message, true); }
  };
  document.getElementById('li-go').onclick = go;
  app.querySelectorAll('input').forEach((i) => i.addEventListener('keydown', (e) => e.key === 'Enter' && go()));
}
const v = (id) => document.getElementById(id)?.value?.trim();

// ---------- 列表 ----------
async function renderList() {
  const { events } = await api('/events');
  if (events.length === 0) {
    app.innerHTML = '<div class="empty">还没有竞猜期，等发起人开盘吧</div>';
    return;
  }
  app.innerHTML = events.map((e) => `
    <a class="card" href="#/event/${e.id}" style="display:block;text-decoration:none;color:inherit">
      <div class="row spread">
        <h3>${esc(e.title)}</h3>
        <span class="badge ${STATUS_CLASS[e.status]}">${STATUS_LABEL[e.status]}</span>
      </div>
      <div class="muted">截止 ${fmtTime(e.deadline)} · ${e.participants} 人参与 · 我已猜 ${e.myPredictions} 题</div>
    </a>`).join('');
}

// ---------- 详情 ----------
const TYPE_NAME = { score: '猜比分', wdl: '胜平负', goals: '总进球', fun: '趣味题' };

function tierHint(item) {
  const t = JSON.parse(item.tier_json);
  const parts = [];
  if (t.score) parts.push(`比分全中 +${t.score}`);
  if (t.goals) parts.push(`总进球 +${t.goals}`);
  if (t.wdl) parts.push(`胜平负 +${t.wdl}`);
  if (t.fun) parts.push(`命中 +${t.fun}`);
  return parts.join(' · ');
}

function itemInput(item, saved) {
  if (item.type === 'score') {
    const s = saved || { home: '', away: '' };
    return `<div class="row">
      <input class="score-in" type="number" min="0" max="99" data-f="home" value="${s.home}" placeholder="主">
      <span class="muted">:</span>
      <input class="score-in" type="number" min="0" max="99" data-f="away" value="${s.away}" placeholder="客">
    </div>`;
  }
  if (item.type === 'wdl') {
    const s = saved || '';
    return `<div class="seg">${['home:主胜', 'draw:平', 'away:客胜'].map((x) => {
      const [val, label] = x.split(':');
      return `<label class="${s === val ? 'on' : ''}"><input type="radio" name="i${item.id}" data-f="wdl" value="${val}" ${s === val ? 'checked' : ''}>${label}</label>`;
    }).join('')}</div>`;
  }
  if (item.type === 'goals') {
    return `<input class="score-in" type="number" min="0" max="20" data-f="goals" value="${saved ?? ''}" placeholder="球数">`;
  }
  return `<input data-f="fun" maxlength="200" value="${esc(saved ?? '')}" placeholder="写下你的答案">`;
}

function renderMyResult(my, totalAmount) {
  return `
    <div class="banner info">我本期得分 <b>${my.total ?? 0}</b> 分 · 全场共发放 ${totalAmount ?? 0} 分</div>
    ${my.items?.map((i) => `
      <div class="subitem">
        ${i.hit ? `<span class="hit">✔</span> +${i.reward}` : '<span class="miss">✘</span>'}
        ${esc(i.question)} — 我的答案：${esc(formatContent(i.type, i.content))}
        ${i.hitTiers?.length > 1 ? `<span class="muted">（命中 ${i.hitTiers.map((t) => TYPE_NAME_M[t] || t).join('+')}，取最高档）</span>` : ''}
      </div>`).join('')}`;
}
const TYPE_NAME_M = { score: '比分', goals: '总进球', wdl: '胜平负', fun: '趣味' };

function formatContent(type, c) {
  if (type === 'score') return `${c.home}:${c.away}`;
  if (type === 'wdl') return { home: '主胜', draw: '平', away: '客胜' }[c] || c;
  if (type === 'goals') return `${c} 球`;
  return String(c);
}

async function renderDetail(id) {
  const d = await api(`/events/${id}`);
  const e = d.event;
  const canSubmit = e.status === 'open' && new Date(e.deadline).getTime() > Date.now();

  app.innerHTML = `
    <a class="muted" href="#/">← 返回列表</a>
    <div class="card">
      <div class="row spread">
        <h3>${esc(e.title)}</h3>
        <span class="badge ${STATUS_CLASS[e.status]}">${STATUS_LABEL[e.status]}</span>
      </div>
      <div class="muted">
        ${e.status === 'open' ? `截止 ${fmtTime(e.deadline)}（${countdown(e.deadline)}）` : `截止 ${fmtTime(e.deadline)}`}
        · ${d.participants} 人参与 · 共 ${d.items.length} 题
      </div>
      ${e.myResult ? renderMyResult(e.myResult, e.totalAmount) : ''}
    </div>
    ${canSubmit && me && !me.binding ? `
      <div class="card" style="border-color:#e6a23c">
        ⚠️ 提交预测前需先完成 <a href="#/bind">QQ 绑定</a>（绑定后积分才能自动到账）
      </div>` : ''}
    ${d.matches.map((m) => `
      <div class="card">
        <div class="match-head">
          <h3>⚽ ${esc(m.home)} vs ${esc(m.away)}</h3>
          ${m.kickoff ? `<span class="muted">${fmtTime(m.kickoff)}</span>` : ''}
        </div>
        ${d.items.filter((i) => i.match_id === m.id).map((i) => `
          <div class="item" data-item="${i.id}">
            <div class="q">${esc(i.question)} <span class="muted" style="font-weight:400">· ${TYPE_NAME[i.type]}</span></div>
            <div class="tier-hint">${tierHint(i)}</div>
            ${itemInput(i, d.myPredictions[i.id])}
          </div>`).join('')}
      </div>`).join('')}
    ${canSubmit ? `
      <div class="row" style="margin-top:6px">
        <button id="submit" style="flex:1">提交预测（截止前可改）</button>
      </div>` : ''}
  `;

  // 胜平负分段选择高亮
  app.querySelectorAll('.seg input').forEach((r) => r.addEventListener('change', () => {
    r.closest('.seg').querySelectorAll('label').forEach((l) => l.classList.toggle('on', l.querySelector('input').checked));
  }));

  const btn = document.getElementById('submit');
  if (btn) btn.onclick = async () => {
    const predictions = [];
    for (const block of app.querySelectorAll('[data-item]')) {
      const itemId = Number(block.dataset.item);
      const f = (name) => block.querySelector(`[data-f="${name}"]`);
      const item = d.items.find((i) => i.id === itemId);
      let content;
      if (item.type === 'score') content = { home: num(f('home')), away: num(f('away')) };
      else if (item.type === 'wdl') content = block.querySelector('[data-f="wdl"]:checked')?.value;
      else if (item.type === 'goals') content = num(f('goals'));
      else content = f('fun')?.value.trim();
      if (content === undefined || content === null || content === '' ||
          (item.type === 'score' && (!Number.isInteger(content.home) || !Number.isInteger(content.away)))) {
        toast(`「${item.question}」还没填完整`, true);
        return;
      }
      predictions.push({ playItemId: itemId, content });
    }
    try {
      await api(`/events/${id}/predictions`, { method: 'PUT', body: { predictions } });
        toast('提交成功，截止前可随时修改');
        renderDetail(id);
      } catch (e2) {
        if (e2.code === 'need_binding') {
          toast('请先完成 QQ 绑定', true);
          location.hash = '#/bind';
        } else { toast(e2.message, true); }
      }
  };
}
const num = (el) => {
  const n = Number(el?.value);
  return el?.value !== '' && Number.isInteger(n) ? n : NaN;
};

// ---------- 绑定 ----------
async function renderBind() {
  const { binding } = await api('/me');
  if (binding) {
    app.innerHTML = `
      <div class="card">
        <h3>QQ 绑定</h3>
        <p>已绑定 QQ：<b>${esc(binding.qq_id)}</b></p>
        <p class="muted">绑定时间 ${fmtTime(binding.bound_at)}</p>
      </div>`;
    return;
  }
  app.innerHTML = `
    <div class="card">
      <h3>绑定 QQ</h3>
      <p class="muted">绑定后竞猜积分才能由 bot 自动发到你的 QQ 账号。一码一次、10 分钟有效。</p>
      <div class="row"><button id="gen" style="flex:1">获取绑定码</button></div>
      <div id="code-box"></div>
    </div>`;
  document.getElementById('gen').onclick = async () => {
    try {
      const { code } = await api('/bind/new', { method: 'POST' });
      document.getElementById('code-box').innerHTML = `
        <div class="bigcode">${esc(code)}</div>
        <p>在 QQ 群里向 bot 发送：</p>
        <p style="text-align:center"><code class="kbd">绑定 ${esc(code)}</code></p>
        <p class="muted">bot 回复确认即绑定成功。</p>`;
    } catch (e) { toast(e.message, true); }
  };
}

// ---------- 改密码 ----------
function renderPassword() {
  app.innerHTML = `<a class="muted" href="#/">← 返回</a><div class="card">${PASSWORD_FORM}</div>`;
  wirePassword(app, () => { location.hash = '#/'; });
}

// ---------- 顶栏 ----------
function renderTopbar() {
  const user = me?.user;
  document.getElementById('userbox').hidden = !user;
  document.getElementById('nav-bind').hidden = !user;
  document.getElementById('nav-admin').hidden = !user || (user.role !== 'admin' && !me.is_initiator);
  if (user) {
    document.getElementById('user-name').textContent = user.name;
    document.getElementById('user-role').textContent =
      user.role === 'admin' ? '管理员' : me.is_initiator ? '发起人' : '观众';
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

// ---------- 框架 ----------
async function loadMe() { me = await api('/me'); }

function route() {
  renderTopbar();
  if (!me?.user) { renderLogin(location.hash === '#/register' ? 'register' : 'login'); return; }
  const h = location.hash || '#/';
  if (h.startsWith('#/event/')) renderDetail(Number(h.split('/')[2])).catch(showErr);
  else if (h === '#/bind') renderBind().catch(showErr);
  else if (h === '#/password') renderPassword();
  else renderList().catch(showErr);
}
function showErr(e) {
  app.innerHTML = `<div class="banner bad">${esc(e.message)}</div><a class="muted" href="#/">← 返回</a>`;
}

window.addEventListener('hashchange', route);

loadMe().then(route).catch(showErr);
