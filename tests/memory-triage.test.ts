import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  attachMemoryTriage,
  buildPrompt,
  collectTriageContext,
  parseTriage,
  selectStale,
  type TriageStore,
} from '../src/server/memory-triage';
import { contentHash } from '../src/server/summary';
import { triageEstimate } from '../web/src/util';
import type { MemorySection, MemoryVerdict, Section, SkillItem } from '../src/shared/types';

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
      instruction: '- docs/ へ移し MEMORY.md の索引行を消す',
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

  it('to-skill を通す(7 値目)', () => {
    const m = parseTriage(
      JSON.stringify([
        {
          file: 'a.md',
          verdict: 'to-skill',
          reason: 'pr-create の挙動への好み',
          issues: [],
          instruction: '- pr-create の SKILL.md に 1 行足す',
        },
      ]),
      files,
    );
    expect(m.get('a.md')?.verdict).toBe('to-skill');
  });

  it('instruction の体裁を「- 」箇条書きに正規化する(番号付き・散文・空行)', () => {
    const m = parseTriage(
      JSON.stringify([
        { file: 'a.md', verdict: 'delete', reason: 'r', issues: [], instruction: '1. a\n2. b' },
        { file: 'b.md', verdict: 'delete', reason: 'r', issues: [], instruction: '散文' },
      ]),
      files,
    );
    expect(m.get('a.md')?.instruction).toBe('- a\n- b');
    expect(m.get('b.md')?.instruction).toBe('- 散文');
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

  it('ja / en とも索引行の削除に触れ、verdict の 6 値を出力スキーマで縛る', () => {
    const schema = '"keep" | "shrink" | "to-claude-md" | "to-docs" | "delete" | "wrong-project"';
    for (const lang of ['ja', 'en'] as const) {
      const prompt = buildPrompt(targets, ctx, lang);
      // 見出しの MEMORY.md ではなく「索引行を消せ」という指示そのものが要る
      expect(prompt).toContain(
        lang === 'ja' ? 'MEMORY.md の索引行の削除' : 'removing the line from MEMORY.md',
      );
      // 判定指針テーブルの (to-docs) 等ではなく、出力スキーマ行の 6 値を見る
      expect(prompt).toContain(schema);
      expect(prompt).toContain('|---|---|'); // 判定指針テーブルが崩れていない
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
    expect(buildPrompt(targets, ctx, 'ja')).toContain('(無し)');
    expect(buildPrompt(targets, ctx, 'en')).toContain('(none)');
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

  /* ファイル消失時は contentHash も null を返して hash 比較が通ってしまうため、existsSync が唯一の防波堤 */
  it('hash が null のキャッシュはファイルが消えていれば付けない', () => {
    const it2 = memItem('at-e.md', 'eee');
    const store: TriageStore = { [it2.path]: entry({ hash: null }) };
    fs.rmSync(it2.path);
    attachMemoryTriage([section([it2])], 'ja', store);
    expect(it2.aiTriage).toBeUndefined();
  });
});

describe('collectTriageContext (常設文脈の収集)', () => {
  /* projectPath 配下に CLAUDE.md を置いた擬似プロジェクト */
  const proj = fs.mkdtempSync(path.join(tmp, 'proj-'));
  fs.writeFileSync(
    path.join(proj, 'CLAUDE.md'),
    '# 運用\n本文は渡さない\n## PR\n本文2\n##### 深すぎる見出し\n',
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
  const item = (name: string, kind: SkillItem['kind'], description: string): SkillItem => ({
    name,
    description,
    argumentHint: '',
    version: '',
    kind,
    path: '/x/' + name,
    files: [],
  });
  const sections: Section[] = [
    { id: 'proj-0', source: 'project', note: proj, items: [item('local', 'command', 'ローカル')] },
    { id: 'proj-1', source: 'project', note: '/other', items: [item('other', 'skill', '別')] },
    {
      id: 'user',
      source: 'user',
      note: '/u',
      items: [item('pr-create', 'skill', 'PR を作る'), item('h', 'hook', 'フック')],
    },
  ];

  it('見出し行だけを抽出し、本文は載せない', () => {
    const { rules } = collectTriageContext(sec, sections);
    expect(rules).toContain('# 運用');
    expect(rules).toContain('## PR');
    expect(rules).not.toContain('本文は渡さない');
    expect(rules).not.toContain('##### 深すぎる見出し'); // #5 個は見出しとして扱わない
  });

  it('user scope と当該プロジェクトの定義だけを列挙し、hook は除く', () => {
    const { skills } = collectTriageContext(sec, sections);
    expect(skills).toContain('- command local — ローカル');
    expect(skills).toContain('- skill pr-create — PR を作る');
    expect(skills).not.toContain('other');
    expect(skills).not.toContain('フック');
  });

  /* 孤児は projectPath が無いのでプロジェクトの CLAUDE.md を特定できない(~/.claude のみ残る) */
  it('孤児(projectPath null)はプロジェクトの見出しを載せず、skills は user scope のみ', () => {
    const r = collectTriageContext({ ...sec, projectPath: null }, sections);
    expect(r.rules).not.toContain('# 運用');
    expect(r.skills).not.toContain('local');
    expect(r.skills).toContain('- skill pr-create — PR を作る');
  });
});
