/*
 * CLAUDE.md 画面(計画 15 Phase E2)の純粋ロジック(web/src/claudemd.ts)。
 * 7 段の並べ替えと「なし」の扱い、@import の印の位置、循環の扱い、合計の出し方を確かめる。
 */

import { describe, expect, it } from 'vitest';
import type { ClaudeMdFile, ClaudeMdImport, ClaudeMdScan } from '../src/shared/types';
import type { ImportTree } from '../web/src/claudemd';
import {
  LAYER_ORDER,
  allFiles,
  defaultFile,
  displayPath,
  homeOf,
  importLine,
  importRefsOfLine,
  importStats,
  importTok,
  importTrees,
  latestUpdated,
  layerRows,
  lazyTokens,
  nestedState,
  outlineOf,
  presentKinds,
  splitImports,
} from '../web/src/claudemd';
import { setLang } from '../web/src/i18n';

const file = (path: string, over: Partial<ClaudeMdFile> = {}): ClaudeMdFile => ({
  path,
  ownTokens: 100,
  tokens: 100,
  updatedAt: '2026-09-01T00:00:00.000Z',
  headings: [],
  imports: [],
  ...over,
});

const imp = (ref: string, over: Partial<ClaudeMdImport> = {}): ClaudeMdImport => ({
  ref,
  path: '/x/' + ref,
  exists: true,
  depth: 1,
  tokens: 50,
  ...over,
});

const empty: ClaudeMdScan = {
  layers: LAYER_ORDER.map((kind) => ({ kind, label: '/l/' + kind, files: [], tokens: 0 })),
  tokens: 0,
};

function withFiles(parts: Partial<Record<(typeof LAYER_ORDER)[number], ClaudeMdFile[]>>) {
  const layers = empty.layers.map((l) => {
    const files = parts[l.kind] ?? [];
    const tokens = files.filter((f) => !f.lazy).reduce((n, f) => n + f.tokens, 0);
    return { ...l, files, tokens };
  });
  return { layers, tokens: layers.reduce((n, l) => n + l.tokens, 0) };
}

describe('layerRows / defaultFile — 7 段と既定の段', () => {
  it('全段なしでも 7 行が注入順に残る', () => {
    const rows = layerRows(empty);
    expect(rows.map((r) => r.kind)).toEqual(LAYER_ORDER);
    expect(rows.every((r) => r.files.length === 0)).toBe(true);
    expect(defaultFile(empty)).toBeNull();
    expect(presentKinds(empty)).toEqual([]);
  });

  it('サーバーが段を省いても(root 無し)空の段で補う', () => {
    const scan: ClaudeMdScan = { layers: [empty.layers[0], empty.layers[1]], tokens: 0 };
    const rows = layerRows(scan);
    expect(rows).toHaveLength(7);
    expect(rows[2]).toEqual({ kind: 'project', label: '', files: [], tokens: 0 });
  });

  it('既定は読まれる順で最初に存在する段(管理ポリシーが無ければ user より project が後)', () => {
    const scan = withFiles({
      project: [file('/p/CLAUDE.md')],
      user: [file('/h/.claude/CLAUDE.md')],
    });
    expect(defaultFile(scan)?.path).toBe('/h/.claude/CLAUDE.md');
    expect(presentKinds(scan)).toEqual(['user', 'project']);
    expect(allFiles(scan).map((f) => f.path)).toEqual(['/h/.claude/CLAUDE.md', '/p/CLAUDE.md']);
  });

  it('管理ポリシー(本文を返さない段)があればそれが既定になる', () => {
    const scan = withFiles({
      managed: [file('/Library/CLAUDE.md', { bodyWithheld: true })],
      user: [file('/h/.claude/CLAUDE.md')],
    });
    expect(defaultFile(scan)?.bodyWithheld).toBe(true);
  });
});

describe('合計の出し方 — lazy は段の tokens に入らず別に数える', () => {
  it('lazyTokens は paths: 付き rules の分だけ、latestUpdated は最も新しい mtime', () => {
    const scan = withFiles({
      user: [file('/h/.claude/CLAUDE.md', { updatedAt: '2026-09-02T00:00:00.000Z' })],
      rules: [
        file('/p/.claude/rules/always.md', { tokens: 30 }),
        file('/p/.claude/rules/lazy.md', { tokens: 70, lazy: true }),
      ],
    });
    expect(scan.tokens).toBe(130);
    expect(lazyTokens(scan)).toBe(70);
    expect(latestUpdated(scan)).toBe(Date.parse('2026-09-02T00:00:00.000Z'));
    expect(latestUpdated(empty)).toBe(0);
  });
});

