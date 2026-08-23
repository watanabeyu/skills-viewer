import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  applyIndexMismatch,
  attachMemoryTriage,
  buildPrompt,
  chunkByChars,
  collectTriageContext,
  normalizeInstruction,
  parseBodyPlan,
  parseTriage,
  selectStale,
  triageHash,
  type TriageStore,
  headingLines,
} from '../src/server/memory-triage';
import { contentHash } from '../src/server/summary';
import { instructionsOf, triageEstimate } from '../web/src/util';
import type {
  MemorySection,
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
    expect(ja).toContain('signals(機械が拾った鮮度の事実):\n(なし)');
    const en = buildPrompt(withSig, ctx, 'en', extra);
    expect(en).toContain('- latest date in body: 2026-06-01 (83 days ago)');
    expect(en).toContain('- branch feat/x is already merged');
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
});

describe('attachMemoryTriage (キャッシュ済み診断の付与)', () => {
  const section = (items: SkillItem[]): MemorySection => ({
    id: '-tmp',
    projectPath: null,
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

  /* ファイル消失時は contentHash も null を返して hash 比較が通ってしまうため、existsSync が唯一の防波堤 */
  it('hash が null のキャッシュはファイルが消えていれば付けない', () => {
    const it2 = memItem('at-e.md', 'eee');
    const store: TriageStore = { [it2.path]: entry({ hash: null }) };
    fs.rmSync(it2.path);
    attachMemoryTriage([section([it2])], 'ja', store);
    expect(it2.aiTriage).toBeUndefined();
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

  /* 孤児は projectPath が無いのでプロジェクトの CLAUDE.md を特定できない(~/.claude のみ残る) */
  it('孤児(projectPath null)はホームの見出しだけを載せ、skills は user scope のみ', () => {
    const r = collectTriageContext({ ...sec, projectPath: null }, sections, { home });
    expect(r.rules).toContain('# SV-TEST-HOME-HEADING'); // ホーム分は孤児でも載る
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
