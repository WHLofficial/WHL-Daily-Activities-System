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
    const err = new Error(data.message || data.error || `请求失败 (${res.status})`);
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
