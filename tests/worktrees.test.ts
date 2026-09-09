/*
 * linked worktree の列挙と、それが切替・読み取り許可に効くこと(計画 16 Phase C)。
 *
 * worktree は「claude を起動して登録された」かつ「.claude/ に 1 件以上ある」ときしか
 * ~/.claude.json に出ないので、登録簿だけを候補にすると worktree の文脈が一切選べない。
 * 列挙は本体の `.git/worktrees/<name>/{gitdir,HEAD}` を読むだけで、git コマンドは呼ばない
 * (zero runtime dependency / サブプロセスを増やさない)。
 *
 * scan.ts が HOME を import 時に固定するので、HOME を差し替えてから動的 import する
 * (tests/session-context.test.ts と同じ流儀)。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { worktreesOf, worktreesForProjects } from '../src/server/memory';
import { projectSectionId } from '../src/server/scan';

/* `<main>/.git/worktrees/<name>/` に git が書くファイルを再現する */
function writeAdminDir(main: string, name: string, gitdir: string | null, head?: string) {
  const admin = path.join(main, '.git', 'worktrees', name);
  fs.mkdirSync(admin, { recursive: true });
  if (gitdir !== null) fs.writeFileSync(path.join(admin, 'gitdir'), gitdir + '\n');
  if (head !== undefined) fs.writeFileSync(path.join(admin, 'HEAD'), head + '\n');
}

