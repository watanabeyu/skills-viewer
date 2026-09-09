import { describe, expect, it } from 'vitest';
import type { MemorySection, MemoryTriage, Section, SkillItem } from '../src/shared/types';
import {
  STALE_SIGNALS,
  asTypeFilter,
  costOf,
  freshnessOf,
  indexMatchOf,
  indexRatio,
  memoryRows,
  sectionsFor,
  triageMeta,
  typeMatches,
  verdictWord,
} from '../web/src/memory';

const item = (name: string, extra: Partial<SkillItem> = {}): SkillItem => ({
  name,
  description: name + ' desc',
  argumentHint: '',
  version: '',
  kind: 'memory',
  path: '/m/' + name + '.md',
  files: [],
  ...extra,
});
const tri = (extra: Partial<MemoryTriage>): MemoryTriage => ({
  verdict: 'keep',
  reason: '',
  issues: [],
  instruction: '',
  ...extra,
});
const section = (items: SkillItem[], extra: Partial<MemorySection> = {}): MemorySection => ({
  id: 'p',
  projectPath: '/repo',
  projectName: 'repo',
  note: '/home/.claude/projects/p/memory',
  usageAvailable: true,
  indexTokens: items.reduce((n, it) => n + (it.indexBeyondLimit ? 0 : it.indexTokens || 0), 0),
  items,
  ...extra,
});

describe('verdictWord (診断列の 4 語)', () => {
  it('未診断は null(一覧は —)', () => {
    expect(verdictWord(undefined)).toBeNull();
  });
  it('keep = 残す、shrink / update = 縮める、delete = 削除', () => {
    expect(verdictWord(tri({ verdict: 'keep' }))).toBe('keep');
    expect(verdictWord(tri({ verdict: 'shrink' }))).toBe('shrink');
    expect(verdictWord(tri({ verdict: 'update' }))).toBe('shrink');
    expect(verdictWord(tri({ verdict: 'delete' }))).toBe('delete');
  });
  it('移動系は移動先(CLAUDE.md / user CLAUDE.md / docs / skill / 別プロジェクト)を問わず「移動」', () => {
    for (const v of [
      'to-claude-md',
      'to-user-claude-md',
      'to-docs',
      'to-skill',
      'wrong-project',
    ] as const) {
      expect(verdictWord(tri({ verdict: v }))).toBe('move');
    }
  });
  it('出力不正は行き先を持たないので error(再診断を促す)', () => {
    expect(verdictWord(tri({ verdict: 'keep', error: 'invalid-output' }))).toBe('error');
  });
  it('格下げ済み(demoted)は表示上の verdict(keep)に従う', () => {
    expect(verdictWord(tri({ verdict: 'keep', demoted: 'wrong-project' }))).toBe('keep');
  });
});

describe('freshnessOf (鮮度: AI の判定 → 無ければ機械シグナル)', () => {
  it('棚卸し済みなら state をそのまま(basis = ai)', () => {
    expect(freshnessOf(item('a', { aiTriage: tri({ state: 'historical' }) }))).toEqual({
      state: 'historical',
      basis: 'ai',
    });
  });
  it('出力不正の state は信用せず機械判定に落とす', () => {
    const it = item('a', {
      aiTriage: tri({ state: 'obsolete', error: 'invalid-output' }),
      signals: [{ kind: 'path-missing', value: '/x' }],
    });
    expect(freshnessOf(it)).toEqual({ state: 'outdated', basis: 'machine' });
  });
  it('未診断: 古さのシグナル(パス不在・完了語・ブランチ)があれば outdated、無ければ current', () => {
    expect(freshnessOf(item('a'))).toEqual({ state: 'current', basis: 'machine' });
    for (const kind of STALE_SIGNALS) {
      expect(freshnessOf(item('a', { signals: [{ kind, value: 'x' }] })).state).toBe('outdated');
    }
  });
  it('日付があるだけ・feedback の構造シグナルは古さの根拠にしない', () => {
    const it = item('a', {
      signals: [
        { kind: 'date', value: '2026-07-01', days: 60 },
        { kind: 'how-restates', value: '40' },
        { kind: 'other-project', value: '/other' },
      ],
    });
    expect(freshnessOf(it).state).toBe('current');
  });
  it('診断時シグナル(branch-*)も機械判定に含める', () => {
    const it = item('a', {
      aiTriage: tri({ verdict: 'keep', signals: [{ kind: 'branch-merged', value: 'feat/x' }] }),
    });
    // state 無し(旧形式のキャッシュ)なので機械判定へ
    expect(freshnessOf(it)).toEqual({ state: 'outdated', basis: 'machine' });
  });
});

describe('indexMatchOf (索引行と本文の一致)', () => {
  it('索引行が無ければ none、上限外なら beyond', () => {
    expect(indexMatchOf(item('a'))).toBe('none');
    expect(indexMatchOf(item('a', { indexLine: '- a', indexBeyondLimit: true }))).toBe('beyond');
  });
  it('未診断・出力不正は unknown、AI の答えで match / mismatch', () => {
    expect(indexMatchOf(item('a', { indexLine: '- a' }))).toBe('unknown');
    expect(
      indexMatchOf(item('a', { indexLine: '- a', aiTriage: tri({ error: 'invalid-output' }) })),
    ).toBe('unknown');
    expect(
      indexMatchOf(item('a', { indexLine: '- a', aiTriage: tri({ indexMatchesBody: true }) })),
    ).toBe('match');
    expect(
      indexMatchOf(item('a', { indexLine: '- a', aiTriage: tri({ indexMatchesBody: false }) })),
    ).toBe('mismatch');
  });
});

