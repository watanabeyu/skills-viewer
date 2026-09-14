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

  /*
   * 上限まわりは 3 件に分ける(レビュー 2 周目)。1 件に同居していると、HEAD を差し替える
   * 途中で落ちたときに書き戻されず、後続の期待値が壊れて原因が読めなくなる。
   * HEAD を触るものは finally で必ず戻す。
   */
  it('数 KB を超える gitdir はその 1 件だけ落とす', () => {
    const big = path.join(root, 'repo-big');
    fs.mkdirSync(big, { recursive: true });
    writeAdminDir(main, 'repo-big', 'x'.repeat(5000));
    try {
      expect(worktreesOf(main).map((w) => w.name)).not.toContain('repo-big');
      // 他の worktree は巻き込まれない
      expect(worktreesOf(main).map((w) => w.name)).toContain('repo-feat-a');
    } finally {
      fs.rmSync(path.join(main, '.git', 'worktrees', 'repo-big'), { recursive: true, force: true });
    }
  });

  it('HEAD が読めない・長すぎても worktree 自体は残す(ブランチ不明)', () => {
    const headFile = path.join(main, '.git', 'worktrees', 'repo-feat-a', 'HEAD');
    const orig = fs.readFileSync(headFile, 'utf8');
    try {
      fs.writeFileSync(headFile, 'ref: refs/heads/' + 'b'.repeat(9000));
      expect(worktreesOf(main).find((w) => w.name === 'repo-feat-a')).toEqual({
        path: alive,
        name: 'repo-feat-a',
      });
    } finally {
      fs.writeFileSync(headFile, orig);
    }
  });

  it('長い(が上限内の)ブランチ名は先頭 1 行・128 文字に切る', () => {
    const headFile = path.join(main, '.git', 'worktrees', 'repo-feat-a', 'HEAD');
    const orig = fs.readFileSync(headFile, 'utf8');
    try {
      fs.writeFileSync(headFile, 'ref: refs/heads/' + 'c'.repeat(300) + '\nゴミ行\n');
      expect(worktreesOf(main).find((w) => w.name === 'repo-feat-a')?.branch).toBe('c'.repeat(128));
    } finally {
      fs.writeFileSync(headFile, orig);
    }
  });

  it('worktreesForProjects は登録簿を本体に畳んでから 1 回だけ列挙する(重複なし)', () => {
    // 同じリポジトリの本体・worktree・サブディレクトリが登録されていても結果は 1 組
    const found = worktreesForProjects([main, alive, path.join(main, 'sub')]);
    expect(found.map((w) => w.path)).toEqual([detached, alive]);
    expect(new Set(found.map((w) => w.mainPath))).toEqual(new Set([main]));
  });
});

/*
 * 相対パスで書かれた gitdir(レビュー 2 周目)。`git worktree add --relative-paths`(git 2.48+)や
 * worktree.useRelativePaths = true では、管理ディレクトリの gitdir も worktree 側の `.git` も
 * 相対パスになる。git はどちらも**その ファイルが置かれたディレクトリ**を起点に解決するので、
 * 本体(mainDir)起点で解決していると指す先が存在せず、その worktree が丸ごと落ちていた。
 */
