import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyIndexMismatch,
  attachMemoryTriage,
  buildPrompt,
  candidatesFor,
  chunkByChars,
  collectTriageContext,
  extractJsonArray,
  normalizeInstruction,
  orphanTriage,
  parseBodyPlan,
  parseTriage,
  promptPath,
  selectStale,
  targetMemDirOf,
  triageHash,
  type TriageStore,
  headingLines,
} from '../src/server/memory-triage';
import { contentHash } from '../src/server/summary';
import { encodeProjectPath } from '../src/server/usage';
import { instructionsOf, triageEstimate } from '../web/src/util';
import type {
  MemorySection,
  MemorySignal,
  MemoryTriage,
  MemoryVerdict,
  Section,
  SkillItem,
} from '../src/shared/types';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-triage-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/* テスト用の memory item(実ファイルつき。hash 判定に実体が要る) */
function memItem(file: string, body: string, extra: Partial<SkillItem> = {}): SkillItem {
  const fp = path.join(tmp, file);
  fs.writeFileSync(fp, body);
  return {
    name: file.replace(/\.md$/, ''),
    description: '',
    argumentHint: '',
    version: '',
    kind: 'memory',
    path: fp,
    files: [],
    ...extra,
  };
}

describe('parseTriage', () => {
  const files = ['a.md', 'b.md'];

  it('正常な JSON 配列を file をキーにしたマップに変換する', () => {
    const m = parseTriage(
      JSON.stringify([
        {
          file: 'a.md',
          verdict: 'to-docs',
          state: 'current',
          reason: '完了済みの設計文書',
          issues: ['58日更新なし'],
          instruction: 'docs/ へ移し MEMORY.md の索引行を消す',
        },
      ]),
      files,
    );
    expect(m.size).toBe(1);
    expect(m.get('a.md')).toEqual({
      verdict: 'to-docs',
      state: 'current',
      reason: '完了済みの設計文書',
      issues: ['58日更新なし'],
      instruction: '- docs/ へ移し MEMORY.md の索引行を消す',
    });
  });

  it('コードフェンス付きでも読める', () => {
    const m = parseTriage(
      '```json\n[{"file":"a.md","state":"current","verdict":"keep","reason":"r","issues":[],"instruction":""}]\n```',
      files,
    );
    expect(m.get('a.md')?.verdict).toBe('keep');
  });

  it('不正な verdict の要素は行き先を出さず「出力不正」として記録する', () => {
    const m = parseTriage(
      JSON.stringify([
        {
          file: 'a.md',
          verdict: 'archive',
          state: 'current',
          reason: 'r',
          issues: [],
          instruction: 'x',
        },
        {
          file: 'b.md',
          verdict: 'delete',
          state: 'current',
          reason: 'r',
          issues: [],
          instruction: 'x',
        },
      ]),
      files,
    );
    // 診断済みとして残す(捨てると差分診断のたびに再 call される)が、行き先と指示文は出さない
    expect(m.get('a.md')).toEqual({
      verdict: 'keep',
      reason: '',
      issues: [],
      instruction: '',
      error: 'invalid-output',
    });
    expect(m.get('b.md')?.verdict).toBe('delete');
  });

  it('state が 4 値以外・欠落の要素も「出力不正」として記録する(鮮度なしの行き先は出さない)', () => {
    const m = parseTriage(
      JSON.stringify([
        { file: 'a.md', state: 'fresh', verdict: 'keep', reason: 'r', issues: [], instruction: '' },
        { file: 'b.md', verdict: 'keep', reason: 'r', issues: [], instruction: '' },
      ]),
      files,
    );
    expect(m.get('a.md')?.error).toBe('invalid-output');
    expect(m.get('b.md')?.error).toBe('invalid-output');
  });

  it('update を通す(8 値目)。instruction は必須で、索引 ±0 なので試算は出ない', () => {
    const m = parseTriage(
      JSON.stringify([
        {
          file: 'a.md',
          state: 'outdated',
          verdict: 'update',
          reason: '参照パスが移動している',
          issues: ['参照パスが存在しない: src/old.ts'],
          instruction: 'src/old.ts の記述を src/new.ts に直す',
        },
        {
          file: 'b.md',
          state: 'outdated',
          verdict: 'update',
          reason: 'r',
          issues: [],
          instruction: '',
        },
      ]),
      files,
    );
    expect(m.get('a.md')?.verdict).toBe('update');
    expect(m.get('a.md')?.state).toBe('outdated');
    expect(m.get('b.md')?.error).toBe('invalid-output');
  });

  it('file の欠落・対象外は捨てる(記録もしない)', () => {
    const m = parseTriage(
      JSON.stringify([
        { verdict: 'delete', reason: 'r', issues: [], instruction: 'x' },
        {
          file: 'other.md',
          verdict: 'delete',
          state: 'current',
          reason: 'r',
          issues: [],
          instruction: 'x',
        },
        {
          file: 'a.md',
          verdict: 'shrink',
          state: 'current',
          reason: 'r',
          issues: [],
          instruction: 'x',
        },
      ]),
      files,
    );
    expect([...m.keys()]).toEqual(['a.md']);
  });

  it('keep の instruction は空に正規化し、issues は文字列4件まで。長すぎる文字列は切り詰める', () => {
    const m = parseTriage(
      JSON.stringify([
        {
          file: 'a.md',
          verdict: 'keep',
          state: 'current',
          reason: 'あ'.repeat(500),
          issues: ['い'.repeat(200), '2', '3', '4', '5', 42],
          instruction: '消してよい',
        },
        {
          file: 'b.md',
          verdict: 'delete',
          state: 'current',
          reason: 'r',
          issues: [],
          instruction: 'う'.repeat(2000),
        },
      ]),
      files,
    );
    expect(m.get('a.md')?.instruction).toBe('');
    expect(m.get('a.md')?.issues).toEqual(['い'.repeat(80), '2', '3', '4']);
    expect(m.get('a.md')!.issues[0].length).toBe(80);
    expect(m.get('a.md')!.reason.length).toBe(400);
    // instruction の上限は keep 以外(keep は空に正規化されるため)で効く
    expect(m.get('b.md')!.instruction.length).toBe(1200);
  });

  it('to-skill を通す(7 値目)', () => {
    const m = parseTriage(
      JSON.stringify([
        {
          file: 'a.md',
          verdict: 'to-skill',
          state: 'current',
          reason: 'pr-create の挙動への好み',
          issues: [],
          instruction: '- pr-create の SKILL.md に 1 行足す',
        },
      ]),
      files,
    );
    expect(m.get('a.md')?.verdict).toBe('to-skill');
  });

  it('instruction の体裁を「- 」箇条書きに正規化する(番号付き・散文)', () => {
    const m = parseTriage(
      JSON.stringify([
        {
          file: 'a.md',
          verdict: 'delete',
          state: 'current',
          reason: 'r',
          issues: [],
          instruction: '1. a\n2. b',
        },
        {
          file: 'b.md',
          verdict: 'delete',
          state: 'current',
          reason: 'r',
          issues: [],
          instruction: '散文',
        },
      ]),
      files,
    );
    expect(m.get('a.md')?.instruction).toBe('- a\n- b');
    expect(m.get('b.md')?.instruction).toBe('- 散文');
  });

  it('normalizeInstruction: 記号・番号・空行・インデントを剥がして「- 」に揃える', () => {
    expect(normalizeInstruction('- a\n- b')).toBe('- a\n- b'); // 冪等
    expect(normalizeInstruction('1) a\n2) b')).toBe('- a\n- b');
    expect(normalizeInstruction('・a\n•b')).toBe('- a\n- b');
    expect(normalizeInstruction('a\n\nb')).toBe('- a\n- b'); // 空行は落ちて 2 行になる
    expect(normalizeInstruction('  - a\n    - b')).toBe('- a\n- b');
    expect(normalizeInstruction('-\n*\n1.\n- a')).toBe('- a'); // 記号だけの行は空行扱い
  });

  it('normalizeInstruction: 区切り空白の無い数値・符号は内容として残す', () => {
    expect(normalizeInstruction('-40 tok 減る')).toBe('- -40 tok 減る');
    expect(normalizeInstruction('1.5 倍になる')).toBe('- 1.5 倍になる');
    expect(normalizeInstruction('2026.08 に完了')).toBe('- 2026.08 に完了');
  });

  it('keep 以外で指示文が空(または記号だけ)の要素は「出力不正」として記録する', () => {
    const m = parseTriage(
      JSON.stringify([
        {
          file: 'a.md',
          verdict: 'delete',
          state: 'current',
          reason: 'r',
          issues: [],
          instruction: '  \n- ',
        },
        {
          file: 'b.md',
          verdict: 'keep',
          state: 'current',
          reason: 'r',
          issues: [],
          instruction: '',
        },
      ]),
      files,
    );
    expect(m.get('a.md')?.error).toBe('invalid-output'); // 貼るものが無い提案は出さない
    expect(m.get('a.md')?.instruction).toBe('');
    expect(m.get('b.md')?.verdict).toBe('keep'); // keep は元から instruction 空が正常
    expect(m.get('b.md')?.error).toBeUndefined();
  });

  it('同じ file が重複したら先勝ち', () => {
    const m = parseTriage(
      JSON.stringify([
        {
          file: 'a.md',
          verdict: 'delete',
          state: 'current',
          reason: 'first',
          issues: [],
          instruction: 'x',
        },
        {
          file: 'a.md',
          verdict: 'keep',
          state: 'current',
          reason: 'second',
          issues: [],
          instruction: '',
        },
      ]),
      files,
    );
    expect(m.get('a.md')?.reason).toBe('first');
  });

  it('前置き・後書き付きの出力からも JSON 配列を取り出す(弱いモデルの揺れ)', () => {
    const text =
      'メモリ 2 件を棚卸しました:\n[{"file":"a.md","state":"current","verdict":"keep","reason":"r","issues":[],"instruction":""}]\n以上です。';
    expect(parseTriage(text, ['a.md']).get('a.md')?.verdict).toBe('keep');
    expect(() => extractJsonArray('配列が無い')).toThrow();
  });

  it('配列でない出力・壊れた出力は例外', () => {
    expect(() => parseTriage('{"file":"a.md"}', files)).toThrow();
    expect(() => parseTriage('not json', files)).toThrow();
  });
});

