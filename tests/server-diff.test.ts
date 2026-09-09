/*
 * GET /api/diff の実体(src/server/diff.ts)。web 側の行 diff(tests/diff.test.ts)とは別物。
 * 主眼はパス検証: ユーザー入力のクエリを受けて git show を走らせるため、
 * .git 配下・`..` 脱出・リポジトリ外・そして読み取りの境界の外を必ず落とすこと。
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
  const cwd = '/repo';
  const rootOf = () => root;
  /* 境界の中(プロジェクトの .claude 配下)のパス。ここを通るものだけが検証の対象になる */
  const inScope = (rel: string) => path.join(root, '.claude', rel);

  it('.md 以外は not-md', () => {
    const p = inScope('settings.json');
    expect(() => resolveDiffTarget(p, cwd, rootOf)).toThrow(ApiError);
    try {
      resolveDiffTarget(p, cwd, rootOf);
    } catch (e) {
      expect((e as ApiError).code).toBe('not-md');
    }
  });

  it('.git 配下は拒否(リポジトリ判定より前)', () => {
    for (const p of ['/repo/.git/config.md', '/repo/.git/hooks/x.md', '/repo/a/.git/b.md']) {
      try {
        resolveDiffTarget(p, cwd, rootOf);
        throw new Error('should have thrown: ' + p);
      } catch (e) {
        expect((e as ApiError).code).toBe('not-readable-path');
      }
    }
  });

  it('root の外へ出る相対パスは境界の外なので out-of-scope', () => {
    expect(resolveDiffTarget('/repo/../outside/a.md', cwd, rootOf)).toEqual({
      reason: 'out-of-scope',
    });
  });

  it('`..` を含んでいても境界内に収まるものは通り、正規化された相対パスになる', () => {
    expect(resolveDiffTarget(inScope('skills/../commands/c.md'), cwd, rootOf)).toEqual({
      root,
      relPath: '.claude/commands/c.md',
    });
  });

  it('git 管理外(worktreeRootOf が null)は not-git', () => {
    expect(resolveDiffTarget(inScope('a.md'), cwd, () => null)).toEqual({ reason: 'not-git' });
  });

  it('~/.claude 配下(user scope)は履歴を出さない', () => {
    const p = path.join(os.homedir(), '.claude', 'skills', 'x', 'SKILL.md');
    expect(resolveDiffTarget(p, cwd, rootOf)).toEqual({ reason: 'user-scope' });
  });

  /*
   * 読み取りの境界の外。ここが無いと「git 管理下ならどこの .md でも HEAD が読める」ことになり、
   * 同じファイルに対して /api/file と許可範囲が食い違う(レビュー 2026-09-09 の指摘)。
   */
  it('境界の外(.claude / autoMemoryDirectory / CLAUDE.md 群のどれでもない)は out-of-scope', () => {
    for (const p of ['/repo/README.md', '/repo/docs/notes.md', '/other/private.md']) {
      expect(resolveDiffTarget(p, cwd, rootOf)).toEqual({ reason: 'out-of-scope' });
    }
  });

  it('プロジェクトの .claude 配下は通る', () => {
    expect(resolveDiffTarget(inScope('skills/x/SKILL.md'), cwd, rootOf)).toEqual({
      root,
      relPath: '.claude/skills/x/SKILL.md',
    });
  });

  /*
   * 境界の中に見えても root の外へ出るパス。allowedPath は「消えているファイル」を救うために
   * 字句判定に落ちるので、git に `..` を渡さない最後の砦がここで効くことを固定する。
   */
  it('境界内の字句だが root の外に出るものは not-readable-path', () => {
    try {
      resolveDiffTarget('/other/.claude/skills/x/SKILL.md', cwd, rootOf);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ApiError).code).toBe('not-readable-path');
    }
  });
});

/*
 * clone してきたリポジトリは symlink を持ち込める。経路に `.claude` を含む symlink が別の
 * リポジトリを指しているとき、字句一致だけで許可すると /api/file が拒否する同じパスで
 * /api/diff が別リポジトリの HEAD を返してしまう(レビュー 2 周目の指摘。実測で再現済み)。
 */
describe('resolveDiffTarget(symlink で境界の外へ出られないこと)', () => {
  it('.claude 配下の symlink が別リポジトリを指していても out-of-scope', () => {
    const base = mkTmp('sv-diff-sym-');
    const cloned = path.join(base, 'cloned');
    const other = path.join(base, 'other-repo', 'notes');
    fs.mkdirSync(path.join(cloned, '.claude'), { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'private.md'), 'CONFIDENTIAL\n');
    fs.symlinkSync(path.join(base, 'other-repo'), path.join(cloned, '.claude', 'link'));

    const target = path.join(cloned, '.claude', 'link', 'notes', 'private.md');
    expect(resolveDiffTarget(target, cloned, () => other)).toEqual({ reason: 'out-of-scope' });
    expect(previousContent(target, cloned)).toEqual({
      available: false,
      reason: 'out-of-scope',
    });
  });
});

