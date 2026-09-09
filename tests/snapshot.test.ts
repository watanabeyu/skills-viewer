import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MemorySection, Section } from '../src/shared/types';
import { ackChanges, buildSnapshot, computeChanges, diffSnapshot } from '../src/server/snapshot';
import { dayKey } from '../src/server/usage';

const tmpDirs: string[] = [];
const mkTmp = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

const sec = (items: Section['items'], source: Section['source'] = 'user'): Section => ({
  id: 'user',
  source,
  note: '',
  items,
});

const item = (over: Partial<Section['items'][number]>): Section['items'][number] => ({
  name: 'foo',
  description: 'd',
  argumentHint: '',
  version: '',
  kind: 'skill',
  path: '/p/SKILL.md',
  files: [],
  ...over,
});

const memSec = (items: Section['items'], over: Partial<MemorySection> = {}): MemorySection => ({
  id: 'proj',
  projectPath: '/p',
  projectName: 'p',
  note: '/mem',
  usageAvailable: false,
  indexTokens: 0,
  items,
  ...over,
});

describe('buildSnapshot', () => {
  it('hook と built-in(path 無し)は対象外。キーは kind:パス', () => {
    const dir = mkTmp('snap-');
    const fp = path.join(dir, 'SKILL.md');
    fs.writeFileSync(fp, 'body');
    const snap = buildSnapshot([
      sec([
        item({ path: fp }),
        item({ name: 'PostToolUse', kind: 'hook', path: '/s.json' }),
        item({ name: 'builtin', path: '' }),
      ]),
    ]);
    expect(Object.keys(snap)).toEqual([`skill:${fp}`]);
    expect(snap[`skill:${fp}`].hash).toBeTruthy();
    expect(snap[`skill:${fp}`].source).toBe('user');
  });

  it('memory の本文もキーに入る(出所はプロジェクト)', () => {
    const dir = mkTmp('snap-mem-');
    const fp = path.join(dir, 'note.md');
    fs.writeFileSync(fp, 'memory body');
    const snap = buildSnapshot([], [memSec([item({ name: 'note', kind: 'memory', path: fp })])]);
    expect(Object.keys(snap)).toEqual([`memory:${fp}`]);
    expect(snap[`memory:${fp}`]).toMatchObject({ kind: 'memory', source: 'project' });
    expect(snap[`memory:${fp}`].hash).toBeTruthy();
  });

  it('共有ストアの memory は user 出所(git 履歴を引かせない)', () => {
    const dir = mkTmp('snap-shared-');
    const fp = path.join(dir, 'note.md');
    fs.writeFileSync(fp, 'x');
    const snap = buildSnapshot(
      [],
      [memSec([item({ name: 'note', kind: 'memory', path: fp })], { sharedStore: true })],
    );
    expect(snap[`memory:${fp}`].source).toBe('user');
  });

  it('CLAUDE.md は exists のものだけキーになる', () => {
    const dir = mkTmp('snap-cmd-');
    const here = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(here, '# policy');
    const snap = buildSnapshot(
      [],
      [],
      [
        { path: here, exists: true },
        { path: path.join(dir, '.claude', 'CLAUDE.md'), exists: false },
      ],
    );
    expect(Object.keys(snap)).toEqual([`claude-md:${here}`]);
    expect(snap[`claude-md:${here}`]).toMatchObject({
      name: 'CLAUDE.md',
      kind: 'claude-md',
      source: 'project',
    });
  });

  it('~/.claude 配下の CLAUDE.md は user 出所', () => {
    const fp = path.join(os.homedir(), '.claude', 'CLAUDE.md');
    const snap = buildSnapshot([], [], [{ path: fp, exists: true }]);
    expect(snap[`claude-md:${fp}`].source).toBe('user');
  });

  it('同じパスでも kind が違えば別のキーになる', () => {
    const dir = mkTmp('snap-kind-');
    const fp = path.join(dir, 'a.md');
    fs.writeFileSync(fp, 'x');
    const snap = buildSnapshot(
      [sec([item({ kind: 'command', path: fp })])],
      [memSec([item({ name: 'a', kind: 'memory', path: fp })])],
    );
    expect(Object.keys(snap).sort()).toEqual([`command:${fp}`, `memory:${fp}`]);
  });
});

