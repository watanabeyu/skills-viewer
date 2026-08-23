import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  branchSignals,
  doneWords,
  extractSignals,
  latestDate,
  missingPaths,
  type BranchInfo,
} from '../src/server/memory-signals';
import { scanMemory } from '../src/server/memory';
import { encodeProjectPath } from '../src/server/usage';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-signals-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/* 経過日の基準は固定(2026-08-23 UTC) */
const NOW = Date.UTC(2026, 7, 23);

describe('latestDate (本文の最新の絶対日付)', () => {
  it('3 形式を読み、最新の 1 件と経過日を返す', () => {
    const body = '2026-05-01 に着手。2026/06/15 に方針変更。2026年7月2日 時点で残 3 件。';
    expect(latestDate(body, NOW)).toEqual({ value: '2026-07-02', days: 52 });
  });

  it('日付が無ければ null。不正な月日と 1 年超の未来は無視する', () => {
    expect(latestDate('日付なし', NOW)).toBeNull();
    expect(latestDate('2026-13-01 と 2030-01-01', NOW)).toBeNull();
  });

  it('未来の日付(1 年以内)は経過日 0 に丸める', () => {
    expect(latestDate('2026-09-01 に実施予定', NOW)).toEqual({ value: '2026-09-01', days: 0 });
  });
});

describe('missingPaths (参照パスの実在)', () => {
  const proj = path.join(tmp, 'proj');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'src', 'exists.ts'), '');
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '');

  it('プロジェクト相対・絶対・~/ を解決し、存在しないものだけを返す', () => {
    const body = [
      '`src/exists.ts` と `src/gone.ts` を見る。',
      `絶対パス ${path.join(proj, 'src', 'exists.ts')} と ${path.join(proj, 'nope', 'x.md')}。`,
      '~/.claude/CLAUDE.md と ~/.claude/missing.md。',
    ].join('\n');
    expect(missingPaths(body, proj, home)).toEqual([
      'src/gone.ts',
      path.join(proj, 'nope', 'x.md'),
      '~/.claude/missing.md',
    ]);
  });

  it('URL・ドメイン風・拡張子なし(ブランチ名やパッケージ名)は拾わない', () => {
    const body =
      'https://github.com/org/repo/blob/main/src/gone.ts を参照。feat/plan10-memory と @scope/pkg と example.com/a.js。';
    expect(missingPaths(body, proj, home)).toEqual([]);
  });

  it('projectPath が無い(孤児)なら相対パスは判定せず、絶対と ~/ だけ見る', () => {
    const body = 'src/gone.ts と ~/.claude/missing.md';
    expect(missingPaths(body, null, home)).toEqual(['~/.claude/missing.md']);
  });

  it('最大 3 件で打ち切り、同じパスは重複して数えない', () => {
    const body = 'a/1.md a/1.md a/2.md a/3.md a/4.md';
    expect(missingPaths(body, proj, home)).toEqual(['a/1.md', 'a/2.md', 'a/3.md']);
  });
});

describe('doneWords (完了語)', () => {
  it('日本語は部分一致、英語は単語境界つきで拾う(最大 3 語)', () => {
    expect(doneWords('PR はマージ済。対応済の項目は完了。Done.')).toEqual([
      '完了',
      'マージ済',
      '対応済',
    ]);
    expect(doneWords('abandoned is not a done word; undone neither')).toEqual(['done']);
    expect(doneWords('進行中')).toEqual([]);
  });
});

describe('extractSignals (テキスト / fs 層のまとめ)', () => {
  it('日付・欠損パス・完了語を kind 別に返し、無ければ空配列', () => {
    const proj = path.join(tmp, 'proj2');
    fs.mkdirSync(proj, { recursive: true });
    const sig = extractSignals('2026-01-10 に src/x.ts を直した', 'マージ済の作業', proj, {
      now: NOW,
      home: tmp,
    });
    expect(sig).toEqual([
      { kind: 'date', value: '2026-01-10', days: 225 },
      { kind: 'path-missing', value: 'src/x.ts' },
      { kind: 'done-words', value: 'マージ済' },
    ]);
    expect(extractSignals('何もない本文', '', proj, { now: NOW, home: tmp })).toEqual([]);
  });

  it('scanMemory が各 memory に signals を付け、無い件は省略する', () => {
    const root = path.join(tmp, 'projects');
    const proj = path.join(tmp, 'work', 'gamma');
    fs.mkdirSync(proj, { recursive: true });
    const dir = path.join(root, encodeProjectPath(proj), 'memory');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'stale.md'), '---\nname: stale\n---\n`src/gone.ts` はマージ済');
    fs.writeFileSync(path.join(dir, 'fresh.md'), '---\nname: fresh\n---\n方針のみ');
    const [sec] = scanMemory(proj, { root, projects: [proj], mainWorktree: null });
    const stale = sec.items.find((it) => it.name === 'stale')!;
    expect(stale.signals?.map((s) => s.kind)).toEqual(['path-missing', 'done-words']);
    expect(sec.items.find((it) => it.name === 'fresh')!.signals).toBeUndefined();
  });
});

describe('branchSignals (git 層)', () => {
  const info: BranchInfo = {
    all: new Set(['main', 'feat/live', 'feat/done', 'fix/old']),
    merged: new Set(['feat/done', 'fix/old']),
    defaultBranch: 'main',
  };

  it('マージ済みは branch-merged、存在しないものは branch-missing、進行中は何も出さない', () => {
    const body = '作業は feat/live で進行中。feat/done はマージ済(fix/old)。feat/gone は消した。';
    expect(branchSignals(body, info)).toEqual([
      { kind: 'branch-merged', value: 'feat/done' },
      { kind: 'branch-merged', value: 'fix/old' },
      { kind: 'branch-missing', value: 'feat/gone' },
    ]);
  });

  it('ディレクトリ名(docs/ test/ や末尾 /)はブランチとして拾わない', () => {
    const body = 'docs/projects-design/ と test/contract を見る。feat/wip/ は末尾がスラッシュ';
    expect(branchSignals(body, info)).toEqual([]);
  });

  it('既定ブランチと重複は出さない', () => {
    expect(branchSignals('main と feat/done と feat/done', info)).toEqual([
      { kind: 'branch-merged', value: 'feat/done' },
    ]);
  });
});