/*
 * ディレクトリごと消えている場合。1 段だけ解決する realDir では素通りし、
 * 字句判定 → symlink 側の .git を root として別リポジトリの HEAD が返っていた
 * (レビュー 3 周目の実測)。実在する一番深い祖先まで解決することで塞ぐ。
 */
describe('resolveDiffTarget(symlink の先のディレクトリが消えていても越えられない)', () => {
  it('相対 symlink + 消えたサブディレクトリでも out-of-scope', () => {
    const base = mkTmp('sv-diff-sym2-');
    const proj = path.join(base, 'proj');
    const other = path.join(base, 'other');
    fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    // clone で持ち込める相対 symlink。指す先は別リポジトリ
    fs.symlinkSync(path.join('..', '..', 'other'), path.join(proj, '.claude', 'rel'));
    // other/sub は HEAD にはあるがワーキングツリーには無い、という想定(ディレクトリごと不在)
    const target = path.join(proj, '.claude', 'rel', 'sub', 'x.md');
    expect(resolveDiffTarget(target, proj, () => other)).toEqual({ reason: 'out-of-scope' });
    expect(previousContent(target, proj)).toEqual({ available: false, reason: 'out-of-scope' });
  });

  /* 境界の中で消えているものは従来どおり通る(この API の存在理由) */
  it('境界の中で消えたファイルは通る', () => {
    const proj = mkTmp('sv-diff-gone-');
    fs.mkdirSync(path.join(proj, '.git'));
    fs.mkdirSync(path.join(proj, '.claude', 'skills', 'x'), { recursive: true });
    const gone = path.join(proj, '.claude', 'skills', 'x', 'SKILL.md');
    expect(resolveDiffTarget(gone, proj)).toEqual({
      root: fs.realpathSync(proj),
      relPath: '.claude/skills/x/SKILL.md',
    });
  });
});

describe('resolveDiffTarget(root の決め方)', () => {
  it('通常のリポジトリは .git を持つ最も近い祖先が root', () => {
    const dir = mkTmp('sv-diff-root-');
    fs.mkdirSync(path.join(dir, '.git'));
    fs.mkdirSync(path.join(dir, '.claude', 'commands'), { recursive: true });
    // root は realpath 済みで返る(macOS の /var → /private/var。git -C はどちらでも同じ答え)
    expect(resolveDiffTarget(path.join(dir, '.claude', 'commands', 'a.md'), dir)).toEqual({
      root: fs.realpathSync(dir),
      relPath: '.claude/commands/a.md',
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
    fs.mkdirSync(path.join(wt, '.claude'), { recursive: true });
    // repoRootOf を使うと root が main になり、wt のファイルが root の外(`..`)に出てしまう
    expect(resolveDiffTarget(path.join(wt, '.claude', 'CLAUDE.md'), wt)).toEqual({
      root: fs.realpathSync(wt),
      relPath: '.claude/CLAUDE.md',
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
    // 読み取りの境界の中(プロジェクトの .claude 配下)に置く。境界の外は out-of-scope で弾かれる
    fs.mkdirSync(path.join(dir, '.claude', 'skills', 'a'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'skills', 'a', 'SKILL.md'), 'committed body\n');
    git('add', '.claude');
    git('commit', '-q', '-m', 'init');
    return dir;
  })();

  it('HEAD 時点の内容を返す(ワーキングツリーの変更は反映しない)', () => {
    fs.writeFileSync(path.join(repo, '.claude', 'skills', 'a', 'SKILL.md'), 'edited body\n');
    expect(previousContent(path.join(repo, '.claude', 'skills', 'a', 'SKILL.md'))).toEqual({
      available: true,
      previous: 'committed body\n',
    });
  });

  it('削除済みのファイルでも過去の内容が取れる', () => {
    const fp = path.join(repo, '.claude', 'skills', 'a', 'SKILL.md');
    const kept = fs.readFileSync(fp, 'utf8');
    fs.rmSync(fp);
    expect(previousContent(fp)).toEqual({ available: true, previous: 'committed body\n' });
    fs.writeFileSync(fp, kept);
  });

  it('HEAD に無い新規ファイルは no-history', () => {
    const fp = path.join(repo, '.claude', 'skills', 'a', 'new.md');
    fs.writeFileSync(fp, 'x');
    expect(previousContent(fp)).toEqual({ available: false, reason: 'no-history' });
  });

  it('.git 配下は git show まで届かない', () => {
    expect(() => previousContent(path.join(repo, '.git', 'x.md'))).toThrow(ApiError);
  });
});
