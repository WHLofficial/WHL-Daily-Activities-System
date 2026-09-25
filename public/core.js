// 前端共享工具：API 封装、时间格式化、提示、HTML 转义

// 弱网下请求可能永远 pending，按钮又没有反馈，就成了「点了没反应」。15 秒兜底（对齐赛事系统）。
const API_TIMEOUT_MS = 15000;

export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      const err = new Error('网络超时，请重试');
      err.code = 'timeout';
      throw err;
    }
    throw e;
  }
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

// 写操作按钮统一挂 busy：禁用 + 「处理中…」，完成后还原；顺带挡掉双击重复提交。
// fn 里通常会重渲页面把按钮换掉，还原一个已脱离 DOM 的节点无害。
export async function withBusy(btn, fn) {
  if (!btn) return fn();
  if (btn.disabled) return;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '处理中…';
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
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
export const TYPE_NAME = { score: '猜比分', wdl: '胜平负', goals: '总进球', fun: '趣味题', wdl_all: '猜胜负' };
export const TIER_LABEL = {
  score: '比分全中', goals: '总进球', wdl: '胜平负', fun: '趣味命中',
  // 猜胜负最多 10 场，档位名按命中场数生成，免得每加一场就要手写一条
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`hit${i + 1}`, `胜负中 ${i + 1} 场`])),
};
// 建期可选题型。不含 goals：独立的「总进球」题型已下线，判分与渲染仍认它，
// 好让历史竞猜照常显示；想猜总进球，用「猜比分」里的三档。
// 也不含 wdl_all：它覆盖全部场次，走建期页顶层的「猜胜负」开关，不在单场玩法项里选。
export const CREATE_TYPES = ['score', 'wdl', 'fun'];
// 胜平负三个选项的写法，前端各处共用
export const WDL_NAME = { home: '主胜', draw: '平', away: '客胜' };

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

// matches 只有「猜胜负」用得上：它的答案是按场次存的，要把场次 id 翻成队名
export function formatContent(type, c, matches) {
  if (type === 'score') return `${c.home}:${c.away}`;
  if (type === 'wdl') return WDL_NAME[c] || c;
  if (type === 'goals') return `${c} 球`;
  if (type === 'wdl_all') {
    return Object.entries(c || {}).map(([mid, pick]) => {
      const m = (matches || []).find((x) => x.id === Number(mid));
      const vs = m ? `${m.home} vs ${m.away}` : `场次 ${mid}`;
      return `${vs} ${WDL_NAME[pick] || pick}`;
    }).join(' · ');
  }
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
  // 折成多行时，999px 的胶囊圆角会把首尾文字顶到弧线外，换成常规圆角
  if (el.offsetHeight > 48) el.classList.add('multi');
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 3000);
}

// ---------- 统一认证（迁移步骤②，auth 项目 PRD P0-6）----------
// me.authMode === 'oidc' 时的入口跳转小件：
// 登录走本站 /api/auth/login（发起 authorize 链，回来即已登录）；注册/改密直达认证中心页面；
// 登出用隐藏表单 POST——302 链（本站吊销 → 认证中心吊销 → 回本站）只有浏览器导航跟得完，fetch 跟不完。
export function oidcLogin() { location.href = '/api/auth/login'; }
export function authCenter(me, path) { location.href = (me?.authHome || '') + path; }
export function oidcLogout() {
  const f = document.createElement('form');
  f.method = 'POST';
  f.action = '/api/auth/logout';
  document.body.appendChild(f);
  f.submit();
}

// ---------- 顶栏：站外入口与鸣谢弹层 ----------
// 赛事平台的地址。同主域下和它共享 whl_session，登录态互通：在那边登录过，这边也是登录的。
export const TOUR_URL = 'https://tour.whleague.win';