describe('worktreesOf (.git/worktrees を読むだけで列挙する)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-worktrees-'));
  const main = path.join(root, 'repo');
  const alive = path.join(root, 'repo-feat-a');
  const detached = path.join(root, 'repo-detached');
  const gone = path.join(root, 'repo-gone'); // ディレクトリごと消された worktree

  beforeAll(() => {
    for (const d of [path.join(main, '.git'), alive, detached])
      fs.mkdirSync(d, { recursive: true });
    // worktree 側の .git はファイル(中身は管理ディレクトリへの gitdir:)
    for (const w of [alive, detached])
      fs.writeFileSync(
        path.join(w, '.git'),
        'gitdir: ' + path.join(main, '.git', 'worktrees', path.basename(w)) + '\n',
      );
    writeAdminDir(main, 'repo-feat-a', path.join(alive, '.git'), 'ref: refs/heads/feat/a');
    writeAdminDir(main, 'repo-detached', path.join(detached, '.git'), 'a'.repeat(40));
    writeAdminDir(main, 'repo-gone', path.join(gone, '.git'), 'ref: refs/heads/gone');
    writeAdminDir(main, 'repo-broken', null); // gitdir が無い(読めない)管理ディレクトリ
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('gitdir の指す .git の親が worktree のルートで、HEAD からブランチが付く', () => {
    const wt = worktreesOf(main).find((w) => w.name === 'repo-feat-a');
    expect(wt).toEqual({ path: alive, name: 'repo-feat-a', branch: 'feat/a' });
  });

  it('detached HEAD は branch を付けない(sha をブランチ名として出さない)', () => {
    const wt = worktreesOf(main).find((w) => w.name === 'repo-detached');
    expect(wt).toEqual({ path: detached, name: 'repo-detached' });
    expect(wt).not.toHaveProperty('branch');
  });

  it('消えた worktree の残骸と gitdir が読めないものは落とし、残りは返す', () => {
    // prune 前の gitdir(指す先が無い)と gitdir 自体が無い管理ディレクトリ。
    // 1 件の異常で一覧全体が空にならないことを固定する
    expect(worktreesOf(main).map((w) => w.name)).toEqual(['repo-detached', 'repo-feat-a']);
  });

  it('worktree が無いリポジトリ / git 管理外は空(.git/worktrees が無い)', () => {
    expect(worktreesOf(alive)).toEqual([]);
    expect(worktreesOf(root)).toEqual([]);
  });

  it('git コマンドを呼ばずに列挙する(実装が child_process を使っていない)', () => {
    const src = fs.readFileSync(
      path.join(import.meta.dirname, '..', 'src', 'server', 'memory.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/child_process/);
  });

  /*
   * gitdir の中身は clone に含まれるファイルなので、無検証で root にすると
   * 「任意のディレクトリを worktree として名乗る」ことができ、切替の候補
   * (= 読み取り許可の母集団)に入ってしまう。逆リンク(root/.git → この本体)を要求する。
   */
  it('逆リンクが無いディレクトリを指す gitdir は採らない', () => {
    const fake = path.join(root, 'not-a-worktree');
    fs.mkdirSync(fake, { recursive: true });
    fs.writeFileSync(path.join(fake, 'CLAUDE.md'), '# 誰かの別ディレクトリ');
    // git が作った worktree なら必ずある `<root>/.git`(gitdir: …)を置かない
    writeAdminDir(main, 'not-a-worktree', path.join(fake, '.git'), 'ref: refs/heads/x');
    expect(worktreesOf(main).map((w) => w.path)).not.toContain(fake);
    fs.rmSync(path.join(main, '.git', 'worktrees', 'not-a-worktree'), {
      recursive: true,
      force: true,
    });
  });

  it('別の本体を指し返す .git も採らない(逆リンク先が一致すること)', () => {
    const other = path.join(root, 'other-repo');
    const claimed = path.join(root, 'claimed');
    fs.mkdirSync(path.join(other, '.git', 'worktrees', 'claimed'), { recursive: true });
    fs.mkdirSync(claimed, { recursive: true });
    // claimed/.git は other-repo を指す = main の worktree ではない
    fs.writeFileSync(
      path.join(claimed, '.git'),
      'gitdir: ' + path.join(other, '.git', 'worktrees', 'claimed') + '\n',
    );
    writeAdminDir(main, 'claimed', path.join(claimed, '.git'), 'ref: refs/heads/x');
    expect(worktreesOf(main).map((w) => w.path)).not.toContain(claimed);
    fs.rmSync(path.join(main, '.git', 'worktrees', 'claimed'), { recursive: true, force: true });
  });

  it('gitdir / HEAD が数 KB を超えたら読まない(branch は先頭 1 行・128 文字まで)', () => {
    // 巨大な gitdir はその 1 件を落とす
    const big = path.join(root, 'repo-big');
    fs.mkdirSync(big, { recursive: true });
    writeAdminDir(main, 'repo-big', 'x'.repeat(5000));
    expect(worktreesOf(main).map((w) => w.name)).not.toContain('repo-big');
    fs.rmSync(path.join(main, '.git', 'worktrees', 'repo-big'), { recursive: true, force: true });
    // HEAD が読めない・長すぎる場合も worktree 自体は残す(ブランチ不明)
    const headFile = path.join(main, '.git', 'worktrees', 'repo-feat-a', 'HEAD');
    const orig = fs.readFileSync(headFile, 'utf8');
    fs.writeFileSync(headFile, 'ref: refs/heads/' + 'b'.repeat(9000));
    expect(worktreesOf(main).find((w) => w.name === 'repo-feat-a')).toEqual({
      path: alive,
      name: 'repo-feat-a',
    });
    // 長い(が上限内の)ブランチ名は 128 文字に切る
    fs.writeFileSync(headFile, 'ref: refs/heads/' + 'c'.repeat(300) + '\nゴミ行\n');
    expect(worktreesOf(main).find((w) => w.name === 'repo-feat-a')?.branch).toBe('c'.repeat(128));
    fs.writeFileSync(headFile, orig);
  });

  it('worktreesForProjects は登録簿を本体に畳んでから 1 回だけ列挙する(重複なし)', () => {
    // 同じリポジトリの本体・worktree・サブディレクトリが登録されていても結果は 1 組
    const found = worktreesForProjects([main, alive, path.join(main, 'sub')]);
    expect(found.map((w) => w.path)).toEqual([detached, alive]);
    expect(new Set(found.map((w) => w.mainPath))).toEqual(new Set([main]));
  });
});

/*
 * 切替の候補(?project= の解決)と selected.mainPath。worktree は登録の有無に依らず選べ、
 * 生のパスは相変わらず通らない(判断 2)。
 */
describe('worktree が切替の候補に入る(登録簿に無くても選べる)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-worktree-select-'));
  const home = path.join(root, 'home');
  const main = path.join(root, 'repo');
  const wt = path.join(root, 'repo-feat-a');
  const outside = path.join(root, 'other'); // 登録も worktree もされていないディレクトリ
  let mod: typeof import('../src/server/index');

  beforeAll(async () => {
    for (const d of [home, path.join(main, '.git'), wt, outside])
      fs.mkdirSync(d, { recursive: true });
    // 登録簿には本体だけ(worktree は claude を起動していないので登録されていない状態)
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [main]: {} } }));
    fs.writeFileSync(
      path.join(wt, '.git'),
      'gitdir: ' + path.join(main, '.git', 'worktrees', 'repo-feat-a') + '\n',
    );
    writeAdminDir(main, 'repo-feat-a', path.join(wt, '.git'), 'ref: refs/heads/feat/a');
    vi.resetModules();
    vi.stubEnv('HOME', home);
    mod = await import('../src/server/index');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('候補は登録簿 ∪ 列挙した worktree(未登録の worktree も id で選べる)', () => {
    expect(mod.projectCandidates(main)).toEqual(expect.arrayContaining([main, wt]));
    expect(mod.resolveSelectedProject(main, projectSectionId(wt))).toBe(wt);
  });

  it('候補に無いディレクトリの id と生のパスは従来どおり cwd に落ちる', () => {
    expect(mod.resolveSelectedProject(main, projectSectionId(outside))).toBe(main);
    expect(mod.resolveSelectedProject(main, wt)).toBe(main);
  });

  it('worktree を選ぶと selected.mainPath に本体が付く(本体を選んだときは付かない)', () => {
    const worktrees = mod.projectWorktrees(main);
    expect(worktrees).toEqual([
      { id: projectSectionId(wt), path: wt, name: 'repo-feat-a', branch: 'feat/a', mainPath: main },
    ]);
    const onWt = mod.selectedProject(main, wt, worktrees);
    expect(onWt.mainPath).toBe(main);
    expect(onWt.isCwd).toBe(false);
    expect(mod.selectedProject(main, main, worktrees)).not.toHaveProperty('mainPath');
  });

  it('worktree から起動したときは「現在」かつ本体つき(登録簿に本体しか無くても列挙できる)', () => {
    const onCwd = mod.selectedProject(wt, wt, mod.projectWorktrees(wt));
    expect(onCwd).toEqual({
      id: projectSectionId(wt),
      path: wt,
      name: 'repo-feat-a',
      isCwd: true,
      mainPath: main,
    });
  });
});