describe('diffSnapshot', () => {
  const e = (name: string, hash: string | null) => ({
    name,
    kind: 'skill' as const,
    source: 'project' as const,
    hash,
  });
  it('追加・更新・削除を検出する', () => {
    const prev = { 'skill:/a': e('a', 'h1'), 'skill:/b': e('b', 'h2'), 'skill:/c': e('c', 'h3') };
    const cur = {
      'skill:/a': e('a', 'h1'),
      'skill:/b': e('b', 'CHANGED'),
      'skill:/d': e('d', 'h4'),
    };
    const d = diffSnapshot(prev, cur);
    expect(d.added.map((x) => x.name)).toEqual(['d']);
    expect(d.updated.map((x) => x.name)).toEqual(['b']);
    expect(d.removed.map((x) => x.name)).toEqual(['c']);
  });
  it('ChangeEntry の path はキーから kind を外した実パス', () => {
    const d = diffSnapshot({}, { 'memory:/m/a: b.md': e('a', 'h') });
    expect(d.added[0].path).toBe('/m/a: b.md');
    expect(d.added[0].source).toBe('project');
  });
  it('変化がなければ全カテゴリ空', () => {
    const snap = { 'skill:/a': e('a', 'h1') };
    const d = diffSnapshot(snap, { ...snap });
    expect(d.added.length + d.updated.length + d.removed.length).toBe(0);
  });
});

describe('computeChanges(形式移行)', () => {
  /* 実環境の ~/.cache/skills-viewer/snapshot.json には触らない(file は注入する) */
  const setup = () => {
    const dir = mkTmp('snap-v2-');
    const fp = path.join(dir, 'SKILL.md');
    fs.writeFileSync(fp, 'body');
    return { dir, fp, snapFile: path.join(dir, 'cache', 'snapshot.json') };
  };

  it('v1(フラットなパスキー)は基準なしに落ち、差分を出さずに v2 で保存し直す', () => {
    const { fp, snapFile } = setup();
    fs.mkdirSync(path.dirname(snapFile), { recursive: true });
    // 旧形式: v 無し・キーは実パスそのまま・source 無し
    fs.writeFileSync(
      snapFile,
      JSON.stringify({ '/old/SKILL.md': { name: 'old', kind: 'skill', hash: 'h' } }),
    );
    const changes = computeChanges([sec([item({ path: fp })])], [], [], snapFile);
    expect(changes).toBeNull();
    const saved = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
    expect(saved.v).toBe(2);
    expect(Object.keys(saved.entries)).toEqual([`skill:${fp}`]);
  });

  it('初回(ファイル無し)は基準だけ保存して null', () => {
    const { fp, snapFile } = setup();
    expect(computeChanges([sec([item({ path: fp })])], [], [], snapFile)).toBeNull();
    expect(JSON.parse(fs.readFileSync(snapFile, 'utf8')).v).toBe(2);
  });

  it('v2 の基準があれば差分を出す(memory の変更も拾う)', () => {
    const { dir, fp, snapFile } = setup();
    const mem = path.join(dir, 'note.md');
    fs.writeFileSync(mem, 'v1');
    const sections = [sec([item({ path: fp })])];
    const memory = [memSec([item({ name: 'note', kind: 'memory', path: mem })])];
    expect(computeChanges(sections, memory, [], snapFile)).toBeNull(); // 基準づくり
    fs.writeFileSync(mem, 'v2 changed');
    const changes = computeChanges(sections, memory, [], snapFile);
    expect(changes?.updated.map((x) => `${x.kind}:${x.path}`)).toEqual([`memory:${mem}`]);
    expect(changes?.added).toEqual([]);
    // 既読にするまで基準は動かない(同じ差分がもう一度出る)
    expect(computeChanges(sections, memory, [], snapFile)?.updated).toHaveLength(1);
    ackChanges(sections, memory, [], snapFile);
    expect(computeChanges(sections, memory, [], snapFile)).toBeNull();
  });

  it('git 管理外のファイルには author を付けない', () => {
    const { fp, snapFile } = setup();
    const sections = [sec([item({ path: fp })], 'project')];
    computeChanges(sections, [], [], snapFile);
    fs.writeFileSync(fp, 'changed');
    const changes = computeChanges(sections, [], [], snapFile);
    expect(changes?.updated).toHaveLength(1);
    expect(changes?.updated[0].author).toBeUndefined();
    expect(changes?.updated[0].authoredAt).toBeUndefined();
  });
});

/*
 * since / ackedAt: 「前回既読にしてから」の起点。ホーム ①「いつ既読にしてから」の表示は
 * これが無いと出せない。ackChanges(既読にする)が基準に時刻を刻み、次回の computeChanges が
 * それを since として返す ── ただし、この機能追加より前に保存された v2 基準には ackedAt が
 * 無いので、その場合は since を付けずに欠ける(README のとおり「起点を持たない古い基準では省略」)。
 */