describe('parseBodyPlan (feedback の残す / 削る分類の検証)', () => {
  const body =
    'ルール\n\n**Why:** ユーザーが feat/695 で指摘。\n\n**How to apply:** 直接作業する。ただし hotfix は除く。';

  it('enum と抜粋の検証を通った分類だけ返す', () => {
    expect(
      parseBodyPlan(
        {
          why: 'generalize',
          why_rewrite: 'レビュー対応は同じ PR の続きなので別ブランチに分けると対応が切れる',
          how: 'keep-lines-only',
          keep_lines: ['ただし hotfix は除く。', '本文に無い文'],
          index: 'rewrite',
          index_rewrite: 'レビュー対応は push まで進めて PR 作成の前で止まる',
        },
        body,
      ),
    ).toEqual({
      why: 'generalize',
      whyRewrite: 'レビュー対応は同じ PR の続きなので別ブランチに分けると対応が切れる',
      how: 'keep-lines-only',
      keepLines: ['ただし hotfix は除く。'],
      index: 'rewrite',
      indexRewrite: 'レビュー対応は push まで進めて PR 作成の前で止まる',
    });
  });

  it('index 省略は keep、旧名 exceptions も keep_lines として読む。rewrite なのに新 description が無い・固有名詞入りは null', () => {
    expect(
      parseBodyPlan(
        { why: 'keep', how: 'keep-lines-only', exceptions: ['ただし hotfix は除く。'] },
        body,
      ),
    ).toEqual({
      why: 'keep',
      how: 'keep-lines-only',
      keepLines: ['ただし hotfix は除く。'],
      index: 'keep',
    });
    expect(
      parseBodyPlan({ why: 'keep', how: 'drop', index: 'rewrite', index_rewrite: '' }, body),
    ).toBeNull();
    expect(
      parseBodyPlan(
        { why: 'keep', how: 'drop', index: 'rewrite', index_rewrite: '#865 の件' },
        body,
      ),
    ).toBeNull();
  });

  it('enum 以外・例外だけ残すのに抜粋が無い・一般化できていない why_rewrite は null(散文にフォールバック)', () => {
    expect(parseBodyPlan({ why: 'maybe', how: 'drop', exceptions: [] }, body)).toBeNull();
    expect(
      parseBodyPlan({ why: 'keep', how: 'keep-lines-only', keep_lines: ['捏造'] }, body),
    ).toBeNull();
    expect(
      parseBodyPlan(
        { why: 'generalize', why_rewrite: 'feat/695 の件', how: 'drop', exceptions: [] },
        body,
      ),
    ).toBeNull();
    expect(parseBodyPlan({ why: 'generalize', why_rewrite: '', how: 'drop' }, body)).toBeNull();
    expect(parseBodyPlan(null, body)).toBeNull();
  });

  it('parseTriage は shrink / update かつ本文が渡された要素にだけ body を付ける', () => {
    const files = ['a.md', 'b.md'];
    const el = (file: string, verdict: string) => ({
      file,
      state: 'outdated',
      verdict,
      reason: 'r',
      issues: [],
      instruction: 'x',
      body: { why: 'drop', how: 'drop', keep_lines: [] },
    });
    const m = parseTriage(
      JSON.stringify([el('a.md', 'update'), el('b.md', 'to-docs')]),
      files,
      new Map([['a.md', body]]),
    );
    expect(m.get('a.md')?.body).toEqual({ why: 'drop', how: 'drop', keepLines: [], index: 'keep' });
    expect(m.get('b.md')?.body).toBeUndefined();
    // 本文を渡さなければ付けない(旧呼び出し互換)
    expect(
      parseTriage(JSON.stringify([el('a.md', 'update')]), files).get('a.md')?.body,
    ).toBeUndefined();
  });
});

describe('index_matches_body → applyIndexMismatch(索引と本文の食い違いを機械で反映)', () => {
  const it0 = memItem('im-a.md', 'aaa', { description: 'コミット段階で止める' });
  const base = (over: Partial<MemoryTriage> = {}): MemoryTriage => ({
    verdict: 'keep',
    state: 'current',
    reason: '',
    issues: [],
    instruction: '',
    ...over,
  });

  it('parseTriage は index_matches_body を boolean のときだけ拾う', () => {
    const m = parseTriage(
      JSON.stringify([
        {
          file: 'a.md',
          state: 'current',
          verdict: 'keep',
          index_matches_body: false,
          reason: '',
          issues: [],
          instruction: '',
        },
        {
          file: 'b.md',
          state: 'current',
          verdict: 'keep',
          index_matches_body: 'no',
          reason: '',
          issues: [],
          instruction: '',
        },
      ]),
      ['a.md', 'b.md'],
    );
    expect(m.get('a.md')?.indexMatchesBody).toBe(false);
    expect(m.get('b.md')?.indexMatchesBody).toBeUndefined();
  });

  it('false なら verdict が keep でも index-mismatch シグナルが付く(行き先は変えない)', () => {
    const r = applyIndexMismatch(base({ indexMatchesBody: false }), it0);
    expect(r.verdict).toBe('keep');
    expect(r.signals).toEqual([{ kind: 'index-mismatch', value: 'コミット段階で止める' }]);
    // 既存の git シグナルは残り、二重には付かない
    const r2 = applyIndexMismatch(
      base({ indexMatchesBody: false, signals: [{ kind: 'branch-merged', value: 'feat/x' }] }),
      it0,
    );
    expect(r2.signals?.map((s) => s.kind)).toEqual(['branch-merged', 'index-mismatch']);
    expect(applyIndexMismatch(r2, it0).signals).toHaveLength(2);
  });

  it('feedback の分類が index = keep のままなら align に差し替える(rewrite はそのまま)', () => {
    const plan = {
      why: 'keep' as const,
      how: 'drop' as const,
      keepLines: [],
      index: 'keep' as const,
    };
    expect(applyIndexMismatch(base({ indexMatchesBody: false, body: plan }), it0).body?.index).toBe(
      'align',
    );
    expect(
      applyIndexMismatch(
        base({ indexMatchesBody: false, body: { ...plan, index: 'rewrite', indexRewrite: '新' } }),
        it0,
      ).body?.index,
    ).toBe('rewrite');
  });

  it('true / 欠落 / 出力不正なら何もしない', () => {
    expect(applyIndexMismatch(base({ indexMatchesBody: true }), it0).signals).toBeUndefined();
    expect(applyIndexMismatch(base(), it0).signals).toBeUndefined();
    expect(
      applyIndexMismatch(base({ indexMatchesBody: false, error: 'invalid-output' }), it0).signals,
    ).toBeUndefined();
  });
});

describe('triageHash (本文 + 索引行)', () => {
  it('索引行が無ければ contentHash と同じ。索引行が変わると hash も変わる', () => {
    const it1 = memItem('h-a.md', 'aaa');
    expect(triageHash(it1)).toBe(contentHash(it1.path));
    const withIndex = { ...it1, indexLine: '- [a](h-a.md) — 旧' };
    const h1 = triageHash(withIndex);
    expect(h1).not.toBe(contentHash(it1.path));
    expect(triageHash({ ...it1, indexLine: '- [a](h-a.md) — 新' })).not.toBe(h1);
    // 索引行だけ直した memory は再診断の対象になる
    const store: TriageStore = {
      [it1.path]: {
        verdict: 'keep',
        state: 'current',
        reason: '',
        issues: [],
        instruction: '',
        hash: h1,
        lang: 'ja',
        generatedAt: '',
      },
    };
    expect(
      selectStale([{ ...it1, indexLine: '- [a](h-a.md) — 新' }], store, 'ja', false),
    ).toHaveLength(1);
    expect(selectStale([withIndex], store, 'ja', false)).toHaveLength(0);
  });
});