describe('worktreesOf (相対パスで書かれた gitdir)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-worktrees-rel-'));
  const main = path.join(root, 'repo');
  const wt = path.join(root, 'wt-rel');

  beforeAll(() => {
    fs.mkdirSync(path.join(main, '.git'), { recursive: true });
    fs.mkdirSync(wt, { recursive: true });
    // `<main>/.git/worktrees/wt-rel/gitdir` から見た相対パス(4 つ上が root)
    writeAdminDir(main, 'wt-rel', '../../../../wt-rel/.git', 'ref: refs/heads/rel');
    // worktree 側の `.git` も相対(こちらは worktree のルートが起点)
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: ../repo/.git/worktrees/wt-rel\n');
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('管理ディレクトリを起点に解決する(本体起点だと 1 件も返らない)', () => {
    expect(worktreesOf(main)).toEqual([{ path: wt, name: 'wt-rel', branch: 'rel' }]);
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
      {
        id: projectSectionId(wt),
        mainId: projectSectionId(main),
        path: wt,
        name: 'repo-feat-a',
        branch: 'feat/a',
        mainPath: main,
      },
    ]);
    const onWt = mod.selectedProject(main, wt, worktrees);
    expect(onWt.mainPath).toBe(main);
    expect(onWt.isCwd).toBe(false);
    expect(mod.selectedProject(main, main, worktrees)).not.toHaveProperty('mainPath');
  });

  /*
   * 本体の id もサーバーが作る(判断 2: web はパスから id を組み立てない)。本体は登録簿に
   * 無い・定義 0 件で Section を持たないことがあり、そのとき web には本体を指す id が
   * 無かった ── 切替の本体の行も、ホームの worktree select の「本体」もこれで選ぶ。
   */
  it('worktree には本体の id(mainId)も付き、選んだときは selected にも入る', () => {
    const worktrees = mod.projectWorktrees(main);
    expect(worktrees[0].mainId).toBe(projectSectionId(main));
    expect(mod.selectedProject(main, wt, worktrees).mainId).toBe(projectSectionId(main));
    // 本体を選んだときは mainPath と同じく付かない(本体に本体は無い)
    expect(mod.selectedProject(main, main, worktrees)).not.toHaveProperty('mainId');
  });

  it('worktree から起動したときは「現在」かつ本体つき(登録簿に本体しか無くても列挙できる)', () => {
    const onCwd = mod.selectedProject(wt, wt, mod.projectWorktrees(wt));
    expect(onCwd).toEqual({
      id: projectSectionId(wt),
      path: wt,
      name: 'repo-feat-a',
      isCwd: true,
      mainPath: main,
      mainId: projectSectionId(main),
    });
  });

  /*
   * 候補メモの鍵に worktree 一覧の版が入っていること(レビュー 3 周目)。
   * `git worktree add` は ~/.claude.json を触らないので、鍵が登録簿だけだと
   * 「新しく作った worktree」がリロードしても候補に出ず、C が救おうとした未登録 worktree の
   * 入口をメモが塞いでしまう(README の「再読み込みで再スキャン」とも食い違う)。
   * 先に 1 回呼んでメモを温めてから作る ── 直前のテストが別の cwd で温めていても効くように。
   */
  it('登録簿を動かさずに worktree を足しても、次の呼び出しで候補に出る', () => {
    const added = path.join(root, 'repo-feat-b');
    expect(mod.projectCandidates(main)).not.toContain(added); // ここでメモが温まる
    fs.mkdirSync(added, { recursive: true });
    fs.writeFileSync(
      path.join(added, '.git'),
      'gitdir: ' + path.join(main, '.git', 'worktrees', 'repo-feat-b') + '\n',
    );
    writeAdminDir(main, 'repo-feat-b', path.join(added, '.git'), 'ref: refs/heads/feat/b');
    expect(mod.projectCandidates(main)).toContain(added);
    expect(mod.projectWorktrees(main).map((w) => w.path)).toContain(added);
  });
});

/*
 * 逆引きした本体も候補に入る(C2)。worktree でしか claude を起動していないと本体は登録簿に
 * 出ないので、「worktree は選べるのに本体は選べない」= 切替に本体の行が出せず、その本体に
 * ぶら下がる worktree ごと UI から辿れなくなる。増えるのは列挙済み worktree の本体だけで、
 * 生のパスは相変わらず通らない(母集団は「cwd と選んだプロジェクト」のまま)。
 */
