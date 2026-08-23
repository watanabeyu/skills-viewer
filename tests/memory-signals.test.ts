import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  branchSignals,
  dice2gram,
  doneWords,
  episodicTokens,
  extractSignals,
  feedbackSignals,
  latestDate,
  missingPaths,
  otherProjectRefs,
  parseFeedbackParts,
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

/* 実データ(weall の feedback_worktree_reuse)と同じ構造のフィクスチャ */
const WORKTREE_DESC =
  'レビューコメント対応時は新しいworktreeを作らず、既存のブランチで直接作業する';
const WORKTREE_BODY = [
  'レビューコメントの修正対応では、新しいworktreeやブランチを作る必要はない。元のブランチで直接追加コミットすればよい。',
  '',
  '**Why:** ユーザーが「feat/695で作業すればいいんじゃないんですか？」と指摘。レビュー対応は同じPRのブランチに追加コミットするのが自然。',
  '',
  '**How to apply:** PRレビューコメントへの修正対応時は、そのPRのブランチ上で直接作業してコミット・pushする。新しいブランチやworktreeは作らない。',
].join('\n');

describe('parseFeedbackParts (feedback 本文の定型分解)', () => {
  it('1 行目 / Why / How to apply に分ける', () => {
    const p = parseFeedbackParts(WORKTREE_BODY);
    expect(p.rule).toMatch(/^レビューコメントの修正対応では/);
    expect(p.why).toMatch(/^ユーザーが「feat\/695/);
    expect(p.how).toMatch(/^PRレビューコメントへの修正対応時は/);
  });

  it('見出しが無い部分は空文字。Why だけ・順序逆でも壊れない', () => {
    expect(parseFeedbackParts('ルールだけ')).toEqual({ rule: 'ルールだけ', why: '', how: '' });
    const p = parseFeedbackParts('rule\n\n**How to apply:** h\n\n**Why:** w');
    expect(p).toEqual({ rule: 'rule', why: 'w', how: 'h' });
  });
});

describe('dice2gram (文字 2-gram の類似度)', () => {
  it('同文は 1、無関係は 0 付近、言い換えは中間', () => {
    expect(dice2gram('abcdef', 'abcdef')).toBe(1);
    expect(dice2gram('あいうえお', 'かきくけこ')).toBe(0);
    expect(dice2gram(WORKTREE_DESC, parseFeedbackParts(WORKTREE_BODY).how)).toBeGreaterThan(0.3);
    expect(dice2gram('', 'x')).toBe(0);
  });
});

describe('episodicTokens (エピソード固有の語)', () => {
  it('ブランチ名 / #番号 / 日付 / ユーザーが指摘 を拾い、一般的な理由文からは拾わない', () => {
    expect(episodicTokens('feat/695 で 2026-05-22 に #865 をユーザーが指摘')).toEqual([
      'feat/695',
      '#865',
      '2026-05-22',
      'ユーザーが指摘',
    ]);
    expect(
      episodicTokens('レビュー対応は同じ PR の続きなので別ブランチに分けると対応が切れる'),
    ).toEqual([]);
  });
});

describe('feedbackSignals (feedback 本文構造のシグナル)', () => {
  it('worktree_reuse 型: How は再掲・Why はエピソード・例外なし・1 行目は再掲', () => {
    const kinds = feedbackSignals(WORKTREE_BODY, WORKTREE_DESC, 166).map((s) => s.kind);
    expect(kinds).toEqual(['first-line-restates', 'how-restates', 'why-episodic']);
  });

  it('例外があれば has-exception、長ければ body-over。Why が一般的なら why-episodic は出ない', () => {
    const body =
      'ルール\n\n**Why:** 型検査が無いため。\n\n**How to apply:** 全く別の手順を毎回実行する。ただし hotfix のときは除く。';
    const sig = feedbackSignals(body, '無関係な説明文', 400);
    expect(sig.map((s) => s.kind)).toEqual(['has-exception', 'body-over']);
    expect(sig[0].value).toContain('ただし');
    expect(sig[1].value).toBe('400');
  });

  it('extractSignals は feedback / user 型のときだけ本文構造を見る', () => {
    const proj = path.join(tmp, 'proj3');
    fs.mkdirSync(proj, { recursive: true });
    const opts = { now: NOW, home: tmp, bodyTokens: 166 };
    expect(
      extractSignals(WORKTREE_BODY, WORKTREE_DESC, proj, { ...opts, memoryType: 'feedback' }).map(
        (s) => s.kind,
      ),
    ).toEqual(['first-line-restates', 'how-restates', 'why-episodic']);
    expect(
      extractSignals(WORKTREE_BODY, WORKTREE_DESC, proj, { ...opts, memoryType: 'project' }).map(
        (s) => s.kind,
      ),
    ).toEqual([]);
  });
});

describe('otherProjectRefs / other-project (別プロジェクトの配下パス)', () => {
  const home = path.join(tmp, 'home2');
  const weall = path.join(home, 'work', 'weall', 'monorepo');
  const viewer = path.join(home, 'work', 'skills-viewer');
  const others = [viewer, path.join(home, 'work', 'cheap-trick')];

  it('絶対パス・~/ の両方で、登録プロジェクトの配下を指していれば basename を返す(重複なし・最大 2)', () => {
    const body = `このツールは ~/work/skills-viewer/ で開発。実体は ${viewer}/src/cli.ts。関係ない ${weall}/apps は自分`;
    expect(otherProjectRefs(body, home, others)).toEqual(['skills-viewer']);
    expect(
      otherProjectRefs('~/work/skills-viewer-2/x と ~/.cache/skills-viewer/', home, others),
    ).toEqual([]);
    expect(otherProjectRefs('何もない', home, others)).toEqual([]);
    expect(otherProjectRefs('~/work/skills-viewer/a', home, [])).toEqual([]);
  });

  it('scanMemory は自分自身と worktree 関係のプロジェクトを候補から外す', () => {
    const root = path.join(tmp, 'projects2');
    const main = path.join(tmp, 'work2', 'mono');
    const wt = path.join(tmp, 'work2', 'mono-feature-x');
    const other = path.join(tmp, 'work2', 'other');
    for (const d of [main, wt, other]) fs.mkdirSync(d, { recursive: true });
    // wt を main の linked worktree に見せる(.git ファイルの gitdir が main/.git/worktrees/<name>)
    fs.mkdirSync(path.join(main, '.git', 'worktrees', 'x'), { recursive: true });
    fs.writeFileSync(
      path.join(wt, '.git'),
      'gitdir: ' + path.join(main, '.git', 'worktrees', 'x') + '\n',
    );
    const dir = path.join(root, encodeProjectPath(main), 'memory');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'a.md'),
      `---\nname: a\n---\n${wt}/apps は自分の worktree、${other}/src は別プロジェクト`,
    );
    const [sec] = scanMemory(main, { root, projects: [main, wt, other] });
    expect(sec.items[0].signals).toEqual([{ kind: 'other-project', value: 'other' }]);
  });
});