describe('computeChanges / ackChanges (since / ackedAt)', () => {
  /* 実環境の ~/.cache/skills-viewer/snapshot.json には触らない(file は注入する) */
  const setup = () => {
    const dir = mkTmp('snap-since-');
    const fp = path.join(dir, 'SKILL.md');
    fs.writeFileSync(fp, 'body');
    return { dir, fp, snapFile: path.join(dir, 'cache', 'snapshot.json') };
  };

  it('ackChanges で保存した基準には ackedAt(既読にした時刻)が入る', () => {
    const { fp, snapFile } = setup();
    const sections = [sec([item({ path: fp })])];
    const before = Date.now();
    ackChanges(sections, [], [], snapFile);
    const saved = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
    expect(saved.ackedAt).toBeDefined();
    expect(Date.parse(saved.ackedAt)).toBeGreaterThanOrEqual(before);
  });

  it('前回既読にした ackedAt が、次回の computeChanges の changes.since として返る', () => {
    const { fp, snapFile } = setup();
    const sections = [sec([item({ path: fp })])];
    computeChanges(sections, [], [], snapFile); // 初回: 基準だけ保存(まだ既読の概念は無いが ackedAt は刻む)
    const saved1 = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
    expect(saved1.ackedAt).toBeDefined();
    fs.writeFileSync(fp, 'changed');
    const changes = computeChanges(sections, [], [], snapFile);
    expect(changes?.since).toBe(saved1.ackedAt);
  });

  it('ackedAt を持たない旧い v2 基準では since を付けない(この追加より前に保存されたファイル)', () => {
    const { fp, snapFile } = setup();
    fs.mkdirSync(path.dirname(snapFile), { recursive: true });
    // ackedAt が実装される前に保存された v2 ファイルを模す
    fs.writeFileSync(snapFile, JSON.stringify({ v: 2, entries: {} }));
    const sections = [sec([item({ path: fp })])];
    const changes = computeChanges(sections, [], [], snapFile);
    expect(changes?.added).toHaveLength(1); // 差分自体は出る
    expect(changes?.since).toBeUndefined();
  });
});

/* git が無い環境ではスキップ(機能そのものが git 依存で、失敗時は author 無しに倒れる) */
const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGit)('computeChanges(git 履歴)', () => {
  it('project 出所の変化項目に author / authoredAt が付く', () => {
    const dir = mkTmp('snap-git-');
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', dir, ...args], {
        stdio: 'ignore',
        // グローバル設定(署名・テンプレート)の影響を受けないよう HOME を temp に向ける
        env: { ...process.env, HOME: dir, GIT_CONFIG_NOSYSTEM: '1' },
      });
    git('init', '-q');
    git('config', 'user.email', 'tester@example.com');
    git('config', 'user.name', 'Test Person');
    git('config', 'commit.gpgsign', 'false');
    const fp = path.join(dir, 'SKILL.md');
    const snapFile = path.join(dir, 'cache', 'snapshot.json');
    fs.writeFileSync(fp, 'v1');
    git('add', 'SKILL.md');
    git('commit', '-q', '-m', 'add skill');
    const sections = [sec([item({ path: fp })], 'project')];
    computeChanges(sections, [], [], snapFile); // 基準づくり
    fs.writeFileSync(fp, 'v2');
    const changes = computeChanges(sections, [], [], snapFile);
    expect(changes?.updated[0].author).toBe('Test Person');
    expect(changes?.updated[0].authoredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('user 出所には git を引かない(同じリポジトリでも author 無し)', () => {
    const dir = mkTmp('snap-git-user-');
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', dir, ...args], {
        stdio: 'ignore',
        env: { ...process.env, HOME: dir, GIT_CONFIG_NOSYSTEM: '1' },
      });
    git('init', '-q');
    git('config', 'user.email', 'tester@example.com');
    git('config', 'user.name', 'Test Person');
    git('config', 'commit.gpgsign', 'false');
    const fp = path.join(dir, 'SKILL.md');
    const snapFile = path.join(dir, 'cache', 'snapshot.json');
    fs.writeFileSync(fp, 'v1');
    git('add', 'SKILL.md');
    git('commit', '-q', '-m', 'add skill');
    const sections = [sec([item({ path: fp })], 'user')];
    computeChanges(sections, [], [], snapFile);
    fs.writeFileSync(fp, 'v2');
    expect(computeChanges(sections, [], [], snapFile)?.updated[0].author).toBeUndefined();
  });
});

describe('dayKey', () => {
  it('ローカルタイムゾーンの YYYY-MM-DD を返す', () => {
    const ts = new Date(2026, 6, 10, 23, 59).getTime(); // 2026-07-10 local
    expect(dayKey(ts)).toBe('2026-07-10');
  });
});
