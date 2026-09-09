import { describe, expect, it } from 'vitest';
import { mdHeadings, mdRender, splitFrontmatter, splitPreview } from '../web/src/md';

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

  it('[text](url) はリンクになる(memory のプレースホルダ除外で正常系を壊していない)', () => {
    expect(mdRender('see [a](https://x.com) now')).toContain(
      '<a href="https://x.com" target="_blank" rel="noopener">a</a>',
    );
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

describe('mdHeadings (フロー図未生成時の見出しツリー)', () => {
  it('見出しを順に取り、コードフェンス内の # は数えない', () => {
    const src = '# T\n\n## 手順\n\n```\n# not a heading\n```\n\n### 1. 読む\ntext\n## 参考';
    expect(mdHeadings(src)).toEqual([
      { level: 1, text: 'T' },
      { level: 2, text: '手順' },
      { level: 3, text: '1. 読む' },
      { level: 2, text: '参考' },
    ]);
  });

  it('インラインの装飾と末尾の # を剥がす', () => {
    expect(mdHeadings('## `gw` で **worktree** を作る ##')).toEqual([
      { level: 2, text: 'gw で worktree を作る' },
    ]);
  });

  it('見出しが無ければ空', () => {
    expect(mdHeadings('plain text\n\nmore')).toEqual([]);
  });
});

describe('splitPreview (全文の畳み)', () => {
  const lines = (n: number, prefix = 'l') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

  it('minLines 以降の最初の空行で切り、残り行数を返す', () => {
    const body = [...lines(5), '', ...lines(10, 'a'), '', ...lines(10, 'b')].join('\n');
    const r = splitPreview(body, 12, 8);
    expect(r.head.split('\n')).toHaveLength(16);
    expect(r.restLines).toBe(11);
    expect(r.rest.startsWith('\nb0')).toBe(true);
  });

  it('短い本文・残りが短い本文は畳まない', () => {
    const short = [...lines(3), '', ...lines(2)].join('\n');
    expect(splitPreview(short)).toEqual({ head: short, rest: '', restLines: 0 });
    const tail = [...lines(14), '', ...lines(3)].join('\n');
    expect(splitPreview(tail, 12, 8).rest).toBe('');
  });

  it('コードフェンスの中の空行では切らない', () => {
    const body = [
      ...lines(10),
      '```',
      ...lines(5, 'c'),
      '',
      ...lines(5, 'd'),
      '```',
      '',
      ...lines(10, 'e'),
    ].join('\n');
    const r = splitPreview(body, 12, 8);
    // フェンスを閉じた後の空行(index 23)で切れる
    expect(r.head.split('\n')).toHaveLength(23);
    expect(r.head.endsWith('```')).toBe(true);
  });
});
