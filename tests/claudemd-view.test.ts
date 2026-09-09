/*
 * CLAUDE.md 画面(計画 15 Phase E2)の純粋ロジック(web/src/claudemd.ts)。
 * 7 段の並べ替えと「なし」の扱い、@import の印の位置、循環の扱い、合計の出し方を確かめる。
 */

import { describe, expect, it } from 'vitest';
import type { ClaudeMdFile, ClaudeMdImport, ClaudeMdScan } from '../src/shared/types';
import {
  LAYER_ORDER,
  allFiles,
  defaultFile,
  displayPath,
  homeOf,
  importRefsOfLine,
  importStats,
  importTrees,
  latestUpdated,
  layerRows,
  lazyTokens,
  outlineOf,
  presentKinds,
  splitImports,
} from '../web/src/claudemd';

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
