/*
 * GET /api/diff の実体(src/server/diff.ts)。web 側の行 diff(tests/diff.test.ts)とは別物。
 * 主眼はパス検証: ユーザー入力のクエリを受けて git show を走らせるため、
 * .git 配下・`..` 脱出・リポジトリ外を必ず落とすこと。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { previousContent, resolveDiffTarget } from '../src/server/diff';
import { ApiError } from '../src/server/errors';

const tmpDirs: string[] = [];
const mkTmp = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('resolveDiffTarget(パス検証)', () => {
  const root = '/repo';
  const rootOf = () => root;

  it('.md 以外は not-md', () => {
    expect(() => resolveDiffTarget('/repo/settings.json', rootOf)).toThrow(ApiError);
    try {
      resolveDiffTarget('/repo/settings.json', rootOf);
    } catch (e) {
      expect((e as ApiError).code).toBe('not-md');
    }
  });

  it('.git 配下は拒否(リポジトリ判定より前)', () => {
    for (const p of ['/repo/.git/config.md', '/repo/.git/hooks/x.md', '/repo/a/.git/b.md']) {
      try {
        resolveDiffTarget(p, rootOf);
        throw new Error('should have thrown: ' + p);
      } catch (e) {
        expect((e as ApiError).code).toBe('not-readable-path');
      }
    }
  });

  it('root の外へ出る相対パスは拒否', () => {
    try {
      resolveDiffTarget('/repo/../outside/a.md', rootOf);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ApiError).code).toBe('not-readable-path');
    }
  });

  it('`..` を含んでいても root 内に収まるものは通り、正規化された相対パスになる', () => {
    expect(resolveDiffTarget('/repo/a/../b/c.md', rootOf)).toEqual({
      root,
      relPath: 'b/c.md',
    });
  });

  it('git 管理外(repoRootOf が null)は not-git', () => {
    expect(resolveDiffTarget('/anywhere/a.md', () => null)).toEqual({ reason: 'not-git' });
  });

  it('~/.claude 配下(user scope)は履歴を出さない', () => {
    const p = path.join(os.homedir(), '.claude', 'skills', 'x', 'SKILL.md');
    expect(resolveDiffTarget(p, rootOf)).toEqual({ reason: 'user-scope' });
  });
});

describe('resolveDiffTarget(root の決め方)', () => {
  it('通常のリポジトリは .git を持つ最も近い祖先が root', () => {
    const dir = mkTmp('sv-diff-root-');
    fs.mkdirSync(path.join(dir, '.git'));
    fs.mkdirSync(path.join(dir, 'docs'));
    expect(resolveDiffTarget(path.join(dir, 'docs', 'a.md'))).toEqual({
      root: dir,
      relPath: 'docs/a.md',
    });
  });

  it('linked worktree は worktree 自身が root(メインワークツリーへ寄せない)', () => {
    const base = mkTmp('sv-diff-wt-');
    const main = path.join(base, 'main');
    const wt = path.join(base, 'wt');
    fs.mkdirSync(path.join(main, '.git', 'worktrees', 'x'), { recursive: true });
    fs.mkdirSync(wt);
    fs.writeFileSync(
      path.join(wt, '.git'),
      'gitdir: ' + path.join(main, '.git', 'worktrees', 'x') + '\n',
    );
    // repoRootOf を使うと root が main になり、wt のファイルが root の外(`..`)に出てしまう
    expect(resolveDiffTarget(path.join(wt, 'README.md'))).toEqual({
      root: wt,
      relPath: 'README.md',
    });
  });
});

/* git が無い環境では実行系のケースをスキップ(検証そのものは上の describe で確認済み) */
const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGit)('previousContent(git show)', () => {
  const repo = (() => {
    const dir = mkTmp('sv-diff-');
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', dir, ...args], {
        stdio: 'ignore',
        env: { ...process.env, HOME: dir, GIT_CONFIG_NOSYSTEM: '1' },
      });
    git('init', '-q');
    git('config', 'user.email', 'tester@example.com');
    git('config', 'user.name', 'Test Person');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(dir, 'A.md'), 'committed body\n');
    git('add', 'A.md');
    git('commit', '-q', '-m', 'init');
    return dir;
  })();

  it('HEAD 時点の内容を返す(ワーキングツリーの変更は反映しない)', () => {
    fs.writeFileSync(path.join(repo, 'A.md'), 'edited body\n');
    expect(previousContent(path.join(repo, 'A.md'))).toEqual({
      available: true,
      previous: 'committed body\n',
    });
  });

  it('削除済みのファイルでも過去の内容が取れる', () => {
    const fp = path.join(repo, 'A.md');
    const kept = fs.readFileSync(fp, 'utf8');
    fs.rmSync(fp);
    expect(previousContent(fp)).toEqual({ available: true, previous: 'committed body\n' });
    fs.writeFileSync(fp, kept);
  });

  it('HEAD に無い新規ファイルは no-history', () => {
    const fp = path.join(repo, 'new.md');
    fs.writeFileSync(fp, 'x');
    expect(previousContent(fp)).toEqual({ available: false, reason: 'no-history' });
  });

  it('.git 配下は git show まで届かない', () => {
    expect(() => previousContent(path.join(repo, '.git', 'x.md'))).toThrow(ApiError);
  });
});