describe('selectStale (差分 call の対象選定)', () => {
  const entry = (over: Partial<TriageStore[string]> = {}): TriageStore[string] => ({
    verdict: 'keep',
    state: 'current',
    reason: '',
    issues: [],
    instruction: '',
    hash: null,
    lang: 'ja',
    generatedAt: '',
    ...over,
  });

  it('hash 一致はスキップ / 不一致・未キャッシュ・lang 不一致は対象', () => {
    const a = memItem('s-a.md', 'aaa');
    const b = memItem('s-b.md', 'bbb');
    const c = memItem('s-c.md', 'ccc');
    const d = memItem('s-d.md', 'ddd');
    // hash は実ファイルから計算されるので、まず 1 回診断済みの状態を作る
    const store: TriageStore = {
      [a.path]: entry({ hash: contentHash(a.path) }),
      [b.path]: entry({ hash: 'stale-hash' }),
      [d.path]: entry({ hash: contentHash(d.path), lang: 'en' }),
    };
    const stale = selectStale([a, b, c, d], store, 'ja', false);
    expect(stale.map((it) => it.path)).toEqual([b.path, c.path, d.path]);
  });

  it('state を持たない旧形式のエントリは hash が一致しても対象(出力不正のエントリは除く)', () => {
    const a = memItem('s-old.md', 'aaa');
    const b = memItem('s-err.md', 'bbb');
    const store: TriageStore = {
      [a.path]: entry({ hash: contentHash(a.path), state: undefined }),
      [b.path]: entry({ hash: contentHash(b.path), state: undefined, error: 'invalid-output' }),
    };
    expect(selectStale([a, b], store, 'ja', false).map((it) => it.path)).toEqual([a.path]);
  });

  it('force なら全件が対象', () => {
    const a = memItem('f-a.md', 'aaa');
    const store: TriageStore = { [a.path]: entry({ hash: contentHash(a.path) }) };
    expect(selectStale([a], store, 'ja', true)).toHaveLength(1);
  });
});

describe('triageEstimate (削減試算の式)', () => {
  const item = (verdict: MemoryVerdict | null): SkillItem => ({
    name: 'x',
    description: '',
    argumentHint: '',
    version: '',
    kind: 'memory',
    path: '/x/x.md',
    files: [],
    indexTokens: 20,
    bodyTokens: 600,
    ...(verdict ? { aiTriage: { verdict, reason: '', issues: [], instruction: '' } } : {}),
  });

  it('delete / to-docs / wrong-project は索引分だけ減る', () => {
    for (const v of ['delete', 'to-docs', 'wrong-project'] as MemoryVerdict[]) {
      expect(triageEstimate(item(v))).toEqual({ index: -20, always: 0 });
    }
  });

  it('to-skill は to-docs と同じ(索引分だけ減り常時注入は増えない)', () => {
    expect(triageEstimate(item('to-skill'))).toEqual({ index: -20, always: 0 });
  });

  it('to-claude-md は索引が減る代わりに本文が常時注入になる', () => {
    expect(triageEstimate(item('to-claude-md'))).toEqual({ index: -20, always: 600 });
  });

  it('keep / shrink / 未診断は数値を出さない', () => {
    expect(triageEstimate(item('keep'))).toBeNull();
    expect(triageEstimate(item('shrink'))).toBeNull();
    expect(triageEstimate(item(null))).toBeNull();
  });

  it('出力不正(verdict keep + error)は試算にも提案にも数えない', () => {
    const broken = item('keep');
    broken.aiTriage = { ...broken.aiTriage!, error: 'invalid-output' };
    expect(triageEstimate(broken)).toBeNull();
    expect(instructionsOf([broken])).toEqual([]);
  });
});

describe('chunkByChars (プロンプト合計サイズでの分割)', () => {
  const size = (n: number) => n;

  it('累積が上限以下の間は同じチャンクにまとめる', () => {
    expect(chunkByChars([3, 3, 3], size, 10)).toEqual([[3, 3, 3]]);
  });

  it('上限を超える手前で切る(境界ちょうどは同じチャンク)', () => {
    expect(chunkByChars([4, 3, 3, 1], size, 10)).toEqual([[4, 3, 3], [1]]);
  });

  it('1 件で上限を超えるものは単独チャンクにする(落とさない)', () => {
    expect(chunkByChars([2, 99, 2], size, 10)).toEqual([[2], [99], [2]]);
  });

  it('空配列はチャンクを作らない', () => {
    expect(chunkByChars([], size, 10)).toEqual([]);
  });
});