describe('worktree から逆引きした本体も切替の候補に入る', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-worktree-main-'));
  const home = path.join(root, 'home');
  const main = path.join(root, 'repo'); // 登録簿には無い(ここで claude を起動していない)
  const wt = path.join(root, 'repo-feat-a');
  const outside = path.join(root, 'other');
  let mod: typeof import('../src/server/index');

  beforeAll(async () => {
    for (const d of [home, path.join(main, '.git'), wt, outside])
      fs.mkdirSync(d, { recursive: true });
    // 登録簿には worktree だけ(本体は一度も起動していない)
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [wt]: {} } }));
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

  it('登録簿に無い本体でも、その id で選べる(候補は worktree の mainPath も含む)', () => {
    expect(mod.projectCandidates(wt)).toEqual(expect.arrayContaining([wt, main]));
    expect(mod.resolveSelectedProject(wt, projectSectionId(main))).toBe(main);
    // 本体の id は列挙した worktree にも入っている(web はこれを使う)
    expect(mod.projectWorktrees(wt)[0].mainId).toBe(projectSectionId(main));
  });

  it('worktree にも本体にも当たらないディレクトリは従来どおり cwd に落ちる', () => {
    expect(mod.resolveSelectedProject(wt, projectSectionId(outside))).toBe(wt);
    expect(mod.resolveSelectedProject(wt, main)).toBe(wt); // 生のパスは通らない
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

/*
 * 未登録の worktree を選んだときの走査(レビュー 2 周目の指摘 C の抜け)。
 * `?project=` の候補は「登録簿 ∪ 列挙した worktree」なのに、走査(scanSections)は登録簿しか
 * 見ていなかったので、`.claude/` を git 追跡している worktree を選ぶと ③ が必ず 0 件になり、
 * 「このプロジェクトには定義が無い」という嘘の理由まで出ていた。
 * 走査対象を「登録簿 ∪ 選んだプロジェクト」にすることで塞ぐ(読み取り許可の母集団は
 * 元から {cwd, 選択} なので広がらない)。
 */
describe('未登録の worktree を選ぶと、その .claude も走査される', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-worktree-scan-'));
  const home = path.join(root, 'home');
  const main = path.join(root, 'repo'); // cwd かつ唯一の登録済みプロジェクト
  const wt = path.join(root, 'repo-feat-a'); // 登録簿に無い worktree
  let mod: typeof import('../src/server/index');
  /* ① の基準(snapshot.json)は差し替えた HOME 配下に置かれる。HOME を stub した後で読み込む */
  let snap: typeof import('../src/server/snapshot');

  const skill = (dir: string, name: string) => {
    fs.mkdirSync(path.join(dir, '.claude', 'skills', name), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.claude', 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} を使うとき\n---\n本文\n`,
    );
  };

  beforeAll(async () => {
    for (const d of [home, path.join(main, '.git'), wt]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [main]: {} } }));
    fs.writeFileSync(
      path.join(wt, '.git'),
      'gitdir: ' + path.join(main, '.git', 'worktrees', 'repo-feat-a') + '\n',
    );
    writeAdminDir(main, 'repo-feat-a', path.join(wt, '.git'), 'ref: refs/heads/feat/a');
    skill(main, 'main-skill');
    // worktree 側は 2 件。選択で ③ の件数が 1 件分ではなく 2 件分入れ替わることを見る
    skill(wt, 'wt-skill');
    skill(wt, 'wt-skill2');
    vi.resetModules();
    vi.stubEnv('HOME', home);
    mod = await import('../src/server/index');
    snap = await import('../src/server/snapshot');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('選ぶと Section が出て、② の description 件数にも乗る', () => {
    const onMain = mod.collect(main, 'en', null);
    const onWt = mod.collect(main, 'en', projectSectionId(wt));
    const sec = onWt.sections.find((s) => s.id === projectSectionId(wt));
    expect(sec?.items.map((it) => it.name).sort()).toEqual(['wt-skill', 'wt-skill2']);
    expect(sec?.isCurrent).toBeFalsy(); // 「現在」は cwd の印のまま(選択とは別)
    // 母集団が本体(1 件)から worktree(2 件)に入れ替わるので、件数は 1 増える
    expect(onWt.context.descriptions.count).toBe(onMain.context.descriptions.count + 1);
    expect(onWt.context.descriptions.tok).toBeGreaterThan(0);
  });

  it('選んでいなければ Section は出ない(走査対象は登録簿のまま)', () => {
    const onMain = mod.collect(main, 'en', null);
    expect(onMain.sections.map((s) => s.id)).not.toContain(projectSectionId(wt));
    expect(onMain.sections.find((s) => s.id === projectSectionId(main))?.items).toHaveLength(1);
  });

  /*
   * ①(前回からの変化)の入力は cwd 起点に揃えること(collect の trackedSections)。
   * 選択で足した Section を入れたままにすると、「既読にする」(/api/changes-ack は cwd 起点で
   * 走査する)を押しても消えない差分になる ── 逆に常に外すと、登録済みプロジェクトの追加が
   * ① に出なくなる。両方向を固定する(レビュー 3 周目: どちらに壊しても全テストが緑だった)。
   * 基準は先に 1 回 collect して現在の cwd 起点に揃えてから見る(テストの実行順に依らないように)。
   */
  const changedPaths = (ch: import('../src/shared/types').SnapshotChanges | null | undefined) =>
    [...(ch?.added || []), ...(ch?.updated || []), ...(ch?.removed || [])].map((e) => e.path);

  it('未登録の worktree を選んでも ① にその skill は出ない(既読にできない差分を作らない)', () => {
    mod.collect(main, 'en', null);
    const paths = changedPaths(mod.collect(main, 'en', projectSectionId(wt)).changes);
    for (const name of ['wt-skill', 'wt-skill2'])
      expect(paths).not.toContain(path.join(wt, '.claude', 'skills', name, 'SKILL.md'));
  });

  it('登録済みプロジェクト(cwd)の追加は ① に出て、既読にすると消える', () => {
    mod.collect(main, 'en', null);
    skill(main, 'main-skill2');
    const added = path.join(main, '.claude', 'skills', 'main-skill2', 'SKILL.md');
    expect(changedPaths(mod.collect(main, 'en', projectSectionId(main)).changes)).toContain(added);
    // 「既読にする」= POST /api/changes-ack と同じ入力で基準を更新する
    const inp = mod.changeInputs(main, 'en', mod.projectCandidates(main));
    snap.ackChanges(inp.sections, inp.memory, inp.claudeMd);
    expect(mod.collect(main, 'en', projectSectionId(main)).changes).toBeNull();
  });
});