describe('memoryRows / typeMatches (一覧の絞り込み)', () => {
  const a = item('alpha', { memoryType: 'feedback', indexTokens: 10, useCount: 2 });
  const b = item('beta', { memoryType: 'project', indexTokens: 30 });
  const c = item('gamma', { indexTokens: 20, useCount: 1 });
  const sec = section([a, b, c]);
  const base = { q: '', sort: 'index' as const, ref: 'all' as const, type: 'all' as const };

  it('既定は索引 tok が多い順', () => {
    expect(memoryRows(sec, base).map((x) => x.name)).toEqual(['beta', 'gamma', 'alpha']);
  });
  it('種類で絞る(type 未指定の件は all 以外に出ない)', () => {
    expect(memoryRows(sec, { ...base, type: 'feedback' }).map((x) => x.name)).toEqual(['alpha']);
    expect(memoryRows(sec, { ...base, type: 'reference' })).toEqual([]);
    expect(typeMatches(c, 'all')).toBe(true);
    expect(typeMatches(c, 'project')).toBe(false);
  });
  it('検索・参照フィルタ(旧クエリ)も同時に効く', () => {
    expect(memoryRows(sec, { ...base, q: 'gam' }).map((x) => x.name)).toEqual(['gamma']);
    expect(memoryRows(sec, { ...base, ref: 'unread' }).map((x) => x.name)).toEqual(['beta']);
  });
  it('asTypeFilter は未知の値を all に落とす', () => {
    expect(asTypeFilter('feedback')).toBe('feedback');
    expect(asTypeFilter('bogus')).toBe('all');
    expect(asTypeFilter(null)).toBe('all');
  });
});

describe('sectionsFor (ヘッダーの切替に従うセクション)', () => {
  const cur = section([item('a')], { id: 'cur', projectPath: '/repo', isCurrent: true });
  const other = section([item('b')], { id: 'oth', projectPath: '/other', projectName: 'other' });
  const orphan = section([item('c')], { id: 'orp', projectPath: null, orphan: true });
  const autoDir = section([item('d')], {
    id: 'auto-x',
    projectPath: null,
    isCurrent: true,
    autoDir: true,
  });
  const memory = [cur, other, orphan, autoDir];
  const proj = (note: string, isCurrent?: boolean): Section => ({
    id: 'p',
    source: 'project',
    note,
    items: [],
    ...(isCurrent ? { isCurrent } : {}),
  });

  it('all は全部(プロジェクト不明・共有ストアもここでだけ見える)', () => {
    expect(sectionsFor(memory, 'all').map((s) => s.id)).toEqual(['cur', 'oth', 'orp', 'auto-x']);
  });
  it('cwd のプロジェクトは isCurrent(実パス一致 + autoMemoryDirectory の置き場)', () => {
    expect(sectionsFor(memory, proj('/repo', true)).map((s) => s.id)).toEqual(['cur', 'auto-x']);
    expect(sectionsFor(memory, null).map((s) => s.id)).toEqual(['cur', 'auto-x']);
  });
  it('他プロジェクトは実パスで結び付ける(プロジェクト不明は出ない)', () => {
    expect(sectionsFor(memory, proj('/other')).map((s) => s.id)).toEqual(['oth']);
    expect(sectionsFor(memory, proj('/nowhere'))).toEqual([]);
  });
});

describe('costOf / indexRatio (上部のコスト)', () => {
  it('索引は上限内の合計、行数は件数、本文は合計', () => {
    const sec = section(
      [
        item('a', { indexTokens: 100, bodyTokens: 500 }),
        item('b', { indexTokens: 50, bodyTokens: 300, indexBeyondLimit: true }),
      ],
      { indexBeyondCount: 1 },
    );
    expect(costOf(sec)).toEqual({ indexTok: 100, lines: 2, beyond: 1, bodyTok: 800 });
  });
  it('比は 行数 / 上限。上限 0 は 0', () => {
    expect(indexRatio(3, 200)).toBeCloseTo(0.015);
    expect(indexRatio(250, 200)).toBeGreaterThan(1);
    expect(indexRatio(3, 0)).toBe(0);
  });
});

describe('triageMeta (診断の見出しの「いつ・どのモデルが」)', () => {
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  it('日付とモデルを「·」で繋ぐ。片方だけでも出す', () => {
    expect(triageMeta(tri({ generatedAt: '2026-09-06T01:00:00Z', model: 'haiku' }), fmt)).toBe(
      '2026-09-06 · haiku',
    );
    expect(triageMeta(tri({ model: 'opus' }), fmt)).toBe('opus');
    expect(triageMeta(tri({ generatedAt: 'not a date' }), fmt)).toBe('');
  });
  it('未診断・旧形式(記録なし)は空', () => {
    expect(triageMeta(undefined, fmt)).toBe('');
    expect(triageMeta(tri({}), fmt)).toBe('');
  });
});