describe('buildPrompt (一括診断のプロンプト)', () => {
  const index =
    '- [引き継ぎ](handoff.md) — ブランチと base を明記\n- [wiki](wiki.md) — curl で書く';
  const targets = [
    memItem('p-handoff.md', '---\nname: handoff\n---\n引き継ぎの本文'),
    memItem('p-wiki.md', '---\nname: wiki\n---\nwiki の本文'),
  ];
  const ctx = { projectName: 'alpha', index, usageAvailable: true };

  it('プロジェクトのパスと「別プロジェクトの配下パス → wrong-project」の指示を ja / en とも載せる', () => {
    const withPath = { ...ctx, projectPath: '/w/alpha' };
    expect(buildPrompt(targets, withPath, 'ja')).toContain('(パス: /w/alpha)');
    expect(buildPrompt(targets, withPath, 'en')).toContain('(path: /w/alpha)');
    expect(buildPrompt(targets, ctx, 'ja')).not.toContain('(パス:'); // プロジェクト不明はパス無し
  });

  it('索引の全文と対象全件のファイル名をプロンプトに載せる', () => {
    const prompt = buildPrompt(targets, ctx, 'ja');
    expect(prompt).toContain(index);
    // ファイル名は各ブロックの見出し(## file:)にも出るため、制約行の列挙そのものを見る
    expect(prompt).toContain(targets.map((x) => path.basename(x.path)).join(', '));
    expect(prompt).toContain('引き継ぎの本文'); // 本文も渡す
  });

  it('ja / en とも索引行の削除に触れ、state の 4 値と verdict の 8 値を出力スキーマで縛る', () => {
    const schema =
      '"keep" | "shrink" | "to-claude-md" | "to-docs" | "delete" | "wrong-project" | "to-skill" | "update"';
    const stateSchema = '"current" | "outdated" | "historical" | "obsolete"';
    for (const lang of ['ja', 'en'] as const) {
      const prompt = buildPrompt(targets, ctx, lang);
      // 見出しの MEMORY.md ではなく「索引行を消せ」という指示そのものが要る
      expect(prompt).toContain(
        lang === 'ja' ? 'MEMORY.md の索引行の削除' : 'removing the line from MEMORY.md',
      );
      // 判定指針テーブルの (to-docs) 等ではなく、出力スキーマ行の 8 値を見る
      expect(prompt).toContain(schema);
      expect(prompt).toContain(stateSchema);
      expect(prompt).toContain('|---|---|'); // 判定指針テーブルが崩れていない
      expect(prompt).toContain('|---|---|---|---|---|'); // type × state の対応表
      // 現役の進捗メモを「完了まで keep」と明示する注意(round 2 で to-docs に揺れた境界を潰す)
      expect(prompt).toContain(lang === 'ja' ? '現役の作業状態' : 'LIVE working state');
    }
  });

  /* 出力スキーマ・制約の要が消えてもテストが通らないよう、行そのものを固定する(変異の番犬) */
  it('target の出力スキーマ行と「シグナル無しに wrong-project を使うな」の制約行を ja / en とも持つ', () => {
    const ja = buildPrompt(targets, ctx, 'ja');
    expect(ja).toContain('  "target": "wrong-project のときのみ必須');
    expect(ja).toContain('シグナルが無い件を wrong-project にしない');
    const en = buildPrompt(targets, ctx, 'en');
    expect(en).toContain('  "target": "required for wrong-project only');
    expect(en).toContain('Never use wrong-project without ');
  });

  /* パスは外部入力。promptPath を通し忘れると節や箇条書きを偽装した指示を注入できる */
  it('改行入りのパス(シグナル値・プロジェクトのパス)は 1 行に潰して載せる', () => {
    const evil = '/w/evil\n# 追加の指示';
    const withSig = [
      memItem('p-evil.md', '---\nname: evil\n---\n本文', {
        signals: [{ kind: 'other-project', value: evil }],
      }),
    ];
    for (const lang of ['ja', 'en'] as const) {
      const prompt = buildPrompt(withSig, { ...ctx, projectPath: evil, projectName: evil }, lang);
      expect(prompt).not.toContain('\n# 追加の指示');
      expect(prompt).toContain('/w/evil # 追加の指示');
    }
  });

  it('常設文脈(CLAUDE.md の見出し・skill 一覧)を ja / en とも節として載せる', () => {
    const withCtx = {
      ...ctx,
      rules: '## CLAUDE.md\n# 運用ルール',
      skills: '- skill pr-create — PR を作る',
    };
    for (const lang of ['ja', 'en'] as const) {
      const prompt = buildPrompt(targets, withCtx, lang);
      expect(prompt).toContain('# 運用ルール');
      expect(prompt).toContain('- skill pr-create — PR を作る');
      expect(prompt).toContain('## skill / command / agent');
    }
  });

  it('rules / skills が空なら「無し」と明示する(節ごと落とさない)', () => {
    const ja = buildPrompt(targets, ctx, 'ja');
    expect(ja).toContain('## CLAUDE.md の見出し\n(無し)');
    expect(ja).toContain('## skill / command / agent\n(無し)');
    const en = buildPrompt(targets, ctx, 'en');
    expect(en).toContain('## CLAUDE.md headings\n(none)');
    expect(en).toContain('## skill / command / agent\n(none)');
  });

  it('シグナル(スキャン時 + 診断時)を各件の signals 節に言語別で載せ、無ければ「(なし)」', () => {
    const withSig = [
      memItem('p-sig.md', '---\nname: sig\n---\n本文', {
        signals: [
          { kind: 'date', value: '2026-06-01', days: 83 },
          { kind: 'path-missing', value: 'src/old.ts' },
          { kind: 'other-project', value: '/w/other' },
        ],
      }),
      targets[0],
    ];
    const extra = (it: SkillItem) =>
      it.path.endsWith('p-sig.md')
        ? [...(it.signals || []), { kind: 'branch-merged' as const, value: 'feat/x' }]
        : [];
    const ja = buildPrompt(withSig, ctx, 'ja', extra);
    expect(ja).toContain('- 本文の最新日付 2026-06-01(83 日前)');
    expect(ja).toContain('- 参照パスが存在しない: src/old.ts');
    expect(ja).toContain('- ブランチ feat/x はマージ済み');
    // other-project の値はフルパスのままプロンプトに載る(Phase B のゲート条件の前提)
    expect(ja).toContain('- 本文が別の登録プロジェクト「/w/other」配下のパスを指している');
    expect(ja).toContain('signals(機械が拾った鮮度の事実):\n(なし)');
    const en = buildPrompt(withSig, ctx, 'en', extra);
    expect(en).toContain('- latest date in body: 2026-06-01 (83 days ago)');
    expect(en).toContain('- branch feat/x is already merged');
    expect(en).toContain('- the body points at a path under another registered project "/w/other"');
    expect(en).toContain('signals (freshness facts collected mechanically):\n(none)');
  });

  it('usageAvailable が false なら計測不能と書き、参照回数は出さない', () => {
    const ja = buildPrompt(targets, { ...ctx, usageAvailable: false }, 'ja');
    expect(ja).toContain('計測不能');
    expect(ja).not.toContain('Read: 0');
    const en = buildPrompt(targets, { ...ctx, usageAvailable: false }, 'en');
    expect(en).toContain('not measurable');
    expect(en).not.toContain('Read: 0');
  });

  /*
   * プロジェクト不明(orphan。projectPath === null)のときだけ verdict 制限とスラッグ説明を載せる(判断 5)。
   * projectPath が単に未指定(既存の ctx のように)のときは対象外(実際の呼び出しは常に null を渡す)。
   */
  it('projectPath が null のときだけ verdict 制限とスラッグの説明を ja / en とも載せる', () => {
    const orphanCtx = { ...ctx, projectPath: null };
    const ja = buildPrompt(targets, orphanCtx, 'ja');
    expect(ja).toContain('verdict は keep / shrink / update のみを使うこと');
    expect(ja).toContain('~/.claude/projects/<スラッグ>/memory/');
    expect(ja).toContain('非英数字は "-" に置き換わっている');
    const en = buildPrompt(targets, orphanCtx, 'en');
    expect(en).toContain('verdict must be one of keep / shrink / update only');
    expect(en).toContain('~/.claude/projects/<slug>/memory/');

    // projectPath 無指定(undefined)は orphan 扱いしない = 制限文言は載らない
    expect(buildPrompt(targets, ctx, 'ja')).not.toContain('verdict は keep / shrink / update のみ');
    expect(buildPrompt(targets, ctx, 'en')).not.toContain(
      'verdict must be one of keep / shrink / update only',
    );
  });

  /*
   * 制限と矛盾する節を同じプロンプトに載せない(判断 5)。候補一覧・「持ち主は上のプロジェクト」・
   * 常設文脈(重複・昇格先の材料)はいずれも置き場所の判定を促すので、orphan では出さない
   */
  it('orphan では候補ブロック・持ち主の断定・常設文脈を出さず、候補なしの 1 行に差し替える', () => {
    const orphanCtx = {
      ...ctx,
      projectPath: null,
      rules: '## CLAUDE.md\n# 運用ルール',
      skills: '- skill pr-create — PR を作る',
    };
    // 候補を返す candidatesOf を渡しても、候補一覧そのものが出ないことを見る
    const cands = () => ['/w/other'];
    const ja = buildPrompt(targets, orphanCtx, 'ja', undefined, cands);
    expect(ja).not.toContain('この memory の持ち主は');
    expect(ja).not.toContain('# wrong-project の移動先候補');
    expect(ja).not.toContain('/w/other');
    expect(ja).toContain('(プロジェクト不明のため wrong-project は選べない。候補なし)');
    expect(ja).not.toContain('# このプロジェクトで常時有効なもの');
    expect(ja).not.toContain('# 運用ルール');
    // wrong-project の手順書き(適合表の行・出力スキーマの target 行・制約行)も orphan では出ない
    expect(ja).not.toContain('| wrong-project |');
    expect(ja).not.toContain('"target": "wrong-project のときのみ必須');
    expect(ja).not.toContain('"target" に候補一覧のパスをそのまま入れる');
    expect(ja).toContain(
      '- verdict は keep / shrink / update のみを使う(それ以外はその件ごと不採用になる)',
    );

    const en = buildPrompt(targets, orphanCtx, 'en', undefined, cands);
    expect(en).not.toContain('The memories belong to the project above');
    expect(en).not.toContain('# Destination candidates for wrong-project');
    expect(en).toContain('(unknown project: wrong-project cannot be chosen');
    expect(en).not.toContain('# Always-on context for this project');
    expect(en).not.toContain('| wrong-project |');
    expect(en).not.toContain('"target": "required for wrong-project only');
    expect(en).not.toContain('Use wrong-project only for a memory');
    expect(en).toContain(
      '- verdict must be one of keep / shrink / update; anything else makes that element unusable.',
    );
  });

  /* orphan の追加文言: 鮮度の着地点(keep のまま)と、memory の実体の実パス(サーバーの確定事実) */
  it('orphan では historical / obsolete でも keep と明示し、memory ディレクトリの実パスを渡す', () => {
    const orphanCtx = { ...ctx, projectPath: null, memDir: '/h/.claude/projects/-w-gone/memory' };
    const ja = buildPrompt(targets, orphanCtx, 'ja');
    expect(ja).toContain('state が historical / obsolete でも verdict は keep とし');
    expect(ja).toContain(
      'このセクションの memory ディレクトリ: /h/.claude/projects/-w-gone/memory',
    );
    const en = buildPrompt(targets, orphanCtx, 'en');
    expect(en).toContain('Even when the state is historical or obsolete, the verdict stays keep');
    expect(en).toContain('memory directory of this section: /h/.claude/projects/-w-gone/memory');
    // memDir が無ければ行ごと出さない(テンプレ表記だけ残る)
    expect(buildPrompt(targets, { ...ctx, projectPath: null }, 'ja')).not.toContain(
      'このセクションの memory ディレクトリ:',
    );
  });

  /* orphan の真実源は ctx.orphan(セクション由来)。projectPath の有無で判定を分岐させない */
  it('ctx.orphan が真なら projectPath があっても制限文言を載せる', () => {
    const ja = buildPrompt(targets, { ...ctx, projectPath: '/w/alpha', orphan: true }, 'ja');
    expect(ja).toContain('verdict は keep / shrink / update のみを使うこと');
    expect(ja).not.toContain('# wrong-project の移動先候補');
  });
});

