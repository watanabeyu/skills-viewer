import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  attachMemoryTriage,
  buildPrompt,
  parseTriage,
  selectStale,
  type TriageStore,
} from '../src/server/memory-triage';
import { contentHash } from '../src/server/summary';
import { triageEstimate } from '../web/src/util';
import type { MemorySection, MemoryVerdict, SkillItem } from '../src/shared/types';

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
      reason: '完了済みの設計文書',
      issues: ['58日更新なし'],
      instruction: 'docs/ へ移し MEMORY.md の索引行を消す',
    });
  });

  it('コードフェンス付きでも読める', () => {
    const m = parseTriage(
      '```json\n[{"file":"a.md","verdict":"keep","reason":"r","issues":[],"instruction":""}]\n```',
      files,
    );
    expect(m.get('a.md')?.verdict).toBe('keep');
  });

  it('不正な verdict の要素は keep に落とさず捨てる', () => {
    const m = parseTriage(
      JSON.stringify([
        { file: 'a.md', verdict: 'archive', reason: 'r', issues: [], instruction: 'x' },
        { file: 'b.md', verdict: 'delete', reason: 'r', issues: [], instruction: 'x' },
      ]),
      files,
    );
    expect(m.has('a.md')).toBe(false);
    expect(m.get('b.md')?.verdict).toBe('delete');
  });

  it('file の欠落・対象外は捨てる', () => {
    const m = parseTriage(
      JSON.stringify([
        { verdict: 'delete', reason: 'r', issues: [], instruction: 'x' },
        { file: 'other.md', verdict: 'delete', reason: 'r', issues: [], instruction: 'x' },
        { file: 'a.md', verdict: 'shrink', reason: 'r', issues: [], instruction: 'x' },
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
          reason: 'あ'.repeat(500),
          issues: ['い'.repeat(200), '2', '3', '4', '5', 42],
          instruction: '消してよい',
        },
        {
          file: 'b.md',
          verdict: 'delete',
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

  it('同じ file が重複したら先勝ち', () => {
    const m = parseTriage(
      JSON.stringify([
        { file: 'a.md', verdict: 'delete', reason: 'first', issues: [], instruction: 'x' },
        { file: 'a.md', verdict: 'keep', reason: 'second', issues: [], instruction: '' },
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

describe('selectStale (差分 call の対象選定)', () => {
  const entry = (over: Partial<TriageStore[string]> = {}): TriageStore[string] => ({
    verdict: 'keep',
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

  it('to-claude-md は索引が減る代わりに本文が常時注入になる', () => {
    expect(triageEstimate(item('to-claude-md'))).toEqual({ index: -20, always: 600 });
  });

  it('keep / shrink / 未診断は数値を出さない', () => {
    expect(triageEstimate(item('keep'))).toBeNull();
    expect(triageEstimate(item('shrink'))).toBeNull();
    expect(triageEstimate(item(null))).toBeNull();
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
    for (const it of targets) expect(prompt).toContain(path.basename(it.path));
    expect(prompt).toContain('引き継ぎの本文'); // 本文も渡す
  });

  it('ja / en とも MEMORY.md の索引行に触れ、verdict の 6 値を提示する', () => {
    for (const lang of ['ja', 'en'] as const) {
      const prompt = buildPrompt(targets, ctx, lang);
      expect(prompt).toContain('MEMORY.md');
      for (const v of ['keep', 'shrink', 'to-claude-md', 'to-docs', 'delete', 'wrong-project']) {
        expect(prompt).toContain(v);
      }
    }
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
});