describe('importStats — 展開 / 見つからない / 打ち切り', () => {
  it('種類ごとに数え、展開した分だけ tok を足す', () => {
    const scan = withFiles({
      user: [
        file('/h/.claude/CLAUDE.md', {
          imports: [
            imp('rules/common.md', { tokens: 330 }),
            imp('../CLAUDE.md', { depth: 2, tokens: 0, skipped: 'cycle' }),
            imp('missing.md', { exists: false, tokens: 0 }),
            imp('deep.md', { depth: 5, tokens: 0, skipped: 'depth' }),
          ],
        }),
      ],
    });
    const st = importStats(scan);
    expect(st).toMatchObject({ expanded: 1, missing: 1, skipped: 2, tokens: 330 });
    expect(st.first?.ref).toBe('rules/common.md');
    expect(importStats(empty)).toEqual({ expanded: 0, missing: 0, skipped: 0, tokens: 0 });
  });
});

describe('importRefsOfLine / importTrees', () => {
  it('行頭か空白の後の @ だけを拾い、末尾の句読点を落とす', () => {
    expect(importRefsOfLine('@README')).toEqual(['README']);
    expect(importRefsOfLine('see @docs/a.md, and @~/b.md.')).toEqual(['docs/a.md', '~/b.md']);
    expect(importRefsOfLine('mail me@example.com')).toEqual([]);
    expect(importRefsOfLine('@')).toEqual([]);
  });

  it('深さ優先の並びを「直接 import + その配下」に組み直す', () => {
    const trees = importTrees([
      imp('a.md'),
      imp('a/b.md', { depth: 2 }),
      imp('a/b/c.md', { depth: 3 }),
      imp('d.md'),
    ]);
    expect(trees.map((t) => [t.root.ref, t.nested.map((n) => n.ref)])).toEqual([
      ['a.md', ['a/b.md', 'a/b/c.md']],
      ['d.md', []],
    ]);
  });
});

describe('splitImports — 本文中の展開位置', () => {
  it('@import だけの行は印に置き換え、文中の @ は行を残して直後に印を出す', () => {
    const body = [
      '# 方針',
      '本文',
      '@rules/common.md',
      '',
      '## 次',
      '参照 @docs/x.md を見る',
      'end',
    ].join('\n');
    const segs = splitImports(body, [imp('rules/common.md'), imp('docs/x.md')]);
    expect(segs).toEqual([
      { type: 'md', text: '# 方針\n本文' },
      {
        type: 'import',
        ref: 'rules/common.md',
        tree: { root: imp('rules/common.md'), nested: [] },
      },
      { type: 'md', text: '\n## 次\n参照 @docs/x.md を見る' },
      { type: 'import', ref: 'docs/x.md', tree: { root: imp('docs/x.md'), nested: [] } },
      { type: 'md', text: 'end' },
    ]);
  });

  it('コードフェンス内の @ は印にしない', () => {
    const body = ['```', '@not/import', '```', '@real.md'].join('\n');
    const segs = splitImports(body, [imp('real.md')]);
    expect(segs.map((s) => s.type)).toEqual(['md', 'import']);
    expect(segs[0]).toEqual({ type: 'md', text: '```\n@not/import\n```' });
  });

  it('循環で打ち切った配下は直接 import の tree に付いて残る', () => {
    const imports = [imp('a.md'), imp('CLAUDE.md', { depth: 2, tokens: 0, skipped: 'cycle' })];
    const segs = splitImports('@a.md', imports);
    expect(segs).toHaveLength(1);
    const s = segs[0];
    expect(s.type === 'import' && s.tree?.nested[0].skipped).toBe('cycle');
  });

  it('サーバーの import より本文の @ が多ければ tree 無しの印になる(落とさない)', () => {
    const segs = splitImports('@a.md\n@b.md', [imp('a.md')]);
    expect(segs).toHaveLength(2);
    expect(segs[1]).toEqual({ type: 'import', ref: 'b.md', tree: undefined });
  });
});