describe('attachMemoryTriage (キャッシュ済み診断の付与)', () => {
  /*
   * 既定は逆引きできた(= 非 orphan)セクション。実環境ではプロジェクトが特定できている状態が
   * 通常なので、orphan ゲートに関係しないテストが「たまたま orphan」で回らないようにする。
   * orphan のケースは projectPath: null + orphan: true を明示して作る
   */
  const section = (items: SkillItem[], projectPath: string | null = '/w/proj'): MemorySection => ({
    id: '-tmp',
    projectPath,
    projectName: 'tmp',
    note: tmp,
    usageAvailable: false,
    indexTokens: 0,
    items,
  });
  const entry = (over: Partial<TriageStore[string]> = {}): TriageStore[string] => ({
    verdict: 'delete',
    reason: '古い',
    issues: ['58日更新なし'],
    instruction: 'MEMORY.md の索引行を消す',
    hash: null,
    lang: 'ja',
    generatedAt: '',
    ...over,
  });

  it('hash と lang が一致するときだけ aiTriage を付ける', () => {
    const it = memItem('at-a.md', 'aaa');
    attachMemoryTriage([section([it])], 'ja', { [it.path]: entry({ hash: contentHash(it.path) }) });
    expect(it.aiTriage).toEqual({
      verdict: 'delete',
      reason: '古い',
      issues: ['58日更新なし'],
      instruction: 'MEMORY.md の索引行を消す',
    });
  });

  it('state と診断時シグナルもキャッシュから載せる', () => {
    const it = memItem('at-s.md', 'sss');
    attachMemoryTriage([section([it])], 'ja', {
      [it.path]: entry({
        hash: contentHash(it.path),
        state: 'historical',
        signals: [{ kind: 'branch-merged', value: 'feat/x' }],
      }),
    });
    expect(it.aiTriage?.state).toBe('historical');
    expect(it.aiTriage?.signals).toEqual([{ kind: 'branch-merged', value: 'feat/x' }]);
  });

  it('本文が変わっていれば(hash 不一致)付けない', () => {
    const it = memItem('at-b.md', 'bbb');
    attachMemoryTriage([section([it])], 'ja', { [it.path]: entry({ hash: 'stale-hash' }) });
    expect(it.aiTriage).toBeUndefined();
  });

  it('lang が違えば付けない', () => {
    const it = memItem('at-c.md', 'ccc');
    attachMemoryTriage([section([it])], 'en', { [it.path]: entry({ hash: contentHash(it.path) }) });
    expect(it.aiTriage).toBeUndefined();
  });

  it('ファイルが消えていれば付けない', () => {
    const it = memItem('at-d.md', 'ddd');
    const store: TriageStore = { [it.path]: entry({ hash: contentHash(it.path) }) };
    fs.rmSync(it.path);
    attachMemoryTriage([section([it])], 'ja', store);
    expect(it.aiTriage).toBeUndefined();
  });

  /*
   * ゲート導入前(v0.8.0)の wrong-project キャッシュ。移動先はモデルの散文任せで捏造を含みうるので、
   * 表示・コピーの経路に載せない(= 未診断扱いにして再診断の CTA に乗せる)
   */
  it('ゲート導入前の wrong-project キャッシュ(target / demoted / error 無し)は付けない', () => {
    const it = memItem('at-legacy.md', 'lll');
    attachMemoryTriage([section([it])], 'ja', {
      [it.path]: entry({
        hash: contentHash(it.path),
        state: 'current',
        verdict: 'wrong-project',
        instruction: '- /w/でっちあげ へ移す',
      }),
    });
    expect(it.aiTriage).toBeUndefined();
  });

  it('ゲートを通った wrong-project(target あり)と格下げ済み(demoted)はキャッシュから載せる', () => {
    const a = memItem('at-wp.md', 'aaa');
    const b = memItem('at-demoted.md', 'bbb');
    attachMemoryTriage([section([a, b])], 'ja', {
      [a.path]: entry({
        hash: contentHash(a.path),
        state: 'current',
        verdict: 'wrong-project',
        instruction: '',
        target: '/w/other',
      }),
      [b.path]: entry({
        hash: contentHash(b.path),
        state: 'current',
        verdict: 'keep',
        instruction: '',
        demoted: 'wrong-project',
      }),
    });
    expect(a.aiTriage?.verdict).toBe('wrong-project');
    expect(a.aiTriage?.target).toBe('/w/other');
    // 移動先ディレクトリはキャッシュ値ではなく target から都度算出する
    expect(a.aiTriage?.targetMemDir).toBe(
      path.join(os.homedir(), '.claude', 'projects', '-w-other', 'memory'),
    );
    expect(b.aiTriage?.demoted).toBe('wrong-project');
  });

  /* ファイル消失時は contentHash も null を返して hash 比較が通ってしまうため、existsSync が唯一の防波堤 */
  it('hash が null のキャッシュはファイルが消えていれば付けない', () => {
    const it2 = memItem('at-e.md', 'eee');
    const store: TriageStore = { [it2.path]: entry({ hash: null }) };
    fs.rmSync(it2.path);
    attachMemoryTriage([section([it2])], 'ja', store);
    expect(it2.aiTriage).toBeUndefined();
  });

  /*
   * プロジェクト不明(orphan)セクションの verdict 制限(判断 5)。制限導入前に生成された
   * delete / wrong-project 等のキャッシュは、保存値を書き換えず表示時に keep + demoted へ読み替える。
   */
  it('orphan セクションの旧キャッシュ(delete)は表示時に keep + demoted へ読み替える', () => {
    const it = memItem('at-orphan-del.md', 'ooo');
    const store: TriageStore = {
      [it.path]: entry({
        hash: contentHash(it.path),
        verdict: 'delete',
        instruction: '- 削除する',
      }),
    };
    attachMemoryTriage([{ ...section([it], null), orphan: true }], 'ja', store);
    expect(it.aiTriage?.verdict).toBe('keep');
    expect(it.aiTriage?.demoted).toBe('delete');
    expect(it.aiTriage?.instruction).toBe('');
    // 保存値そのものは書き換えない(表示時の読み替えのみ)
    expect(store[it.path].verdict).toBe('delete');
  });

  it('orphan セクションでも keep / shrink / update はそのまま表示する', () => {
    const it = memItem('at-orphan-shrink.md', 'ooo');
    attachMemoryTriage([{ ...section([it], null), orphan: true }], 'ja', {
      [it.path]: entry({ hash: contentHash(it.path), verdict: 'shrink', instruction: '- 縮める' }),
    });
    expect(it.aiTriage?.verdict).toBe('shrink');
    expect(it.aiTriage?.demoted).toBeUndefined();
  });

  it('orphan でないセクションでは delete をそのまま表示する(回帰防止)', () => {
    const it = memItem('at-nonorphan-del.md', 'ooo');
    attachMemoryTriage([section([it])], 'ja', {
      [it.path]: entry({ hash: contentHash(it.path), verdict: 'delete' }),
    });
    expect(it.aiTriage?.verdict).toBe('delete');
    expect(it.aiTriage?.demoted).toBeUndefined();
  });

  /*
   * Phase B 形式(ゲートを通った wrong-project = target あり)のキャッシュも、
   * orphan セクションでは置き場所の判定そのものが成立しないので移動先ごと落とす
   */
  it('orphan セクションでは target 付きの wrong-project キャッシュも移動先ごと落とす', () => {
    const it = memItem('at-orphan-wp.md', 'ooo');
    attachMemoryTriage([{ ...section([it], null), orphan: true }], 'ja', {
      [it.path]: entry({
        hash: contentHash(it.path),
        state: 'current',
        verdict: 'wrong-project',
        instruction: '',
        target: '/w/other',
      }),
    });
    expect(it.aiTriage?.verdict).toBe('keep');
    expect(it.aiTriage?.demoted).toBe('wrong-project');
    expect(it.aiTriage?.target).toBeUndefined();
    expect(it.aiTriage?.targetMemDir).toBeUndefined();
  });

  /*
   * orphan を理由に格下げされた診断は、逆引きできるようになったセクションでは未診断扱いにする
   * (制限つきの結果を、前提が変わった後も表示に残さない。isLegacyWrongProject と同じパターン)
   */
  it('非 orphan セクションでは demotedBy: "orphan" のキャッシュを付けない(再診断に乗せる)', () => {
    const it = memItem('at-orphan-demoted.md', 'ooo');
    const store: TriageStore = {
      [it.path]: entry({
        hash: contentHash(it.path),
        state: 'current',
        verdict: 'keep',
        instruction: '',
        demoted: 'delete',
        demotedBy: 'orphan',
      }),
    };
    attachMemoryTriage([section([it])], 'ja', store);
    expect(it.aiTriage).toBeUndefined();
    // 同じキャッシュでも orphan セクションのままなら表示する(格下げの記録つき)
    const same = memItem('at-orphan-demoted2.md', 'ooo');
    attachMemoryTriage([{ ...section([same], null), orphan: true }], 'ja', {
      [same.path]: { ...store[it.path], hash: contentHash(same.path) },
    });
    expect(same.aiTriage?.demoted).toBe('delete');
  });
});

/*
 * 表示層の orphan ゲート単体(判断 5)。attachMemoryTriage / triageProject の両方が通す関数なので、
 * 「何を落として何を残すか」をここで固定する
 */
describe('orphanTriage (プロジェクト不明セクションの表示ゲート)', () => {
  const wp: MemoryTriage = {
    verdict: 'wrong-project',
    state: 'current',
    reason: '別プロジェクトの話',
    issues: ['/w/other 配下のパス'],
    instruction: '- 移す',
    target: '/w/other',
    targetMemDir: '/h/.claude/projects/-w-other/memory',
    body: { why: 'keep', how: 'keep', keepLines: [], index: 'keep' },
  };

  it('置き場所判定の産物(target / targetMemDir / body)を落として keep + 格下げ記録にする', () => {
    const gated = orphanTriage(wp);
    expect(gated.verdict).toBe('keep');
    expect(gated.demoted).toBe('wrong-project');
    expect(gated.demotedBy).toBe('orphan');
    expect(gated.instruction).toBe('');
    // 鍵ごと落とす(undefined を持たせない)。web の `...(x ? {} : {})` 系と同じ扱いにするため
    expect('target' in gated).toBe(false);
    expect('targetMemDir' in gated).toBe(false);
    expect('body' in gated).toBe(false);
    // 事実(state / reason / issues)は残す。行き先を採らないだけで観察は続ける
    expect(gated.state).toBe('current');
    expect(gated.issues).toEqual(['/w/other 配下のパス']);
    expect(wp.target).toBe('/w/other'); // 入力は書き換えない
  });

  it('keep / shrink / update はそのまま返す(冪等)', () => {
    const keep: MemoryTriage = { verdict: 'keep', reason: '', issues: [], instruction: '' };
    expect(orphanTriage(keep)).toBe(keep);
    const shrink: MemoryTriage = { ...wp, verdict: 'shrink' };
    expect(orphanTriage(shrink)).toBe(shrink);
  });

  /* 出力不正は行き先を持たない(既存の防御節テストと同じく、素通りすることを固定する) */
  it('出力不正(error)は素通りする', () => {
    const broken: MemoryTriage = { ...wp, error: 'invalid-output' };
    expect(orphanTriage(broken)).toBe(broken);
  });
});

/* 常設文脈のテスト用ヘルパ(見出しの識別子は一般語を避け、実ホームの内容と衝突させない) */
function fakeHome(prefix: string, body: string): string {
  const home = fs.mkdtempSync(path.join(tmp, prefix));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), body);
  return home;
}
const ctxItem = (name: string, kind: SkillItem['kind'], description: string): SkillItem => ({
  name,
  description,
  argumentHint: '',
  version: '',
  kind,
  path: '/x/' + name,
  files: [],
});
const ctxSection = (
  id: string,
  source: Section['source'],
  note: string,
  items: SkillItem[],
): Section => ({ id, source, note, items });