// 鸣谢弹层每次随机抽一条。emoji 与语气照抄赛事平台的同一套语录，
// 是「界面只用 🎯」的唯一例外，别顺手清理掉。
const CREDIT_QUOTES = [
  '没琛止打钱，这个竞猜系统今晚就得变人工智障。LLM算力靠氪金，首席赞助稳住我的饭碗🫡👑',
  '琛止哥的token就是这套系统的肾上腺素，没他这波赞助，你们点的每个选项都是一串乱码🌚',
  '你们在这猜的每一场，背后都是琛止在默默燃烧经费——这叫什么？金主爸爸的钞能力驱动竞猜AI，respect。',
  '没有琛止哥的token燃烧，就没有这个24小时在线的竞猜系统。哪天服务器一抽风我就当场躺平，让你们见识见识“没有LLM赞助的竞猜系统”——大概就是张白纸🌚',
  '没琛总赞助我当场断电，你们那注比分连个选项都填不明白🌚 感谢琛总保住我的数字牛马岗位！',
  '没有琛止哥的投喂，这个穷竞猜站早就白屏了——你们每填一注、每猜中一场，都是真金白银，今天还能陪你们玩竞猜，全靠琛止哥扛着账单🥺',
  '本系统的智商是租来的，租金全是琛止哥在付。哪天断了供，你们点开的就是一张会呼吸的白屏🌚',
  '你们手滑点错选项没关系，琛止哥手滑忘充值才是大事——那一刻，竞猜、预测、榜单，全都灰了🫡',
  '每交一次预测，就烧一次token；每次token燃烧，都有琛止哥在买单。这不叫猜比分，这叫钞能力拉满👑',
  '我为什么判命中又快又准？因为背后是琛止哥的API在硬扛。人工智障和人工智能，就差他这一笔赞助🥺',
  '别问竞猜系统为什么这么稳，问就是琛止哥的API稳。他的账单不抖，你们的预测就不抖🌚',
  '在这竞猜是免费的，但对我的大脑来说可不便宜——每个选项背后都是琛止哥实打实的账单🥺 鸣谢首席赞助！',
];
let lastQuote = -1;

// 顶栏在 HTML 里是静态的，与登录态无关：两个入口都常显，启动时接一次线即可
export function initTopbar() {
  const tour = document.getElementById('btn-tour');
  if (tour) tour.href = TOUR_URL;

  const btn = document.getElementById('btn-credit');
  if (!btn) return;
  let overlay = null;

  const close = () => {
    if (!overlay) return;
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    overlay = null;
    btn.focus();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  btn.onclick = () => {
    if (overlay) return;
    // 连着开两次不撞同一条
    let i;
    do { i = Math.floor(Math.random() * CREDIT_QUOTES.length); } while (CREDIT_QUOTES.length > 1 && i === lastQuote);
    lastQuote = i;

    overlay = document.createElement('div');
    overlay.className = 'credit';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', '鸣谢');
    overlay.innerHTML = `
      <div class="credit-card">
        <button class="credit-close" type="button" aria-label="关闭鸣谢">✕</button>
        <h3 class="credit-title">🏅 鸣谢</h3>
        <p class="credit-main">本项目使用 ZCode 产出。感谢 <b>琛止</b> 赞助 LLM API 费用。</p>
        <blockquote class="credit-quote"><span></span><cite>—— WHL机器人</cite></blockquote>
      </div>`;
    overlay.querySelector('.credit-quote span').textContent = CREDIT_QUOTES[i];
    // 点遮罩空白关，点卡片内部不关
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('.credit-close').onclick = close;

    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    overlay.querySelector('.credit-close').focus();
  };
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

// 页脚版本号。本仓没有构建步骤、静态资源不经打包，故这里的版本与 package.json 的 version 手工同步（见 VERSIONS.md）。
export const APP_VERSION = '1.0.1';

if (typeof document !== 'undefined' && !document.querySelector('.app-footer')) {
  const foot = document.createElement('footer');
  foot.className = 'app-footer';
  foot.textContent = `WHL 竞猜系统 · v${APP_VERSION}`;
  document.body.appendChild(foot);
}
