import { describe, expect, it } from 'vitest';
import { mdRender, splitFrontmatter } from '../web/src/md';

describe('mdRender (SKILL.md レンダラ)', () => {
  it('見出し・段落・インラインコードを描画する', () => {
    const html = mdRender('# Title\n\n本文で `code` を使う。');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<code>code</code>');
  });

  it('コードフェンス内は HTML エスケープされる', () => {
    const html = mdRender('```\n<script>alert(1)</script>\n```');
    expect(html).toContain('<pre><code>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('リスト(ネスト1段)を描画する', () => {
    const html = mdRender('- a\n- b\n  - b1\n- c');
    expect(html).toContain('<ul>');
    expect((html.match(/<li>/g) || []).length).toBe(4);
  });

  it('番号リスト・引用・水平線を描画する', () => {
    const html = mdRender('1. one\n2. two\n\n> quote\n\n---');
    expect(html).toContain('<ol>');
    expect(html).toContain('<blockquote>quote</blockquote>');
    expect(html).toContain('<hr>');
  });

  it('地の文の HTML はエスケープされる(XSS 防止)', () => {
    const html = mdRender('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
  });
});

describe('splitFrontmatter', () => {
  it('frontmatter と本文を分離する', () => {
    const { frontmatter, body } = splitFrontmatter('---\nname: x\n---\n# body');
    expect(frontmatter).toBe('name: x');
    expect(body).toBe('# body');
  });

  it('frontmatter が無ければ null', () => {
    expect(splitFrontmatter('# only body').frontmatter).toBeNull();
  });
});