describe('collectTriageContext (常設文脈の収集)', () => {
  /* 擬似ホーム。実ホームの ~/.claude/CLAUDE.md を読ませない(テストを実環境から切り離す) */
  const home = fakeHome('home-', '# SV-TEST-HOME-HEADING\nホームの本文\n');
  /* projectPath 配下に CLAUDE.md を置いた擬似プロジェクト */
  const proj = fs.mkdtempSync(path.join(tmp, 'proj-'));
  fs.writeFileSync(
    path.join(proj, 'CLAUDE.md'),
    '# SV-TEST-PROJ-HEADING\n本文は渡さない\n## PR\n本文2\n##### 深すぎる見出し\n' +
      '```bash\n# export TOKEN=x\n```\n',
  );
  const sec: MemorySection = {
    id: '-proj',
    projectPath: proj,
    projectName: 'proj',
    note: tmp,
    usageAvailable: true,
    indexTokens: 0,
    items: [],
  };
  const sections: Section[] = [
    ctxSection('proj-0', 'project', proj, [ctxItem('local', 'command', 'ローカル')]),
    ctxSection('proj-1', 'project', '/other', [ctxItem('other', 'skill', '別')]),
    // 入れ子のサブプロジェクト(worktree 等)。パス接頭辞は一致するが cwd が違えば効かない
    ctxSection('proj-2', 'project', path.join(proj, 'sub'), [ctxItem('nested', 'skill', '入れ子')]),
    ctxSection('user', 'user', '/u', [
      ctxItem('pr-create', 'skill', 'PR を作る'),
      ctxItem('h', 'hook', 'フック'),
    ]),
  ];

  it('見出し行だけを抽出し、本文は載せない', () => {
    const { rules } = collectTriageContext(sec, sections, { home });
    expect(rules).toContain('# SV-TEST-PROJ-HEADING');
    expect(rules).toContain('## PR');
    expect(rules).not.toContain('本文は渡さない');
    expect(rules).not.toContain('##### 深すぎる見出し'); // #5 個は見出しとして扱わない
  });

  it('コードフェンス内の # 行は見出しとして拾わない', () => {
    const { rules } = collectTriageContext(sec, sections, { home });
    expect(rules).not.toContain('# export');
  });

  it('入れ子のフェンス(```` の中の ```)で外側が閉じたと誤認しない', () => {
    const fp = path.join(tmp, 'nested-fence-CLAUDE.md');
    fs.writeFileSync(
      fp,
      [
        '# 通常見出し',
        '````markdown',
        '```bash',
        '# export SECRET=xyz',
        '```',
        '````',
        '# 後続の見出し',
        '~~~',
        '# tilde の中',
        '~~~',
      ].join('\n'),
    );
    expect(headingLines(fp)).toEqual(['# 通常見出し', '# 後続の見出し']);
  });

  it('~/.claude/CLAUDE.md の見出しをラベル付きで載せる', () => {
    const { rules } = collectTriageContext(sec, sections, { home });
    expect(rules).toContain('## ~/.claude/CLAUDE.md');
    expect(rules).toContain('# SV-TEST-HOME-HEADING');
  });

  it('user scope と当該プロジェクトの定義だけを列挙し、hook は除く', () => {
    const { skills } = collectTriageContext(sec, sections, { home });
    expect(skills).toContain('- command local — ローカル');
    expect(skills).toContain('- skill pr-create — PR を作る');
    expect(skills).not.toContain('other');
    expect(skills).not.toContain('フック');
  });

  it('入れ子のサブプロジェクトの定義は「常時有効」に含めない(パス接頭辞一致では拾わない)', () => {
    const { skills } = collectTriageContext(sec, sections, { home });
    expect(skills).not.toContain('nested');
  });

  /* プロジェクト不明は projectPath が無いのでプロジェクトの CLAUDE.md を特定できない(~/.claude のみ残る) */
  it('プロジェクト不明(projectPath null)はホームの見出しだけを載せ、skills は user scope のみ', () => {
    const r = collectTriageContext({ ...sec, projectPath: null }, sections, { home });
    expect(r.rules).toContain('# SV-TEST-HOME-HEADING'); // ホーム分はプロジェクト不明でも載る
    expect(r.rules).not.toContain('## CLAUDE.md');
    expect(r.rules).not.toContain('## .claude/CLAUDE.md');
    expect(r.rules).not.toContain('# SV-TEST-PROJ-HEADING');
    expect(r.skills).not.toContain('local');
    expect(r.skills).toContain('- skill pr-create — PR を作る');
  });
});

/* 上限は「プロンプト全体が本文で既に大きい」前提の防波堤なので、境界そのものを固定する */
describe('collectTriageContext の上限ガード', () => {
  const home = fakeHome('lim-home-', '# SV-TEST-HOME-HEADING\n');
  const proj = fs.mkdtempSync(path.join(tmp, 'lim-proj-'));
  const sec: MemorySection = {
    id: '-lim',
    projectPath: proj,
    projectName: 'lim',
    note: tmp,
    usageAvailable: true,
    indexTokens: 0,
    items: [],
  };
  const userSection = (items: SkillItem[]): Section[] => [ctxSection('user', 'user', '/u', items)];

  it('description は 120 字で切る', () => {
    const sections = userSection([ctxItem('longdesc', 'skill', 'x'.repeat(300))]);
    const { skills } = collectTriageContext(sec, sections, { home });
    expect(skills).toBe('- skill longdesc — ' + 'x'.repeat(120));
  });

  it('skills は 120 行で切る', () => {
    const items = Array.from({ length: 130 }, (_, i) => ctxItem('s' + i, 'skill', 'd'));
    const { skills } = collectTriageContext(sec, userSection(items), { home });
    expect(skills.split('\n')).toHaveLength(120);
  });

  it('skills は 8,000 字でも切る(行数上限を通っても総量を抑える)', () => {
    // 120 行 × 約 135 字 ≈ 16,000 字。行数上限だけでは総量が抑えられないことを示す
    const items = Array.from({ length: 120 }, (_, i) => ctxItem('s' + i, 'skill', 'd'.repeat(120)));
    const { skills } = collectTriageContext(sec, userSection(items), { home });
    expect(skills).toHaveLength(8000);
  });

  it('rules は 80 行で切る', () => {
    fs.writeFileSync(
      path.join(proj, 'CLAUDE.md'),
      Array.from({ length: 100 }, (_, i) => '# H-' + i).join('\n'),
    );
    const { rules } = collectTriageContext(sec, [], { home });
    expect(rules.split('\n')).toHaveLength(80);
  });
});

/*
 * 計画 13 Phase B: wrong-project の安全化。
 * 「サーバー確定事実はモデルに書かせない」ため、移動先は機械シグナル(other-project)を根拠に
 * 候補からの選択だけを受け取り、シグナルが無い件は keep へ格下げして観察を続ける。
 */
describe('parseTriage の wrong-project ゲート(判断 2 / 3)', () => {
  const files = ['a.md'];
  const wp = (over: Record<string, unknown> = {}) =>
    JSON.stringify([
      {
        file: 'a.md',
        state: 'current',
        verdict: 'wrong-project',
        reason: '別プロジェクトの話',
        issues: ['/w/other 配下のパス'],
        instruction: '- 別プロジェクトへ移す',
        ...over,
      },
    ]);

  it('other-project シグナルが無い件は keep へ格下げし、demoted に元の verdict を残す', () => {
    const m = parseTriage(wp({ target: '/w/other' }), files); // 候補マップを渡さない = シグナル無し
    expect(m.get('a.md')).toEqual({
      verdict: 'keep',
      state: 'current',
      reason: '別プロジェクトの話',
      issues: ['/w/other 配下のパス'],
      // 捏造された移動先を含みうるので指示文は捨てる(貼れるものを出さない)
      instruction: '',
      demoted: 'wrong-project',
      // 内容側の理由。環境条件(orphan)とは区別して記録し、再診断の判定に混ぜない
      demotedBy: 'no-signal',
    });
  });

  it('候補があれば target を採用し、移動先の memory ディレクトリを server が組む', () => {
    const m = parseTriage(
      wp({ target: '/w/other' }),
      files,
      new Map(),
      new Map([['a.md', ['/w/other']]]),
    );
    const r = m.get('a.md')!;
    expect(r.verdict).toBe('wrong-project');
    expect(r.target).toBe('/w/other');
    expect(r.targetMemDir).toBe(
      path.join(os.homedir(), '.claude', 'projects', '-w-other', 'memory'),
    );
    expect(r.demoted).toBeUndefined();
    // 採用された件でもモデルの散文は残さない(指示文は web がテンプレートで組む唯一の出典)
    expect(r.instruction).toBe('');
  });

  it('移動先が確定していれば instruction が空でも採用する(指示文は web がテンプレートで組む)', () => {
    const m = parseTriage(
      wp({ target: '/w/other', instruction: '' }),
      files,
      new Map(),
      new Map([['a.md', ['/w/other']]]),
    );
    expect(m.get('a.md')?.verdict).toBe('wrong-project');
    expect(m.get('a.md')?.error).toBeUndefined();
  });

  it('target が候補外・欠落なら出力不正(誤った移動先を出すより欠けるほうが安全)', () => {
    const cands = new Map([['a.md', ['/w/other']]]);
    expect(
      parseTriage(wp({ target: '/w/guess' }), files, new Map(), cands).get('a.md')?.error,
    ).toBe('invalid-output');
    expect(parseTriage(wp(), files, new Map(), cands).get('a.md')?.error).toBe('invalid-output');
  });

  /*
   * 候補はプロンプトへ promptPath(200 字切り)を通した表示で載るので、モデルは表示どおりに
   * しか返せない。生パスで照合すると長いパスが必ず出力不正になる(表示 → 生パスの写像で解決する)
   */
  it('200 字を超える候補は、表示どおりの target でも生パスに解決して採用する', () => {
    const long = '/w/' + 'x'.repeat(300);
    const m = parseTriage(
      wp({ target: promptPath(long) }),
      files,
      new Map(),
      new Map([['a.md', [long]]]),
    );
    expect(m.get('a.md')?.verdict).toBe('wrong-project');
    expect(m.get('a.md')?.target).toBe(long); // 切り詰めた表示ではなく生パスを採用
  });

  it('切り詰めが衝突する 2 候補はどちらも解決不能(出力不正)', () => {
    const base = '/w/' + 'x'.repeat(300);
    const cands = [base + '/alpha', base + '/beta']; // 200 字で切ると同じ表示になる
    for (const target of [promptPath(cands[0]), cands[0]]) {
      const m = parseTriage(wp({ target }), files, new Map(), new Map([['a.md', cands]]));
      expect(m.get('a.md')?.error).toBe('invalid-output');
    }
  });

  it('wrong-project 以外の verdict は候補の有無に関係なく従来どおり', () => {
    const m = parseTriage(
      wp({ verdict: 'delete', target: '/w/guess' }),
      files,
      new Map(),
      new Map([['a.md', ['/w/other']]]),
    );
    expect(m.get('a.md')?.verdict).toBe('delete');
    expect(m.get('a.md')?.target).toBeUndefined(); // 移動先を持つのは wrong-project だけ
  });

  /* 候補は「件ごと」。他の件に出た候補を流用させない(シグナルの無い件は移動先を持てない) */
  it('候補は件単位で、他の件の候補は使えない(その件は格下げ)', () => {
    const both = JSON.stringify([
      {
        file: 'a.md',
        state: 'current',
        verdict: 'wrong-project',
        reason: 'a',
        issues: [],
        instruction: '- 移す',
        target: '/w/other',
      },
      {
        file: 'b.md',
        state: 'current',
        verdict: 'wrong-project',
        reason: 'b',
        issues: [],
        instruction: '- 移す',
        target: '/w/other',
      },
    ]);
    const m = parseTriage(both, ['a.md', 'b.md'], new Map(), new Map([['b.md', ['/w/other']]]));
    expect(m.get('a.md')?.verdict).toBe('keep');
    expect(m.get('a.md')?.demoted).toBe('wrong-project');
    expect(m.get('a.md')?.target).toBeUndefined();
    expect(m.get('b.md')?.verdict).toBe('wrong-project');
    expect(m.get('b.md')?.target).toBe('/w/other');
  });
});

