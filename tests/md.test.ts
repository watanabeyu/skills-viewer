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
    expect(html).toMatch(/<blockquote>\s*<p>quote<\/p>\s*<\/blockquote>/);
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

  /*
   * ---- markdown-it への置き換え(2026-09-11)で守ること ----
   * 表示専用のレンダラなので、読み込む側(clone したリポジトリの CLAUDE.md)に有利なものは切る
   */
  it('本文の生 HTML はタグごとエスケープされる(html: false)', () => {
    const html = mdRender('before\n\n<div onclick="x()">raw</div>\n\nafter');
    expect(html).not.toContain('<div');
    expect(html).toContain('&lt;div');
  });

  it('画像は描画しない(外部画像 = 表示しただけで外へ出る通信)', () => {
    const html = mdRender('![pixel](https://evil.example/p.gif)');
    expect(html).not.toContain('<img');
    expect(html).toContain('![pixel](https://evil.example/p.gif)');
  });

  it('http(s) 以外のリンクは <a> にしない(相対パスは SPA のルータが拾う。javascript: は言うまでもない)', () => {
    expect(mdRender('[readme](apps/e2e/README.md)')).not.toContain('<a');
    expect(mdRender('[readme](apps/e2e/README.md)')).toContain('readme');
    // javascript: は markdown-it 自身が href として拒み、字面のまま出す(タグにならない)
    expect(mdRender('[x](javascript:alert(1))')).not.toContain('<a');
    expect(mdRender('[x](javascript:alert(1))')).not.toContain('href');
  });

  it('裸の URL は https:// で始まるものだけリンクにする(README.md の .md を TLD と見なさない)', () => {
    expect(mdRender('see apps/e2e/README.md and example.com')).not.toContain('<a');
    expect(mdRender('see https://x.com/a now')).toContain(
      '<a href="https://x.com/a" target="_blank" rel="noopener">https://x.com/a</a>',
    );
  });

  it('5 段目以降の見出し・入れ子 2 段のリスト・表・強調を描画する(CLAUDE.md で実際に使われる)', () => {
    expect(mdRender('##### five\n\n###### six')).toMatch(/<h5>five<\/h5>[\s\S]*<h6>six<\/h6>/);
    const list = mdRender('- a\n  - b\n    - c\n- d');
    expect((list.match(/<ul>/g) || []).length).toBe(3);
    const table = mdRender('| k | v |\n|---|---|\n| a | 1 |');
    expect(table).toContain('<table>');
    expect(table).toContain('<th>k</th>');
    expect(table).toContain('<td>1</td>');
    expect(mdRender('*em* and **strong**')).toContain('<em>em</em>');
    expect(mdRender('*em* and **strong**')).toContain('<strong>strong</strong>');
  });

  it('~~~ のフェンスも ``` と同じくコードとしてエスケープする', () => {
    const html = mdRender('~~~\n<b>x</b>\n~~~');
    expect(html).toContain('<pre><code>');
    expect(html).toContain('&lt;b&gt;');
  });

  it('memory の [[x]] 退避文字(私用領域 \\uE000)はそのまま通る', () => {
    expect(mdRender('see \uE0003\uE000 here')).toContain('\uE0003\uE000');
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

  it('レンダラと同じく 6 段目まで拾う', () => {
    expect(mdHeadings('##### five\n###### six')).toEqual([
      { level: 5, text: 'five' },
      { level: 6, text: 'six' },
    ]);
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
