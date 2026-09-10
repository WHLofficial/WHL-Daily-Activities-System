// 前端共享工具：API 封装、时间格式化、提示、HTML 转义

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await res.json(); } catch { /* 空响应 */ }
  if (!res.ok) {
    const err = new Error(data.message || data.error || `请求失败（${res.status}）`);
    err.code = data.error;
    err.data = data;
    throw err;
  }
  return data;
}

export function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso.includes('T') || iso.includes('Z') ? iso : iso.replace(' ', 'T') + 'Z');
  return d.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  });
}

export function countdown(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return '已截止';
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  return h >= 24 ? `剩 ${Math.floor(h / 24)} 天 ${h % 24} 小时` : h > 0 ? `剩 ${h} 小时 ${m} 分` : `剩 ${m} 分钟`;
}

export const STATUS_LABEL = {
  draft: '草稿', open: '开放中', sealed: '已截止', settled: '已结算', paid: '已发奖', archived: '已归档',
};
export const STATUS_CLASS = {
  draft: 'gray', open: 'green', sealed: 'orange', settled: 'blue', paid: 'purple', archived: 'gray',
};

// 题型与档位：全站唯一来源，防止各视图各叫一套
export const TYPE_NAME = { score: '猜比分', wdl: '胜平负', goals: '总进球', fun: '趣味题' };
export const TIER_LABEL = { score: '比分全中', goals: '总进球', wdl: '胜平负', fun: '趣味命中' };

// 角色名与身份徽章：管理员（赛事系统管理员）/ 发起人 / 普通用户
export const ROLE_NAME = { admin: '管理员', superadmin: '管理员', coach: '普通用户', user: '普通用户' };
export function roleLabel(user, isInitiator) {
  if (!user) return '';
  if (user.role === 'admin' || user.role === 'superadmin') return '管理员';
  return isInitiator ? '发起人' : '普通用户';
}

// 发放批次与发放项状态
export const BATCH_STATUS = {
  pending: ['待发', 'gray'], partial: ['部分到账', 'orange'], paid: ['已全部到账', 'green'],
};
export const PAYOUT_STATUS = {
  pending: ['待发', 'orange'], credited: ['已到账', 'green'], failed: ['失败', 'red'],
  reversed: ['已冲正', 'gray'], exhausted: ['重试耗尽', 'orange'],
};
export function statusPill(map, s) {
  const [label, cls] = map[s] || [s, 'gray'];
  return `<span class="badge ${cls}">${label}</span>`;
}

export function formatContent(type, c) {
  if (type === 'score') return `${c.home}:${c.away}`;
  if (type === 'wdl') return { home: '主胜', draw: '平', away: '客胜' }[c] || c;
  if (type === 'goals') return `${c} 球`;
  return String(c);
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function toast(msg, isErr = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 3000);
}

// 改密码表单（用户端与管理台共用）：账号全站通用，改完两边都生效
export const PASSWORD_FORM = `
  <h3>修改密码</h3>
  <div class="muted">新密码至少 8 位，要同时包含字母和数字。改完在赛事系统也用新密码登录。</div>
  <label class="field"><span>当前密码</span><input id="pw-old" type="password" autocomplete="current-password"></label>
  <label class="field"><span>新密码</span><input id="pw-new" type="password" autocomplete="new-password"></label>
  <label class="field"><span>再输一次新密码</span><input id="pw-new2" type="password" autocomplete="new-password"></label>
  <div class="row mt"><button class="grow" id="pw-go">保存新密码</button></div>`;

export function wirePassword(root, onDone) {
  const val = (id) => root.querySelector('#' + id)?.value?.trim() ?? '';
  const go = async () => {
    if (val('pw-new') !== val('pw-new2')) return toast('两次输入的新密码不一致', true);
    try {
      await api('/password', { method: 'POST', body: { oldPassword: val('pw-old'), newPassword: val('pw-new') } });
      toast('密码已更新');
      onDone();
    } catch (e) { toast(e.message, true); }
  };
  root.querySelector('#pw-go').onclick = go;
  root.querySelectorAll('input').forEach((i) => i.addEventListener('keydown', (e) => e.key === 'Enter' && go()));
}