describe('outlineOf — 見出しと @import を出現順に', () => {
  const f = file('/h/.claude/CLAUDE.md', {
    headings: [
      { text: '基本方針', tokens: 210 },
      { text: '作業の進め方', tokens: 236 },
      { text: '禁止事項', tokens: 200 },
    ],
    imports: [imp('~/.claude/rules/common.md', { tokens: 330 })],
  });
  const body = [
    '# 基本方針',
    'x',
    '## 作業の進め方',
    '- y',
    '@~/.claude/rules/common.md',
    '## 禁止事項',
    'z',
  ].join('\n');

  it('本文があれば見出しの間に @import を差し込み、tok はサーバーの headings から取る', () => {
    const rows = outlineOf(f, body);
    expect(
      rows.map((r) => (r.type === 'heading' ? `${r.level}:${r.text}:${r.tokens}` : '@' + r.ref)),
    ).toEqual([
      '1:基本方針:210',
      '2:作業の進め方:236',
      '@~/.claude/rules/common.md',
      '2:禁止事項:200',
    ]);
  });

  it('本文が無ければ(未取得・管理ポリシー)見出しだけを並べ、@import は末尾', () => {
    const rows = outlineOf(f, null);
    expect(rows.map((r) => r.type)).toEqual(['heading', 'heading', 'heading', 'import']);
  });

  it('コードフェンス内の @ は数えないが、フェンス内の # 行はサーバーと同じく見出しに数える', () => {
    const g = file('/p/CLAUDE.md', {
      headings: [
        { text: 'a', tokens: 1 },
        { text: 'in fence', tokens: 2 },
      ],
      imports: [imp('x.md')],
    });
    const b = ['# a', '```', '# in fence', '@no.md', '```', '@x.md'].join('\n');
    const rows = outlineOf(g, b);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({ type: 'heading', text: 'in fence', tokens: 2 });
    expect(rows[2]).toMatchObject({ type: 'import', ref: 'x.md' });
  });
});

describe('homeOf / displayPath', () => {
  it('user 段の label からホームを逆算し、cwd は ./、ホームは ~/ に縮める', () => {
    const scan = withFiles({});
    scan.layers[1].label = '/Users/me/.claude/CLAUDE.md';
    const home = homeOf(scan);
    expect(home).toBe('/Users/me');
    expect(displayPath('/Users/me/work/p/CLAUDE.md', '/Users/me/work/p', home)).toBe('./CLAUDE.md');
    expect(displayPath('/Users/me/work/p/.claude/rules/x.md', '/Users/me/work/p/', home)).toBe(
      './.claude/rules/x.md',
    );
    expect(displayPath('/Users/me/.claude/CLAUDE.md', '/Users/me/work/p', home)).toBe(
      '~/.claude/CLAUDE.md',
    );
    expect(
      displayPath('/Library/Application Support/ClaudeCode/CLAUDE.md', '/Users/me/work/p', home),
    ).toBe('/Library/Application Support/ClaudeCode/CLAUDE.md');
    expect(displayPath('', '/x', home)).toBe('');
    expect(homeOf(empty)).toBe('');
  });
});

/*
 * @import 1 件の見え方。サーバーが返す skipped は 5 種あり、以前は cycle / depth しか分岐が無く、
 * 残り 3 種が既定の「ここで展開(0 tok)」に落ちていた ── 読まなかったものを「読んだ」と
 * 表示するので、修正前より誤解が強い(レビュー 2 周目の指摘)。全種を固定する。
 */
