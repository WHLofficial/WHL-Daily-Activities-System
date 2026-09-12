// 用户端 SPA（无框架，hash 路由）：#/ 竞猜列表 · #/event/:id 详情 · #/bind 绑定 QQ · #/password 改密码
import {
  api, withBusy, fmtTime, countdown, STATUS_LABEL, STATUS_CLASS, esc, toast,
  TYPE_NAME, TIER_LABEL, WDL_NAME, formatContent, roleLabel, PASSWORD_FORM, wirePassword, initTopbar,
} from './core.js';

const app = document.getElementById('app');
let me = null; // { user, is_initiator, binding }

// ---------- 登录 / 注册 ----------
function renderLogin(mode = 'login') {
  const reg = mode === 'register';
  app.innerHTML = `
    <div class="card auth-card">
      <h3>${reg ? '注册账号' : '登录'}</h3>
      <div class="muted">账号与赛事系统通用，两个网站都能用。</div>
      <label class="field"><span>昵称</span><input id="li-u" autocomplete="username"></label>
      <label class="field"><span>密码</span><input id="li-p" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}"></label>
      ${reg ? `
      <label class="field"><span>邮箱（选填）</span><input id="li-e" type="email"></label>
      <label class="field"><span>注册码（选填）</span><input id="li-c"></label>` : ''}
      <div class="row mt"><button class="grow" id="li-go">${reg ? '注册' : '登录'}</button></div>
      <div class="center muted mt-s">${reg ? '已有账号？' : '还没有账号？'}<a href="#" id="li-sw">${reg ? '去登录' : '注册一个'}</a></div>
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

// ---------- 竞猜列表 ----------
async function renderList() {
  const { events } = await api('/events');
  if (events.length === 0) {
    app.innerHTML = '<div class="empty">还没有竞猜。等发起人开一场，这里就会出现。</div>';
    return;
  }
  app.innerHTML = events.map((e) => `
    <a class="card" href="#/event/${e.id}">
      <div class="row spread">
        <h3>${esc(e.title)}</h3>
        <span class="badge ${STATUS_CLASS[e.status]}">${STATUS_LABEL[e.status]}</span>
      </div>
      <div class="muted">截止 ${fmtTime(e.deadline)} · 最高可得 ${e.maxScore} 分 · ${e.participants} 人参与 · ${e.myPredictions ? `我已提交 ${e.myPredictions} 题` : '我还没提交'}</div>
    </a>`).join('');
}

// ---------- 详情 ----------
function tierHint(item) {
  const t = JSON.parse(item.tier_json);
  if (item.type === 'wdl_all') {
    // 两种计分模式：每中一场固定分，或按命中场数分档（取满足的最高档）。
    // 档位最多到命中场数，这里只列真正配了分的，没配的档不显示。
    if (t.mode === 'per_hit') return `每命中一场 +${t.perHit}`;
    return Object.keys(t).filter((k) => /^hit\d+$/.test(k) && t[k])
      .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)))
      .map((k) => `${TIER_LABEL[k] || k} +${t[k]}`).join(' · ');
  }
  return ['score', 'goals', 'wdl', 'fun'].filter((k) => t[k]).map((k) => `${TIER_LABEL[k]} +${t[k]}`).join(' · ');
}

const wdlSeg = (name, dataF, extra, cur) => `
  <div class="seg">${['home', 'draw', 'away'].map((val) => `
    <label class="${cur === val ? 'on' : ''}">
      <input type="radio" name="${name}" data-f="${dataF}" ${extra} value="${val}" ${cur === val ? 'checked' : ''}>${WDL_NAME[val]}
    </label>`).join('')}</div>`;

function itemInput(item, saved, matches) {
  if (item.type === 'score') {
    const s = saved || { home: '', away: '' };
    return `<div class="row">
      <input class="score-in" type="number" min="0" max="99" data-f="home" value="${s.home}" placeholder="主">
      <span class="muted">:</span>
      <input class="score-in" type="number" min="0" max="99" data-f="away" value="${s.away}" placeholder="客">
    </div>`;
  }
  if (item.type === 'wdl') {
    return wdlSeg(`i${item.id}`, 'wdl', '', saved || '');
  }
  if (item.type === 'goals') {
    return `<input class="score-in" type="number" min="0" max="20" data-f="goals" value="${saved ?? ''}" placeholder="球数">`;
  }
  if (item.type === 'wdl_all') {
    // 每场比赛一组主胜/平/客胜，提交时按场次汇总成一个对象
    const s = saved || {};
    return (matches || []).map((m) => `
      <div class="wdl-all-row">
        <span class="grow">${esc(m.home)} vs ${esc(m.away)}</span>
        ${wdlSeg(`i${item.id}-${m.id}`, 'wdl_all', `data-m="${m.id}"`, s[m.id] || '')}
      </div>`).join('');
  }
  return `<input data-f="fun" maxlength="200" value="${esc(saved ?? '')}" placeholder="写下你的答案">`;
}

function renderMyResult(my, totalAmount, matches) {
  const mine = my.total ?? 0;
  const all = totalAmount ?? 0;
  // 全场为 0 说明无人命中，与「我没中但场上有分」是两回事，分开说
  const banner = all === 0
    ? '本次无人命中，没有积分发放'
    : mine > 0
      ? `本次竞猜我得 <b>${mine}</b> 分，全场共发放 ${all} 分`
      : `本次竞猜我没有得分，全场共发放 ${all} 分`;
  return `
    <div class="banner info">${banner}</div>
    ${my.items?.map((i) => {
      const hn = /^hit(\d+)$/.exec(String(i.tier || ''));
      const tag = i.hit
        ? `<span class="hit">命中${hn ? ` ${hn[1]} 场` : ''}</span> +${i.reward}`
        : '<span class="miss">未命中</span>';
      return `
      <div class="subitem">
        ${tag}
        ${esc(i.question)}，我的答案：${esc(formatContent(i.type, i.content, matches))}
        ${i.hitTiers?.length > 1 ? `<span class="muted">（同时命中 ${i.hitTiers.map((t) => TIER_LABEL[t] || t).join('、')}，取最高档）</span>` : ''}
      </div>`;
    }).join('')}`;
}

// 大家的答案：只列昵称与答案。结算后（有 hits）附命中场数与得分。
// 猜胜负是跨场玩法，每人的逐场选择压成一串「胜平负负负」直接常开展示：
// 结算后按服务端下发的 matchHits 把命中的字标绿、未中灰；漏选的场用灰「？」占位。
const WDL_CHAR = { home: '胜', draw: '平', away: '负' };

function wdlString(picks, matches, matchHits) {
  return matches.map((m) => {
    const pick = picks[m.id];
    if (!pick) return '<span class="muted">？</span>';
    const ch = WDL_CHAR[pick];
    if (!ch) return '<span class="muted">？</span>';
    if (!matchHits || matchHits[m.id] === undefined) return esc(ch);
    return `<span class="${matchHits[m.id] ? 'hit' : 'miss'}">${ch}</span>`;
  }).join('');
}

function renderOthers(d) {
  const others = d.others || [];
  const single = d.items.filter((i) => i.match_id != null);
  const cross = d.items.filter((i) => i.match_id == null);
  return `
    <div class="card">
      <h3>大家的答案${others.length ? `（${others.length} 人）` : ''}</h3>
      <div class="muted mt-s">提交后，其他参赛者也能看到你的答案。${others.length ? '' : '目前还没有其他人提交。'}</div>
      ${others.map((o) => `
        <div class="other">
          <div class="row spread">
            <b>${esc(o.name)}</b>
            ${o.total != null ? `<span class="badge blue">${o.total} 分</span>` : ''}
          </div>
          ${single.filter((i) => o.items[i.id] !== undefined).map((i) => {
            const m = d.matches.find((x) => x.id === i.match_id) || {};
            const gained = o.hits ? o.hits[i.id] : undefined;
            return `<div class="other-line">
              <span class="muted">${esc(m.home || '')} vs ${esc(m.away || '')}</span>
              <span class="grow">${i.question === TYPE_NAME[i.type] ? '' : `${esc(i.question)}：`}${esc(formatContent(i.type, o.items[i.id], d.matches))}</span>
              ${o.hits ? (gained !== undefined ? `<span class="hit">+${gained}</span>` : '<span class="miss">未中</span>') : ''}
            </div>`;
          }).join('')}
          ${cross.filter((i) => o.items[i.id] !== undefined).map((i) => {
            const gained = o.hits ? o.hits[i.id] : undefined;
            const hits = (o.hitCounts && o.hitCounts[i.id]) || 0;
            return `<div class="other-line">
              <span class="muted">${esc(i.question)}</span>
              <span class="grow wdl-string">${wdlString(o.items[i.id], d.matches, o.matchHits && o.matchHits[i.id])}</span>
              ${o.hits ? `<span class="${gained !== undefined ? 'hit' : 'miss'}">命中 ${hits} 场</span>${gained !== undefined ? `<span class="hit">+${gained}</span>` : ''}` : ''}
            </div>`;
          }).join('')}
        </div>`).join('')}
    </div>`;
}

// 奖励一览：填预测之前先看得见能拿多少。逐项列档位，最高可得＝各项最高档之和。
// 一场可以有多项玩法，光写「主队 vs 客队」区分不开，所以场次后面缀上题面；
// 跨场次项反过来：题面就是玩法名，需要补的是总场数。
function renderRewards(d) {
  const max = d.event.maxScore;
  if (!(max > 0)) return '';
  const lines = d.items.map((i) => {
    let label = esc(i.question);
    if (i.match_id == null) label += `（全部 ${d.matches.length} 场）`;
    else {
      const m = d.matches.find((x) => x.id === i.match_id);
      if (m) label = `${esc(m.home)} vs ${esc(m.away)} · ${label}`;
    }
    return { label, hint: tierHint(i) };
  }).filter((l) => l.hint);
  if (lines.length === 0) return '';
  return `
    <div class="card">
      <div class="row spread">
        <h3>本局奖励</h3>
        <span class="badge blue">最高可得 ${max} 分</span>
      </div>
      <div class="muted">每项按命中档位发分，全部猜中可得 ${max} 分。</div>
      <div class="reward-list">
        ${lines.map((l) => `
          <div class="reward-line">
            <div class="q">${l.label}</div>
            <div class="muted">${l.hint}</div>
          </div>`).join('')}
      </div>
    </div>`;
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
        · ${d.participants} 人参与 · ${d.form === 'pure' ? `${d.matches.length} 场比赛` : `共 ${d.items.length} 题`}
      </div>
      ${e.myResult ? renderMyResult(e.myResult, e.totalAmount, d.matches) : ''}
    </div>
    ${canSubmit && me && !me.binding ? `
      <div class="banner warn">提交预测前要先完成 <a href="#/bind">QQ 绑定</a>，绑定后积分才能自动发到你的 QQ 上。</div>` : ''}
    ${renderRewards(d)}
    ${d.form === 'pure' ? `
      <div class="banner info">本局共 ${d.matches.length} 场比赛，每场都要选出胜负。</div>` : d.matches.map((m) => `
      <div class="card">
        <div class="match-head">
          <h3>${esc(m.home)} vs ${esc(m.away)}</h3>
          ${m.kickoff ? `<span class="muted">${fmtTime(m.kickoff)}</span>` : ''}
        </div>
        ${d.items.filter((i) => i.match_id === m.id).map((i) => `
          <div class="item" data-item="${i.id}">
            <div class="q">${esc(i.question)}${i.question === TYPE_NAME[i.type] ? '' : ` <span class="muted">${TYPE_NAME[i.type]}</span>`}</div>
            <div class="tier-hint">${tierHint(i)}</div>
            ${itemInput(i, d.myPredictions[i.id], d.matches)}
          </div>`).join('')}
      </div>`).join('')}
    ${d.items.filter((i) => i.match_id == null).map((i) => `
      <div class="card">
        <div class="match-head">
          <h3>${esc(i.question)}</h3>
          <span class="muted">全部 ${d.matches.length} 场</span>
        </div>
        <div class="item" data-item="${i.id}">
          <div class="q">${d.form === 'pure' ? `共 ${d.matches.length} 场，逐场选` : '每场都要选，按命中场数算分'}</div>
          <div class="tier-hint">${tierHint(i)}</div>
          ${itemInput(i, d.myPredictions[i.id], d.matches)}
        </div>
      </div>`).join('')}
    ${canSubmit ? `
      <div class="row mt"><button class="grow" id="submit">提交预测</button></div>` : ''}
    ${renderOthers(d)}
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
      else if (item.type === 'wdl_all') {
        content = {};
        block.querySelectorAll('[data-f="wdl_all"]:checked').forEach((r) => { content[r.dataset.m] = r.value; });
        if (Object.keys(content).length !== d.matches.length) {
          toast(`「${item.question}」还有比赛没选`, true);
          return;
        }
      } else content = f('fun')?.value.trim();
      if (content === undefined || content === null || content === '' ||
          (item.type === 'score' && (!Number.isInteger(content.home) || !Number.isInteger(content.away)))) {
        toast(`「${item.question}」还没填完`, true);
        return;
      }
      predictions.push({ playItemId: itemId, content });
    }
    try {
      // busy 挂在 api 调用上：提交期间按钮禁用防双击，弱网 15 秒超时有明确提示
      await withBusy(btn, () => api(`/events/${id}/predictions`, { method: 'PUT', body: { predictions } }));
      toast('提交成功，截止前可以随时修改');
      renderDetail(id);
    } catch (e2) {
      if (e2.code === 'need_binding') {
        toast('要先绑定 QQ 才能提交预测', true);
        location.hash = '#/bind';
      } else { toast(e2.message, true); }
    }
  };
}
const num = (el) => {
  const n = Number(el?.value);
  return el?.value !== '' && Number.isInteger(n) ? n : NaN;
};

// ---------- 绑定 QQ ----------
// 绑定状态直接用启动时缓存的 me.binding，不再每次进页都拉一遍 /me；
// 绑没绑上由用户点「刷新状态」确认（机器人绑定是站外动作，自动轮询意义不大）
async function renderBind() {
  const binding = me?.binding;
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
      <p class="muted">绑定后，竞猜积分才能自动发到你的 QQ 上。一个绑定码只能用一次，10 分钟内有效。</p>
      <div class="row"><button class="grow" id="gen">获取绑定码</button></div>
      <div id="code-box"></div>
      <div class="row mt-s"><button class="ghost small" id="bind-refresh">绑定好了？刷新状态</button></div>
    </div>`;
  const gen = document.getElementById('gen');
  gen.onclick = async () => {
    try {
      const { code } = await withBusy(gen, () => api('/bind/new', { method: 'POST' }));
      document.getElementById('code-box').innerHTML = `
        <div class="bigcode">${esc(code)}</div>
        <p>在 QQ 群里发送：</p>
        <p class="center"><code class="kbd">绑定 ${esc(code)}</code></p>
        <p class="muted">机器人回复确认即绑定成功。</p>`;
    } catch (e) { toast(e.message, true); }
  };
  document.getElementById('bind-refresh').onclick = async () => {
    await loadMe();
    renderBind();
  };
}

