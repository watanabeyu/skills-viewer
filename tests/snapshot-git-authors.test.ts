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
}));

import { GIT_AUTHOR_MAX, attachGitAuthors } from '../src/server/snapshot';

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
