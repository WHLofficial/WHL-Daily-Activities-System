import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// v1.1.2 字体方案：三族走平台共享源 https://fonts.whleague.win/v1/（Inter 拉丁正文 + Noto Serif SC
// union 鸣谢弹窗 + JetBrains Mono 绑定码，四站同一份、跨站共享缓存分区），本地 public/fonts/ 五件
// 保留作回滚垫。本仓是纯静态 HTML + 原生 JS，没有构建与 jsdom，沿用 topbar-menu.test.ts 的静态锁思路：
// 文本扫描 style.css 与两页 HTML，卡住手工回归最易犯的错——src/preload 没指向共享源或版本不一致、
// preload 忘写 crossorigin、衬线漏写 600 / font-synthesis-weight（会合成假粗）、宋体被误 preload。
// 断言只扫本地文本，不访问 fonts.whleague.win（域名未建立前本地不可解析是预期）。
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(root + p, 'utf8');
const pages = ['public/index.html', 'public/admin.html'];

describe('v1.1.2 字体方案静态锁（TC-FONT-G1…G5）', () => {
  it('TC-FONT-G1 三族五个 @font-face 全部 swap 且指向共享源 /v1/', () => {
    const css = read('public/style.css');
    const faces = css.match(/@font-face \{[^}]*\}/g) ?? [];
    expect(faces).toHaveLength(5);
    for (const face of faces) {
      expect(face).toContain('font-display: swap');
      expect(face).toMatch(/url\('https:\/\/fonts\.whleague\.win\/v1\/[a-z0-9-]+\.woff2'\)/);
      expect(face).not.toContain('local(');
    }
    // 拉丁字体带 unicode-range（latin-ext 懒加载的前提），宋体子集不带（缺字逐字回退系统宋体）
    expect(faces.filter((f) => f.includes('unicode-range'))).toHaveLength(4);
    expect(css).toContain("font-family: 'Noto Serif SC'");
    expect(css).toContain("font-family: 'Inter'");
    expect(css).toContain("font-family: 'JetBrains Mono'");
  });

  it('TC-FONT-G2 body 走 --font-sans 且不再写死系统栈', () => {
    const css = read('public/style.css');
    expect(css).toMatch(/--font-sans:\s*'Inter',/);
    expect(css).toMatch(/--font-display:\s*'Noto Serif SC',/);
    expect(css).toMatch(/--font-mono:\s*'JetBrains Mono',/);
    const body = css.match(/body \{[^}]*\}/)?.[0] ?? '';
    expect(body).toContain('font-family: var(--font-sans)');
    expect(body).not.toContain('system-ui');
  });

  it('TC-FONT-G3 衬线只给鸣谢弹窗且 600 + 禁合成；等宽只给绑定码与 kbd', () => {
    const css = read('public/style.css');
    const serifRules = css.match(/^\.credit-(?:title|quote)\s*\{[^}]*\}/gm) ?? [];
    expect(serifRules).toHaveLength(2);
    for (const rule of serifRules) {
      expect(rule).toContain('font-family: var(--font-display)');
      expect(rule).toContain('font-weight: 600');
      expect(rule).toContain('font-synthesis-weight: none');
    }
    // 子集只有 600：任何衬线规则写 700/800 都会触发假粗
    expect(css).not.toMatch(/font-family: var\(--font-display\)[^}]*font-weight: (700|800)/);
    expect(css).toMatch(/\.bigcode \{[^}]*font-family: var\(--font-mono\)/);
    expect(css).toMatch(/code\.kbd \{[^}]*font-family: var\(--font-mono\)/);
    // 正文里不该出现第三种字体（h3 仍是黑体：本站没有 22px 以上的页面标题）
    expect(css).not.toMatch(/\.card h3 \{[^}]*font-family/);
  });

  it('TC-FONT-G4 两页只预载共享源 Inter latin（crossorigin），不预载宋体与本地路径', () => {
    for (const path of pages) {
      const html = read(path);
      expect(html, path).toContain(
        '<link rel="preload" href="https://fonts.whleague.win/v1/inter-latin.woff2" as="font" type="font/woff2" crossorigin>',
      );
      expect(html, path).not.toContain('noto-serif-sc-600-union.woff2" as="font"');
      // 回滚垫语义：两页不得引用本地 /fonts/（防止与共享源混用两套版本）
      expect(html, path).not.toContain('href="/fonts/');
    }
  });

  it('TC-FONT-G5 五条 src 与两页 preload 全部命中共享源且版本一致（TC-8）', () => {
    // 设计稿 §8/§10：体积锁随 union 重跑即失效，改锁「URL 全命中共享源 + 版本一致」；
    // 集合逐字比对（衬线是 union 单文件，文件名与本地 subset 不同）。
    const expected = [
      'https://fonts.whleague.win/v1/noto-serif-sc-600-union.woff2',
      'https://fonts.whleague.win/v1/inter-latin.woff2',
      'https://fonts.whleague.win/v1/inter-latin-ext.woff2',
      'https://fonts.whleague.win/v1/jbmono-latin.woff2',
      'https://fonts.whleague.win/v1/jbmono-latin-ext.woff2',
    ];
    const css = read('public/style.css');
    const srcs = [...css.matchAll(/src: url\('([^']+)'\)/g)].map((m) => m[1]);
    expect(srcs).toEqual(expected);
    // 版本锚注释（升级时全局替换的抓手）必须在场
    expect(css).toContain('字体版本：v1（升级时全局替换 fonts.whleague.win/v1/）');
    for (const path of pages) {
      expect(read(path), path).toContain('href="https://fonts.whleague.win/v1/inter-latin.woff2"');
    }
  });
});