// ---------- 改密码 ----------
function renderPassword(forced = false) {
  app.innerHTML = `${forced
    ? '<div class="banner warn">密码刚被重置，请先设置新密码。改完才能继续用。</div>'
    : '<a class="muted" href="#/">← 返回</a>'}<div class="card">${PASSWORD_FORM}</div>`;
  wirePassword(app, async () => { await loadMe(); location.hash = '#/'; });
}

// ---------- 顶栏 ----------
function renderTopbar() {
  const user = me?.user;
  document.getElementById('userbox').hidden = !user;
  document.getElementById('nav-bind').hidden = !user;
  document.getElementById('nav-admin').hidden = !user || (user.role !== 'admin' && !me.is_initiator);
  if (user) {
    document.getElementById('user-name').textContent = user.display_name || user.username || '';
    document.getElementById('user-role').textContent = roleLabel(user, me.is_initiator);
  }
}

// 顶栏的两个常驻入口与登录态无关，启动时接一次线就够
initTopbar();

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
  // 被管理员重置过密码：先去改密，别处都进不去（服务端也会拦下业务接口）
  if (me.mustChangePassword) {
    if (location.hash !== '#/password') { location.hash = '#/password'; return; }
    renderPassword(true);
    return;
  }
  const h = location.hash || '#/';
  if (h.startsWith('#/event/')) renderDetail(Number(h.split('/')[2])).catch(showErr);
  else if (h === '#/bind') renderBind().catch(showErr);
  else if (h === '#/password') renderPassword();
  else renderList().catch(showErr);
}
function showErr(e) {
  if (e.code === 'password_change_required') {
    me = { ...(me || {}), mustChangePassword: true };
    if (location.hash === '#/password') route(); else location.hash = '#/password';
    return;
  }
  app.innerHTML = `<div class="banner bad">${esc(e.message)}</div><a class="muted" href="#/">← 返回</a>`;
}

window.addEventListener('hashchange', route);

loadMe().then(route).catch(showErr);
