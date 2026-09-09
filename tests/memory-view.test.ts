import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MemorySection,
  MemoryTriage,
  Section,
  SelectedProject,
  SkillItem,
  SkillsData,
} from '../src/shared/types';
/*
 * runTriage の結線だけを見るので、API クライアントは triageMemory だけ差し替える
 * (実際の fetch は起こさない)。他の export は util.ts などが実体を使うので残す。
 */
vi.mock('../web/src/api', async (orig) => ({
  ...(await orig<typeof import('../web/src/api')>()),
  triageMemory: vi.fn(),
}));
import { triageMemory } from '../web/src/api';
import { runTriage } from '../web/src/components/MemoryBits';
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

/*
 * 一覧に出す置き場は「サーバーが計算した対象(SkillsData.selected)」に帰属するもの(計画 16 Phase A)。
 * サーバーは選んだプロジェクトを起点に置き場を解決するので、MemorySection.isCurrent は
 * 「cwd」ではなく「選んだプロジェクト(+ 本体)」の印になった。cwd 特別扱い(project.isCurrent &&
 * m.isCurrent)に戻すと、cwd 以外を選んだ環境で一覧だけが空になる ── ここで機械的に止める。
 */
describe('sectionsFor (選んだプロジェクトに帰属するセクション)', () => {
  const cur = section([item('a')], { id: 'cur', projectPath: '/repo', isCurrent: true });
  const other = section([item('b')], { id: 'oth', projectPath: '/other', projectName: 'other' });
  const orphan = section([item('c')], { id: 'orp', projectPath: null, orphan: true });
  /* user scope の autoMemoryDirectory: どのプロジェクトの memory か決まらないので projectPath なし */
  const shared = section([item('d')], {
    id: 'auto-x',
    projectPath: null,
    isCurrent: true,
    autoDir: true,
    sharedStore: true,
  });
  const memory = [cur, other, orphan, shared];
  const proj = (note: string, isCurrent?: boolean): Section => ({
    id: 'p',
    source: 'project',
    note,
    items: [],
    ...(isCurrent ? { isCurrent } : {}),
  });
  /* サーバーの応答。selected 以外は sectionsFor が見ないので最小限で作る */
  const dataOf = (path: string, extra: Partial<SelectedProject> = {}): SkillsData =>
    ({
      memory,
      selected: { id: 'p', path, name: path.slice(1), isCwd: path === '/repo', ...extra },
    }) as unknown as SkillsData;

  it('all は全部(プロジェクト不明・共有ストアもここでだけ見える)', () => {
    expect(sectionsFor(dataOf('/repo'), 'all').map((s) => s.id)).toEqual([
      'cur',
      'oth',
      'orp',
      'auto-x',
    ]);
  });

  it('選んだプロジェクトの置き場 +(逆引きできない)共有ストアが出る', () => {
    expect(sectionsFor(dataOf('/repo'), proj('/repo', true)).map((s) => s.id)).toEqual([
      'cur',
      'auto-x',
    ]);
    // Section が無い(定義 0 件の)プロジェクトでも selected 基準なので同じ
    expect(sectionsFor(dataOf('/repo'), null).map((s) => s.id)).toEqual(['cur', 'auto-x']);
  });

  it('cwd 以外を選んでも空にならない(共有ストアがある環境でも他プロジェクトの置き場が出る)', () => {
    expect(sectionsFor(dataOf('/other'), proj('/other')).map((s) => s.id)).toEqual([
      'oth',
      'auto-x',
    ]);
  });

  it('worktree を選ぶと本体(mainPath)の置き場が出る(memory は本体に収束する)', () => {
    const d = dataOf('/repo-wt', { mainPath: '/repo' });
    expect(sectionsFor(d, proj('/repo-wt')).map((s) => s.id)).toEqual(['cur', 'auto-x']);
  });

  it('他プロジェクトの置き場と、逆引きできない孤児(選択の印なし)は出ない', () => {
    expect(sectionsFor(dataOf('/nowhere'), proj('/nowhere')).map((s) => s.id)).toEqual(['auto-x']);
    expect(sectionsFor(dataOf('/repo'), proj('/repo', true)).map((s) => s.id)).not.toContain('oth');
    expect(sectionsFor(dataOf('/repo'), proj('/repo', true)).map((s) => s.id)).not.toContain('orp');
  });

  it('判定の基準は Section ではなく selected(取り直し中に param が先に変わっても応答に従う)', () => {
    // 切替の途中で渡ってくる Section が古くても、出すのはサーバーが計算した対象の置き場
    expect(sectionsFor(dataOf('/other'), proj('/repo', true)).map((s) => s.id)).toEqual([
      'oth',
      'auto-x',
    ]);
  });
});

/*
 * 棚卸しの結線(計画 16)。triageMemory(project, selected, …)は引数が両方 string なので、
 * 取り違えても型では落ちない。呼び出しの順そのものをここで固定する
 * (selected を落とすと、選んだプロジェクトの置き場が not-found になって棚卸しだけ失敗する)。
 */
describe('runTriage (棚卸しの呼び出し: 置き場の id と走査の起点)', () => {
  const sec = section([item('a'), item('b')], { id: '-w-repo' });
  beforeEach(() => vi.mocked(triageMemory).mockClear());

  it('1 件(詳細)はファイル名の配列で呼び、診断済みなら force', () => {
    runTriage(sec, 'proj--w-repo', item('a', { aiTriage: tri({ verdict: 'keep' }) }));
    expect(triageMemory).toHaveBeenCalledWith('-w-repo', 'proj--w-repo', ['a.md'], true);
  });

  it('一括(一覧)は files 無しで呼び、全件診断済みなら force', () => {
    runTriage(sec, 'proj--w-repo');
    expect(triageMemory).toHaveBeenCalledWith('-w-repo', 'proj--w-repo', undefined, false);
    const done = section([item('a', { aiTriage: tri({}) })], { id: '-w-repo' });
    runTriage(done, 'proj--w-repo');
    expect(triageMemory).toHaveBeenLastCalledWith('-w-repo', 'proj--w-repo', undefined, true);
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
