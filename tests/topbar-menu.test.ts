import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// v1.1.0 把平铺的「改密码 + 登出」收进右上角 ≡ 菜单。页面壳是纯静态 HTML + 原生 JS，
// 没有 jsdom，组件级断言做不了——沿用 cron-pair.test.ts 的静态锁思路：
// 文本扫描两页 HTML、style.css 与 core.js / app.js / admin.js，
// 卡住三类手工回归最易犯的错：登出被塞回平铺、aria 契约残缺、登出语义被顺手改写。
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(root + p, 'utf8');
const pages = ['public/index.html', 'public/admin.html'].map((p) => ({ path: p, html: read(p) }));

// userbox 切片：菜单壳只允许住在这段里（userbox 隐藏 ⇒ ≡ 跟着隐藏的既有显隐链）
function userboxSlice(html: string): string {
  const at = html.indexOf('id="userbox"');
  return html.slice(at, html.indexOf('</header>', at));
}

describe('v1.1.0 顶栏 ≡ 菜单静态锁（TC-MENU-G1…G5）', () => {
  it('TC-MENU-G1 两页 ≡ 按钮与弹层的 aria 契约、三条横线图标在场', () => {
    for (const { path, html } of pages) {
      const s = userboxSlice(html);
      expect(s, path).toContain('class="user-menu-btn"');
      expect(s, path).toContain('aria-label="菜单"');
      expect(s, path).toContain('aria-haspopup="menu"');
      expect(s, path).toContain('aria-expanded="false"');
      expect(s, path).toContain('role="menu"');
      expect(s, path).toContain('aria-label="用户菜单"');
      expect(s, path).toContain('role="menuitem"');
      expect(s, path).toContain('role="separator"');
      expect(s, path).toContain('d="M4 7h16M4 12h16M4 17h16"');
    }
  });

  it('TC-MENU-G2 改密码与登出住在菜单里，userbox 只留身份展示', () => {
    for (const { path, html } of pages) {
      const s = userboxSlice(html);
      const at = (needle: string) => {
        const i = s.indexOf(needle);
        expect(i, `${path} 缺 ${needle}`).toBeGreaterThanOrEqual(0);
        return i;
      };
      // 索引序：≡ 按钮 < 弹层 < 菜单头 < 改密码 < 分隔线 < 登出
      const btn = at('id="user-menu-btn"');
      const menu = at('id="user-menu"');
      const head = at('id="user-menu-head"');
      const pwd = at('id="nav-password"');
      const sep = at('user-menu-sep');
      const out = at('id="nav-logout"');
      expect(btn, path).toBeLessThan(menu);
      expect(menu).toBeLessThan(head);
      expect(head).toBeLessThan(pwd);
      expect(pwd).toBeLessThan(sep);
      expect(sep).toBeLessThan(out);
      // 身份展示留在原地
      expect(s, path).toContain('id="user-name"');
      expect(s, path).toContain('id="user-role"');
      // 旧平铺形态回归即红
      expect(s, path).not.toContain('<a id="nav-password" href="#/password">改密码</a>');
      expect(s, path).not.toContain('<button class="ghost" id="nav-logout">登出</button>');
    }
  });

  it('TC-MENU-G3 登出两段式语义与 ≡ 开合接线原样在场', () => {
    const core = read('public/core.js');
    expect(core).toContain('export function initUserMenu()');
    expect(core).toContain("btn.setAttribute('aria-expanded', String(open))");
    expect(core).toContain("if (e.key === 'Escape') setOpen(false)");
    expect(core).toContain('if (!wrap.contains(e.target)) setOpen(false)');
    expect(core).toContain("window.addEventListener('hashchange'");
    // initTopbar 里接的线
    expect(core).toContain('initUserMenu();');
    for (const page of ['public/app.js', 'public/admin.js']) {
      const src = read(page);
      // 登出语义一个字不改：两段确认 + 5 秒还原 + oidc 隐藏表单 POST / shared fetch 双路径
      expect(src, page).toContain("btn.classList.contains('danger')");
      expect(src, page).toContain("'再点一次确认登出'");
      expect(src, page).toContain('setTimeout(resetLogout, 5000)');
      expect(src, page).toContain('oidcLogout()');
      expect(src, page).toContain("api('/logout'");
      // 菜单头随登录态写入用户名
      expect(src, page).toContain("getElementById('user-menu-head')");
    }
  });

  it('TC-MENU-G4 菜单样式在场：右锚浮层与登出确认态红', () => {
    const css = read('public/style.css');
    expect(css).toMatch(/\.topbar \.user-menu-wrap \{[^}]*position: relative/);
    expect(css).toMatch(/\.topbar \.user-menu \{[^}]*right: 0/);
    expect(css).toMatch(/\.topbar \.user-menu \{[^}]*z-index: 50/);
    expect(css).toContain('.topbar .user-menu-head');
    expect(css).toContain('.topbar .user-menu-sep');
    expect(css).toMatch(/\.topbar \.user-menu button\.danger \{[^}]*background: var\(--bad\)/);
  });

  // 页脚版本号无构建步骤可代劳，core.js 与 package.json 是手工双写（VERSIONS.md「落地位置」）
  it('TC-MENU-G5 APP_VERSION 与 package.json 版本双写一致', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(read('public/core.js')).toContain(`export const APP_VERSION = '${pkg.version}'`);
  });
});
