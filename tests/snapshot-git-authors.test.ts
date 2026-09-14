/*
 * attachGitAuthors(src/server/snapshot.ts)の上限と処理順。
 *
 * 1 件あたり 20ms 前後の同期実行(execFileSync)なので GIT_AUTHOR_MAX 件で打ち切る。
 * removed を先に回すのは、消えたファイルは mtime が残っておらず git が唯一の情報源だから
 * (README 6.3 の「無ければ更新日だけ」に自然に縮退させるにしても、削除は縮退する情報が無い)。
 *
 * この 2 つは実際に git プロセスを 40 件以上起動して確かめるには重すぎる(1 件 20ms × 40 件超)。
 * 判断: node:child_process の execFileSync をモックし、attachGitAuthors を export して直接呼ぶ
 * (production はテスト用の export だけを追加。ロジックは変えていない)。
 * worktreeRootOf(memory.ts)は `.git` という名のディレクトリの存在だけを見るので、
 * 実 HOME を使わず一時ディレクトリに空の `.git` を置けば git を起動せずに境界判定だけ通せる。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeEntry, SnapshotChanges } from '../src/shared/types';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => 'Test Person\t2026-01-01T00:00:00+09:00'),
  execFile: vi.fn(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, out: string, errOut: string) => void,
    ) => cb(null, 'Async Person\t2026-02-02T00:00:00+09:00', ''),
  ),
}));

import {
  GIT_AUTHOR_MAX,
  attachGitAuthors,
  clearGitAuthorMemo,
  prewarmGitAuthors,
} from '../src/server/snapshot';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-git-authors-'));
fs.mkdirSync(path.join(tmp, '.git')); // worktreeRootOf が見るのはこのディレクトリの存在だけ
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const entry = (n: string): ChangeEntry => ({
  name: n,
  kind: 'skill',
  path: path.join(tmp, `${n}.md`),
  source: 'project',
});

beforeEach(() => {
  vi.mocked(execFileSync).mockClear();
  clearGitAuthorMemo();
});

/*
 * v0.9.0 のリリース判定で見つけた回帰: 差分は既読にするまで消えないので、控えが無いと
 * リクエストごとに上限まで git が走る(未読 98 件で 1 リクエスト 700 ms)。鍵は path + hash
 */
describe('attachGitAuthors (控え)', () => {
  it('同じ項目(同じ hash)で 2 回呼んでも git は 1 回。hash が変われば引き直す', () => {
    const changes = (): SnapshotChanges => ({
      added: [entry('x'), entry('y')],
      updated: [],
      removed: [],
    });
    const c1 = changes();
    attachGitAuthors(c1, () => 'h1');
    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(2);
    const c2 = changes();
    attachGitAuthors(c2, () => 'h1');
    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(2);
    expect(c2.added.every((e) => e.author === 'Test Person')).toBe(true);
    attachGitAuthors(changes(), () => 'h2');
    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(4);
  });

  it('上限に当たっても、控えのある項目には author が付く(return で打ち切らない)', () => {
    // 先に 40 件を控えに入れる
    const first: SnapshotChanges = {
      added: Array.from({ length: GIT_AUTHOR_MAX }, (_, i) => entry(`a${i}`)),
      updated: [],
      removed: [],
    };
    attachGitAuthors(first, () => 'h');
    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(GIT_AUTHOR_MAX);
    // 新規 45 件 + 控え 40 件。git は新規の 40 件分だけ走り、控えの 40 件は全部付く
    const second: SnapshotChanges = {
      added: [
        ...Array.from({ length: 45 }, (_, i) => entry(`n${i}`)),
        ...Array.from({ length: GIT_AUTHOR_MAX }, (_, i) => entry(`a${i}`)),
      ],
      updated: [],
      removed: [],
    };
    attachGitAuthors(second, () => 'h');
    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(GIT_AUTHOR_MAX * 2);
    expect(second.added.slice(45).every((e) => e.author === 'Test Person')).toBe(true);
    expect(second.added.slice(0, 45).filter((e) => e.author).length).toBe(GIT_AUTHOR_MAX);
  });

  it('起動時の先読み(prewarm)は非同期に控えを埋め、以後の同期側は git を呼ばない', async () => {
    const changes = (): SnapshotChanges => ({
      added: Array.from({ length: 10 }, (_, i) => entry(`p${i}`)),
      updated: [],
      removed: [],
    });
    await prewarmGitAuthors(changes(), () => 'h');
    const c = changes();
    attachGitAuthors(c, () => 'h');
    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(0);
    expect(c.added.every((e) => e.author === 'Async Person')).toBe(true);
  });

  it('未コミット(git が空を返す)は控えを短命にし、すぐには固定しない', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('' as never);
    const c1: SnapshotChanges = { added: [entry('u')], updated: [], removed: [] };
    attachGitAuthors(c1, () => 'h');
    expect(c1.added[0].author).toBeUndefined();
    // 60 秒以内は引き直さない(リクエストごとの git を防ぐ)
    attachGitAuthors({ added: [entry('u')], updated: [], removed: [] }, () => 'h');
    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(1);
  });
});

describe('attachGitAuthors (上限 GIT_AUTHOR_MAX)', () => {
  it('45 件あっても author が付くのは先頭 GIT_AUTHOR_MAX (40) 件まで', () => {
    const changes: SnapshotChanges = {
      added: Array.from({ length: 45 }, (_, i) => entry(`a${i}`)),
      updated: [],
      removed: [],
    };
    attachGitAuthors(changes);
    const withAuthor = changes.added.filter((e) => e.author).length;
    expect(withAuthor).toBe(GIT_AUTHOR_MAX);
    expect(changes.added.slice(0, GIT_AUTHOR_MAX).every((e) => e.author === 'Test Person')).toBe(
      true,
    );
    expect(changes.added.slice(GIT_AUTHOR_MAX).every((e) => !e.author)).toBe(true);
    // git 実行そのものも上限を超えて呼ばれていない(コストの根拠)
    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(GIT_AUTHOR_MAX);
  });
});

describe('attachGitAuthors (removed を先に処理する)', () => {
  it('removed が added より少なくても、removed 全件に author が付く(added だけで上限に届く数でも)', () => {
    // removed 5 + added 40 = 45 は上限 40 を超えるが、removed が先勝ちすることを確かめる
    const changes: SnapshotChanges = {
      removed: Array.from({ length: 5 }, (_, i) => entry(`r${i}`)),
      added: Array.from({ length: 40 }, (_, i) => entry(`a${i}`)),
      updated: Array.from({ length: 5 }, (_, i) => entry(`u${i}`)),
    };
    attachGitAuthors(changes);
    // removed は取りこぼしなく全件に付く(処理順が逆なら、ここが真っ先に欠ける)
    expect(changes.removed.every((e) => e.author === 'Test Person')).toBe(true);
    // 上限は removed + added + updated の合計に効く。removed 5 件を使った残り 35 件だけ added に付く
    const addedWithAuthor = changes.added.filter((e) => e.author).length;
    expect(addedWithAuthor).toBe(GIT_AUTHOR_MAX - 5);
    // 上限に達した時点で打ち切るので updated には 1 件も付かない
    expect(changes.updated.every((e) => !e.author)).toBe(true);
  });
});