describe('importLine / nestedState / importTok — skipped の全種', () => {
  const cases: [NonNullable<ClaudeMdImport['skipped']>, string, string][] = [
    ['cycle', 'cycle', 'cycle'],
    ['duplicate', 'expanded above', 'counted once'],
    ['depth', 'beyond 4 levels', 'beyond 4 levels'],
    ['too-large', 'too large', 'too large'],
    ['out-of-scope', 'outside the project', 'out of scope'],
  ];

  it.each(cases)('%s は展開扱いにせず専用の文言を出す', (skipped, direct, nested) => {
    setLang('en');
    // 境界の外はサーバーが解決そのものをしないので exists: false で返る。その形で通す
    const im = imp('x.md', { skipped, tokens: 0, exists: skipped !== 'out-of-scope' });
    expect(importLine(im)).toContain(direct);
    expect(importLine(im)).not.toContain('expanded here');
    expect(nestedState(im)).toContain(nested);
    expect(nestedState(im)).not.toBe('0 tok');
    // 読まなかったものに tok は出さない
    expect(importTok(im)).toBe('—');
  });

  it('展開できたものは tok を出す', () => {
    setLang('en');
    const im = imp('ok.md', { tokens: 120 });
    expect(importLine(im)).toContain('expanded here');
    expect(importTok(im)).toBe('120');
    expect(nestedState(im)).toBe('120 tok');
  });

  it('見つからないものは「無い」と出す(打ち切りとは言い分ける)', () => {
    setLang('en');
    const im = imp('gone.md', { exists: false, tokens: 0 });
    expect(importLine(im)).toContain('not found');
    expect(importTok(im)).toBe('—');
  });

  /*
   * 境界の外は exists: false + skipped で返る。判定の順を間違えると「見つからない」に化け、
   * out-of-scope の文言が 1 度も表示されない(レビュー 3 周目の指摘)。
   */
  it('境界の外は「無い」ではなく「境界の外」と出す', () => {
    setLang('en');
    const im = imp('/etc/hosts', { exists: false, skipped: 'out-of-scope', tokens: 0 });
    expect(importLine(im)).toContain('outside the project');
    expect(importLine(im)).not.toContain('not found');
    expect(nestedState(im)).toContain('out of scope');
  });

  it('importStats は境界の外を missing ではなく skipped に数える', () => {
    const scan = withFiles({
      project: [
        file('/p/CLAUDE.md', {
          imports: [
            imp('/etc/hosts', { exists: false, skipped: 'out-of-scope', tokens: 0 }),
            imp('gone.md', { exists: false, tokens: 0 }),
            imp('ok.md', { tokens: 40 }),
          ],
        }),
      ],
    });
    expect(importStats(scan)).toMatchObject({ expanded: 1, missing: 1, skipped: 1, tokens: 40 });
  });

  it('両言語に文言がある(片方だけだとキーがそのまま出る)', () => {
    for (const lang of ['en', 'ja'] as const) {
      setLang(lang);
      for (const [skipped] of cases) {
        const s = importLine(imp('x.md', { skipped, tokens: 0 }));
        expect(s).not.toContain('cmd.');
      }
    }
    setLang('en');
  });
});

/*
 * 本文の印とサーバーの展開結果は出現順の index で突き合わせる。片側だけが 1 件多く拾うと
 * 以降が全部ずれ、実在する @import の行に別のファイルの状態と tok が付く
 * (サーバーだけ `~~~` を知っていた頃に実際に起きた。レビュー 3 周目の指摘)。
 */
describe('splitImports — 本文の印とサーバーの結果の対応', () => {
  const marks = (body: string, imports: ClaudeMdImport[]) =>
    splitImports(body, imports)
      .filter((s): s is { type: 'import'; ref: string; tree?: ImportTree } => s.type === 'import')
      .map((s) => [s.ref, s.tree?.root.ref ?? null]);

  it('~~~ フェンスの中の @ を印にしない(サーバーも拾わない)', () => {
    const body = '~~~\n@in-fence.md\n~~~\n@real.md';
    expect(marks(body, [imp('real.md', { tokens: 7 })])).toEqual([['real.md', 'real.md']]);
  });

  it('``` の閉じ行に書かれた @ も印にしない', () => {
    const body = '```\ncode\n``` @sneaky.md\n@real.md';
    expect(marks(body, [imp('real.md', { tokens: 7 })])).toEqual([['real.md', 'real.md']]);
  });

  it('コードスパンの中は印にしない', () => {
    const body = 'mention `@README` here\n@real.md';
    expect(marks(body, [imp('real.md', { tokens: 7 })])).toEqual([['real.md', 'real.md']]);
  });

  it('複数の参照は出現順で対応する', () => {
    const body = '@a.md\ntext @b.md text\n@c.md';
    expect(marks(body, [imp('a.md'), imp('b.md'), imp('c.md')])).toEqual([
      ['a.md', 'a.md'],
      ['b.md', 'b.md'],
      ['c.md', 'c.md'],
    ]);
  });
});