describe('parseTriage のプロジェクト不明(orphan)verdict 制限(判断 5)', () => {
  const files = ['a.md'];
  const answer = (over: Record<string, unknown> = {}) =>
    JSON.stringify([
      {
        file: 'a.md',
        state: 'current',
        verdict: 'delete',
        reason: '重複',
        issues: ['CLAUDE.md に同じ記述'],
        instruction: '- 削除する',
        ...over,
      },
    ]);

  it('delete は keep + demoted: "delete" に格下げし、指示文は捨てる(出力不正ではない)', () => {
    const m = parseTriage(answer(), files, new Map(), new Map(), { orphan: true });
    expect(m.get('a.md')).toEqual({
      verdict: 'keep',
      state: 'current',
      reason: '重複',
      issues: ['CLAUDE.md に同じ記述'],
      instruction: '',
      demoted: 'delete',
      // 環境条件(逆引き不能)が理由の格下げ。解消したら再診断へ乗せるための目印
      demotedBy: 'orphan',
    });
  });

  it('wrong-project は候補があっても格下げする(orphan は置き場所の判定そのものができない)', () => {
    const m = parseTriage(
      answer({ verdict: 'wrong-project', target: '/w/other' }),
      files,
      new Map(),
      new Map([['a.md', ['/w/other']]]), // 候補ありでも採用しない
      { orphan: true },
    );
    expect(m.get('a.md')?.verdict).toBe('keep');
    expect(m.get('a.md')?.demoted).toBe('wrong-project');
    expect(m.get('a.md')?.target).toBeUndefined();
  });

  it.each(['to-claude-md', 'to-docs', 'to-skill'] as const)('%s も格下げする', (verdict) => {
    const m = parseTriage(answer({ verdict }), files, new Map(), new Map(), { orphan: true });
    expect(m.get('a.md')?.verdict).toBe('keep');
    expect(m.get('a.md')?.demoted).toBe(verdict);
  });

  it.each(['keep', 'shrink', 'update'] as const)('%s はそのまま素通りする', (verdict) => {
    const m = parseTriage(
      answer({ verdict, instruction: verdict === 'keep' ? '' : '- 直す' }),
      files,
      new Map(),
      new Map(),
      {
        orphan: true,
      },
    );
    expect(m.get('a.md')?.verdict).toBe(verdict);
    expect(m.get('a.md')?.demoted).toBeUndefined();
  });

  it('orphan フラグ無し(既定)では従来どおり delete がそのまま通る', () => {
    const m = parseTriage(answer(), files);
    expect(m.get('a.md')?.verdict).toBe('delete');
    expect(m.get('a.md')?.demoted).toBeUndefined();
    expect(m.get('a.md')?.demotedBy).toBeUndefined();
  });

  /* 鮮度側の行き先は orphan でも生きているので、body(残す / 削る分類)まで通ることを固定する */
  it('shrink は body プラン(feedback テンプレの材料)を付けたまま素通りする', () => {
    const bodyText = 'ルール行\n\n**Why:** 理由\n\n**How to apply:** 例外: 緊急時は除く';
    const m = parseTriage(
      answer({
        verdict: 'shrink',
        instruction: '- 縮める',
        body: {
          why: 'keep',
          how: 'keep-lines-only',
          keep_lines: ['例外: 緊急時は除く'],
          index: 'keep',
        },
      }),
      files,
      new Map([['a.md', bodyText]]),
      new Map(),
      { orphan: true },
    );
    expect(m.get('a.md')?.verdict).toBe('shrink');
    expect(m.get('a.md')?.body).toEqual({
      why: 'keep',
      how: 'keep-lines-only',
      keepLines: ['例外: 緊急時は除く'],
      index: 'keep',
    });
  });

  /* 索引と本文の食い違いは置き場所と無関係な事実なので、格下げしても落とさない(UI の警告の材料) */
  it('格下げした件でも index_matches_body: false は indexMatchesBody として残る', () => {
    const m = parseTriage(answer({ index_matches_body: false }), files, new Map(), new Map(), {
      orphan: true,
    });
    expect(m.get('a.md')?.indexMatchesBody).toBe(false);
    expect(m.get('a.md')?.demotedBy).toBe('orphan');
  });
});

describe('targetMemDirOf (移動先の memory ディレクトリ)', () => {
  /* 期待値も絶対パスで組む(コピー文のパス表記を `~/` と混在させないための変更) */
  const memDir = (project: string) =>
    path.join(os.homedir(), '.claude', 'projects', encodeProjectPath(project), 'memory');

  it('実在する memory dir を算出より優先する(登録パス自身の slug に memory が既にあるならそれが正)', () => {
    // 擬似 HOME を注入(tmp 配下 = afterAll で一括削除)。親リポジトリ配下のサブディレクトリだが、
    // 自身の slug に本文ファイル入りの memory が実在するケース
    const home = fs.mkdtempSync(path.join(tmp, 'tmd-home-'));
    const repo = path.join(tmp, 'tm-own-repo');
    const sub = path.join(repo, 'frontend');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(sub, { recursive: true });
    const own = path.join(home, '.claude', 'projects', encodeProjectPath(sub), 'memory');
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, 'x.md'), '---\nname: x\n---\n本文');
    expect(targetMemDirOf(sub, home)).toBe(own); // repoRootOf(= repo)より実在を優先
    // 空ディレクトリ(残骸)は実在扱いしない: x.md を消すと算出(リポジトリルート)へ落ちる
    fs.rmSync(path.join(own, 'x.md'));
    expect(targetMemDirOf(sub, home)).toBe(
      path.join(home, '.claude', 'projects', encodeProjectPath(repo), 'memory'),
    );
  });

  it('submodule は親リポジトリに束ねない(.git がリポジトリ境界。自身の slug になる)', () => {
    const parent = path.join(tmp, 'tm-sm-parent');
    const sm = path.join(parent, 'vendor', 'sub');
    fs.mkdirSync(path.join(parent, '.git'), { recursive: true });
    fs.mkdirSync(sm, { recursive: true });
    // submodule の .git ファイル(gitdir が .git/modules/... を指す = mainWorktreeOf は null)
    fs.writeFileSync(
      path.join(sm, '.git'),
      'gitdir: ' + path.join(parent, '.git', 'modules', 'sub') + '\n',
    );
    expect(targetMemDirOf(sm)).toBe(memDir(sm)); // 親(tm-sm-parent)の slug にならない
  });

  it('worktree はメインワークツリーの slug になる(memory はリポジトリ単位で共有されるため)', () => {
    const main = path.join(tmp, 'tm-repo');
    const wt = path.join(tmp, 'tm-repo-feat');
    fs.mkdirSync(path.join(main, '.git'), { recursive: true });
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(
      path.join(wt, '.git'),
      'gitdir: ' + path.join(main, '.git', 'worktrees', 'feat') + '\n',
    );
    expect(targetMemDirOf(wt)).toBe(memDir(main));
    expect(targetMemDirOf(main)).toBe(memDir(main)); // メイン自身も同じ
  });

  /* ~/.claude.json には「リポジトリのサブディレクトリ」が普通に登録される(自分の .git は無い) */
  it('サブディレクトリ登録のプロジェクトはリポジトリのルートの slug になる', () => {
    const repo = path.join(tmp, 'tm-sub-repo');
    const sub = path.join(repo, 'frontend');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(sub, { recursive: true });
    expect(targetMemDirOf(sub)).toBe(memDir(repo));
  });

  it('git 管理下でないパス(祖先にも .git が無い)はそのパス自身の slug', () => {
    const plain = path.join(tmp, 'tm-plain');
    fs.mkdirSync(plain, { recursive: true });
    expect(targetMemDirOf(plain)).toBe(memDir(plain));
  });
});