/*
 * 読み取り許可(判断 4、レビュー 1 周目で縮めた)。選べるのに CLAUDE.md が開けない状態を
 * 作らないため、**選んだ** worktree は母集団に入る。選んでいない worktree は入らない。
 */
describe('読み取り許可が「選んだ」worktree の CLAUDE.md を通す', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-worktree-access-'));
  const home = path.join(root, 'home');
  const main = path.join(root, 'repo');
  const wt = path.join(root, 'repo-feat-a');
  const outside = path.join(root, 'other');
  let mod: typeof import('../src/server/read-access');

  beforeAll(async () => {
    for (const d of [home, path.join(main, '.git'), wt, outside])
      fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [main]: {} } }));
    fs.writeFileSync(
      path.join(wt, '.git'),
      'gitdir: ' + path.join(main, '.git', 'worktrees', 'repo-feat-a') + '\n',
    );
    writeAdminDir(main, 'repo-feat-a', path.join(wt, '.git'), 'ref: refs/heads/feat/a');
    for (const d of [main, wt, outside]) fs.writeFileSync(path.join(d, 'CLAUDE.md'), '# ' + d);
    vi.resetModules();
    vi.stubEnv('HOME', home);
    mod = await import('../src/server/read-access');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('未登録の worktree でも、選べば CLAUDE.md を読める', () => {
    const fp = path.join(wt, 'CLAUDE.md');
    expect(mod.assertReadableMd(fp, main, wt)).toBe(fs.realpathSync(fp));
    expect(mod.assertOpenablePath(fp, main, wt)).toBe(fs.realpathSync(fp));
  });

  it('選んでいない worktree は読めない(本体を見ているだけでは開かない)', () => {
    expect(() => mod.assertReadableMd(path.join(wt, 'CLAUDE.md'), main)).toThrow(
      'not-readable-path',
    );
  });

  it('worktree でも登録済みでもないディレクトリは従来どおり拒む(母集団の上限)', () => {
    expect(() => mod.assertReadableMd(path.join(outside, 'CLAUDE.md'), main)).toThrow(
      'not-readable-path',
    );
  });

  it('AI に送ってよい集合は広がらない(CLAUDE.md 群は表示だけ)', () => {
    expect(() => mod.assertAiReadableMd(path.join(wt, 'CLAUDE.md'), main, wt)).toThrow(
      'not-readable-path',
    );
  });
});