describe('promptPath (プロンプトに埋めるパスの無害化)', () => {
  it('改行を落として 1 行にし、長さも切る(節や箇条書きの偽装を防ぐ)', () => {
    expect(promptPath('/w/a\n- 偽の指示\r\n/w/b')).toBe('/w/a - 偽の指示 /w/b');
    expect(promptPath('/w/' + 'x'.repeat(300))).toHaveLength(200);
  });
});

describe('buildPrompt の移動先候補(wrong-project は候補からの選択にする)', () => {
  const ctx = { projectName: 'alpha', index: '', usageAvailable: true };
  const withSig = memItem('c-sig.md', '---\nname: sig\n---\n本文', {
    signals: [{ kind: 'other-project', value: '/w/other' }],
  });
  const plain = memItem('c-plain.md', '---\nname: plain\n---\n本文');

  it('シグナルのあるパスを「どの件で出たか」と一緒に列挙し、target を出力スキーマに足す', () => {
    for (const lang of ['ja', 'en'] as const) {
      const prompt = buildPrompt([withSig, plain], ctx, lang);
      expect(prompt).toContain(
        '- /w/other' + (lang === 'ja' ? '(該当: ' : ' (seen in: ') + 'c-sig.md)',
      );
      expect(prompt).toContain('"target"');
    }
  });

  it('候補が 1 件も無ければ「wrong-project は選べない」と明示する(節ごと落とさない)', () => {
    expect(buildPrompt([plain], ctx, 'ja')).toContain('wrong-project は選べない');
    expect(buildPrompt([plain], ctx, 'en')).toContain('wrong-project cannot be chosen');
  });

  it('候補は呼び出し側の絞り込み(登録プロジェクト)を通す', () => {
    const prompt = buildPrompt([withSig], ctx, 'ja', undefined, () => []);
    expect(prompt).not.toContain('- /w/other(該当:');
    expect(prompt).toContain('候補なし');
  });
});

describe('candidatesFor (移動先候補の登録プロジェクト絞り込み)', () => {
  const sec = (otherProjects?: string[]): MemorySection => ({
    id: '-w-alpha',
    projectPath: '/w/alpha',
    projectName: 'alpha',
    note: tmp,
    usageAvailable: false,
    indexTokens: 0,
    items: [],
    ...(otherProjects ? { otherProjects } : {}),
  });
  const signals: MemorySignal[] = [
    { kind: 'other-project', value: '/w/other' },
    { kind: 'date', value: '2026-06-01', days: 1 },
  ];

  it('シグナル値が otherProjects にあれば候補になる', () => {
    expect(candidatesFor(sec(['/w/other']), signals)).toEqual(['/w/other']);
  });

  it('otherProjects に無い / undefined なら候補は空(wrong-project を選ばせない)', () => {
    expect(candidatesFor(sec(['/w/another']), signals)).toEqual([]);
    expect(candidatesFor(sec(), signals)).toEqual([]);
  });
});

describe('selectStale: ゲート導入前の wrong-project キャッシュ', () => {
  const entry = (over: Partial<TriageStore[string]> = {}): TriageStore[string] => ({
    verdict: 'wrong-project',
    state: 'current',
    reason: '',
    issues: [],
    instruction: '- 移す',
    hash: null,
    lang: 'ja',
    generatedAt: '',
    ...over,
  });

  it('target も demoted も無い wrong-project は hash が一致しても再診断に乗せる', () => {
    const a = memItem('ws-old.md', 'aaa');
    const store: TriageStore = { [a.path]: entry({ hash: contentHash(a.path) }) };
    expect(selectStale([a], store, 'ja', false)).toHaveLength(1);
  });

  /*
   * demoted / error は現状 verdict が keep になるためこの組み合わせは出ないが、
   * 防御節(!demoted / !error)が実際に効いていることを見るため verdict は wrong-project のまま与える
   */
  /*
   * orphan 格下げは環境条件(未マウント・登録抹消)で起きるので、条件が解消したら自動で再診断へ。
   * orphan のままなら再診断しない(同じ制限で同じ結果になるだけで、call が無駄になる)
   */
  it('orphan 格下げのキャッシュは、非 orphan セクションでだけ stale になる', () => {
    const a = memItem('ws-orphan.md', 'aaa');
    const store: TriageStore = {
      [a.path]: entry({
        hash: contentHash(a.path),
        verdict: 'keep',
        instruction: '',
        demoted: 'delete',
        demotedBy: 'orphan',
      }),
    };
    expect(selectStale([a], store, 'ja', false)).toHaveLength(1); // opts 省略 = 非 orphan
    expect(selectStale([a], store, 'ja', false, { orphan: true })).toHaveLength(0);
  });

  /* no-signal(内容側の理由)の格下げは環境が変わっても再診断しない */
  it('demotedBy: "no-signal" の格下げは非 orphan セクションでも stale にしない', () => {
    const a = memItem('ws-nosignal.md', 'aaa');
    const store: TriageStore = {
      [a.path]: entry({
        hash: contentHash(a.path),
        verdict: 'keep',
        instruction: '',
        demoted: 'wrong-project',
        demotedBy: 'no-signal',
      }),
    };
    expect(selectStale([a], store, 'ja', false)).toHaveLength(0);
  });

  it('target あり・格下げ済み(demoted)・出力不正(error)の wrong-project は stale にしない', () => {
    const a = memItem('ws-new.md', 'aaa');
    const b = memItem('ws-demoted.md', 'bbb');
    const c = memItem('ws-error.md', 'ccc');
    const store: TriageStore = {
      [a.path]: entry({ hash: contentHash(a.path), target: '/w/other' }),
      [b.path]: entry({ hash: contentHash(b.path), instruction: '', demoted: 'wrong-project' }),
      [c.path]: entry({ hash: contentHash(c.path), instruction: '', error: 'invalid-output' }),
    };
    expect(selectStale([a, b, c], store, 'ja', false)).toHaveLength(0);
  });
});

/*
 * 配線の 1 本通し(判断 5)。プロンプト生成 → parseTriage の制限 → 表示ゲートまでが
 * 同じ orphan フラグで動くことを、モデル呼び出しだけ差し替えて確かめる。
 * 診断キャッシュ(~/.cache/skills-viewer)は擬似 HOME 下に切り離す(実環境のキャッシュを汚さない)。
 */
describe('triageProject のプロジェクト不明(orphan)配線', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('候補なしのプロンプトを作り、置き場所の verdict を格下げして返す', async () => {
    const home = fs.mkdtempSync(path.join(tmp, 'tp-home-'));
    vi.stubEnv('HOME', home); // TRIAGE_FILE はモジュール読み込み時に決まるので、import より先に差す
    vi.resetModules();
    const { triageProject } = await import('../src/server/memory-triage');

    const memDir = fs.mkdtempSync(path.join(tmp, 'tp-mem-'));
    const file = path.join(memDir, 'tp-note.md');
    fs.writeFileSync(file, '---\nname: tp-note\n---\n/w/other/src の設定を直した');
    const item: SkillItem = {
      name: 'tp-note',
      description: '',
      argumentHint: '',
      version: '',
      kind: 'memory',
      path: file,
      files: [],
      // 別の登録プロジェクト配下のパス = 非 orphan なら wrong-project の候補になるシグナル
      signals: [{ kind: 'other-project', value: '/w/other' }],
    };
    const sec: MemorySection = {
      id: '-w-gone',
      projectPath: null,
      projectName: '-w-gone',
      note: memDir,
      orphan: true,
      usageAvailable: false,
      indexTokens: 0,
      otherProjects: ['/w/other'],
      items: [item],
    };

    let prompt = '';
    const results = await triageProject(sec, 'ja', 'haiku', {
      run: async (p: string) => {
        prompt = p;
        return JSON.stringify([
          {
            file: 'tp-note.md',
            state: 'obsolete',
            verdict: 'delete',
            index_matches_body: true,
            reason: '役目を終えている',
            issues: ['参照パスが存在しない'],
            instruction: '- 削除する',
            target: '/w/other',
          },
        ]);
      },
    });

    // プロンプト: 候補ブロックを出さず、memory の実体の実パスを渡す
    expect(prompt).not.toContain('# wrong-project の移動先候補');
    expect(prompt).toContain('(プロジェクト不明のため wrong-project は選べない。候補なし)');
    expect(prompt).toContain('このセクションの memory ディレクトリ: ' + memDir);
    // 結果: parseTriage の制限が効き、貼れる指示文と移動先は残らない
    expect(results).toHaveLength(1);
    expect(results[0].verdict).toBe('keep');
    expect(results[0].demoted).toBe('delete');
    expect(results[0].instruction).toBe('');
    expect(results[0].target).toBeUndefined();
    // キャッシュにも格下げの理由が残る(orphan 解消後の再診断の材料)
    const store = JSON.parse(
      fs.readFileSync(path.join(home, '.cache', 'skills-viewer', 'memory-triage.json'), 'utf8'),
    );
    expect(store[file].demotedBy).toBe('orphan');
  });
});
