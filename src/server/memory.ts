/*
 * Claude Code の自動メモリ(~/.claude/projects/<encoded>/memory/*.md)のスキャン。
 * MEMORY.md が索引(毎セッション全件注入)、各 *.md が本文(Read されたときだけ読まれる)。
 * skills-viewer は memory に対して完全読み取り専用。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MemorySection, MemoryType, SkillItem } from '../shared/types';
import { estimateTokens } from './lint';
import { HOME, firstBodyLine, listProjects, parseFrontmatter } from './scan';
import { extractSignals } from './memory-signals';
import { encodeProjectPath, hasTranscripts } from './usage';

export interface MemoryScanOptions {
  /* ~/.claude/projects 相当のルート(テストで差し替える) */
  root?: string;
  /* 逆引きに使うプロジェクトパス一覧(テストで差し替える) */
  projects?: string[];
  /* メインワークツリーの実パス(テストで差し替える)。既定は mainWorktreeOf(cwd) */
  mainWorktree?: string | null;
  /*
   * settings.json の autoMemoryDirectory の解決結果(テストで差し替える)。
   * undefined = resolveAutoMemoryDir(cwd) で実解決、null = 無効(この設定は無いものとして扱う)
   */
  autoMemoryDir?: AutoMemoryDirInfo | null;
}

/*
 * `.git` 側の管理ファイル(worktree の `.git` ファイル・`.git/worktrees/<name>/{gitdir,HEAD}`)を
 * 読む上限。中身はパス 1 行 / ref 1 行で数十バイトしかない。ここを無制限に読むと、リポジトリを
 * clone しただけで巨大なファイルを毎リクエスト読まされる(claude-md.ts の MAX_FILE_BYTES と同じ趣旨)。
 */
const MAX_GIT_META_BYTES = 4 * 1024;

/* 管理ファイルを 1 つ読む。無い・大きすぎる・読めないは null(その 1 件だけスキップさせる) */
function readGitMeta(fp: string): string | null {
  try {
    if (fs.statSync(fp).size > MAX_GIT_META_BYTES) return null;
    return fs.readFileSync(fp, 'utf8');
  } catch {
    return null;
  }
}

/*
 * dir が属する git のメインワークツリーのルート。git コマンドは呼ばず .git だけを見る。
 *   - `<dir>/.git` がディレクトリ = 通常のリポジトリなので dir 自身
 *   - `<dir>/.git` がファイル = worktree。中身の `gitdir: <p>` が
 *     `…/.git/worktrees/<name>` ならその 3 つ上がメインワークツリーのルート
 * それ以外(submodule の gitdir、.git が無い、読めない)は null。
 *
 * `.git` ファイルの読み取りは readGitMeta に寄せる(レビュー 2 周目): この関数は worktreesOf の
 * 逆リンク検証から「clone に含まれるファイル」に対して呼ばれる ── 外から届く側なので、
 * 上限なしの readFileSync だと巨大な `.git` ファイルを毎リクエスト丸ごと読むことになる。
 */
export function mainWorktreeOf(dir: string): string | null {
  const gitPath = path.join(dir, '.git');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(gitPath);
  } catch {
    return null; // git 管理下でないディレクトリ
  }
  if (stat.isDirectory()) return path.resolve(dir);
  const raw = readGitMeta(gitPath);
  if (raw === null) return null;
  const m = raw.match(/^gitdir:\s*(.+)$/m);
  if (!m) return null;
  const gitdir = m[1].trim();
  // linked worktree の gitdir だけを対象にする(submodule の .git ファイルも同じ形式なので形で弾く)
  if (!/(?:^|[/\\])\.git[/\\]worktrees[/\\][^/\\]+[/\\]?$/.test(gitdir)) return null;
  // git は通常フルパスを書くが、相対で書かれていても壊れないよう dir を起点に解決する
  return path.resolve(dir, gitdir, '..', '..', '..');
}

/* 本体(メインワークツリー)に紐づく linked worktree 1 件。web と共有しないので型はここに置く */
export interface WorktreeEntry {
  /* worktree のルート(gitdir に書かれた `.git` の親) */
  path: string;
  /* path の basename(表示用) */
  name: string;
  /* チェックアウト中のブランチ。detached HEAD では付かない */
  branch?: string;
}

/*
 * mainDir に紐づく linked worktree の一覧。mainWorktreeOf と同じ流儀で git コマンドは呼ばず、
 * `<mainDir>/.git/worktrees/<name>/` のファイルだけを読む(git が書いた事実そのもの)。
 *   - gitdir: worktree 側の `.git` のパス。その親ディレクトリが worktree のルート
 *   - HEAD:   `ref: refs/heads/<branch>`(detached なら sha なので branch は付けない)
 * 消した worktree の残骸(prune 前は gitdir が残る)は実体が無いので落とす。
 * 読めない・形が違うものはその 1 件だけスキップする(一覧全体を落とさない)。
 *
 * gitdir の中身は検証してから採る(レビュー 1 周目): 中身は「clone したリポジトリに入っていた
 * ファイル」なので、任意のディレクトリを指す gitdir を書けば、そこが worktree として列挙され
 * 切替の候補(= 読み取り許可の母集団)に入ってしまう。git が実際に作った worktree なら
 * 逆リンク(`<root>/.git` がこの mainDir の管理ディレクトリを指す)が必ずあるので、
 * mainWorktreeOf(root) が mainDir に戻ることを確かめる。
 * branch も同じ理由で先頭 1 行・128 文字に切る(HEAD は 1 行のファイルで、長い ref 名は無い)。
 */
export function worktreesOf(mainDir: string): WorktreeEntry[] {
  const base = path.join(mainDir, '.git', 'worktrees');
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return []; // worktree が 1 つも無ければこのディレクトリ自体が無い(通常の状態)
  }
  const mainAbs = path.resolve(mainDir);
  const out: WorktreeEntry[] = [];
  for (const d of dirs) {
    const admin = path.join(base, d.name);
    const gitdir = readGitMeta(path.join(admin, 'gitdir'))?.trim();
    if (!gitdir) continue; // gitdir が無い / 読めない / 大きすぎる管理ディレクトリ
    /*
     * git は通常フルパスを書くが、`git worktree add --relative-paths`(git 2.48+)や
     * worktree.useRelativePaths=true では相対パスを書く。git はそれを**この管理ディレクトリ**
     * (`<main>/.git/worktrees/<name>`)を起点に解決するので、こちらも同じ起点で解決する
     * ── 本体(mainDir)起点だと解決先が存在せず、相対で書かれた worktree が丸ごと落ちる。
     */
    const root = path.dirname(path.resolve(admin, gitdir));
    try {
      if (!fs.statSync(root).isDirectory()) continue;
    } catch {
      continue; // ディレクトリごと消された worktree(git worktree prune 前の残骸)
    }
    // 逆リンクの検証。realDir も見るのは /tmp → /private/var のような symlink 経由でも同じ答えにするため
    const back = mainWorktreeOf(root);
    if (!back || !(samePath(back, mainAbs) || samePath(realDir(back), realDir(mainAbs)))) continue;
    let branch: string | undefined;
    const head = readGitMeta(path.join(admin, 'HEAD'));
    const m = head
      ?.split('\n', 1)[0]
      .trim()
      .match(/^ref:\s*refs\/heads\/(.+)$/);
    if (m) branch = m[1].trim().slice(0, 128);
    out.push({ path: root, name: path.basename(root), ...(branch ? { branch } : {}) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/*
 * 登録済みプロジェクト群から辿れる linked worktree(重複なし。計画 16 判断 5)。
 * 登録簿にはリポジトリのサブディレクトリや worktree 自身も入るので、まず repoRootOf で本体へ
 * 畳んでから本体ごとに 1 回だけ列挙する(同じ本体を登録の数だけ readdir しない)。
 * 列挙の起点は登録簿に閉じており、各 worktree は worktreesOf が逆リンクを検証して採るので、
 * 「gitdir に書いた任意のパス」がここから増えることはない(レビュー 1 周目で検証を足した。
 * それまでは gitdir の指す先を無検証で root にしていた)。
 */
export function worktreesForProjects(projects: string[]): (WorktreeEntry & { mainPath: string })[] {
  const mains = new Set<string>();
  for (const p of projects) {
    const main = repoRootOf(p);
    if (main) mains.add(main);
  }
  const out: (WorktreeEntry & { mainPath: string })[] = [];
  const seen = new Set<string>();
  for (const main of [...mains].sort()) {
    for (const wt of worktreesOf(main)) {
      if (seen.has(wt.path)) continue; // 同じ worktree に 2 つの本体から辿り着くことは無いが念のため
      seen.add(wt.path);
      out.push({ ...wt, mainPath: main });
    }
  }
  return out;
}

/*
 * dir が属するリポジトリのルート(memory の slug を決める単位)。mainWorktreeOf が
 * 非 null を返すまで path.dirname で親へ遡り、ルートまで見つからなければ null。
 * なぜ遡るか: ~/.claude.json には「リポジトリのサブディレクトリ」(例 ~/repo/frontend。
 * 自分の .git を持たない)が普通に登録される一方、memory はリポジトリから導出されて
 * サブディレクトリ間で共有される。登録パスをそのまま slug 化すると実在しない移動先になる。
 */
export function repoRootOf(dir: string): string | null {
  let cur = path.resolve(dir);
  for (;;) {
    const main = mainWorktreeOf(cur);
    if (main) return main;
    // .git があるのに mainWorktreeOf が null(submodule の gitdir 等)なら、そこも
    // リポジトリ境界として遡上を止める(submodule は別リポジトリなので、
    // 親リポジトリの memory に誤って束ねない)
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null; // ファイルシステムのルートまで .git が無かった
    cur = parent;
  }
}

/*
 * fp を実際に含んでいる git のワークツリーのルート(= `.git` を持つ最も近い祖先)。
 * repoRootOf との違いは linked worktree の扱いで、こちらは worktree 自身を返す。
 * `git -C <ここ> log/show` は「そのファイルが今いるワークツリーの HEAD」を見るので、
 * ファイルの履歴を引く用途(差分追跡の誰が・いつ / GET /api/diff)ではこちらが正しい
 * (repoRootOf はメインワークツリーへ寄せるため、worktree 内のファイルが root の外に出る)。
 * 見つからなければ null(git 管理外)。
 */
export function worktreeRootOf(dir: string): string | null {
  let cur = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/*
 * settings.json の `autoMemoryDirectory`(公式仕様)を解決する。設定すると自動メモリの置き場が
 * 丸ごと変わり、~/.claude/projects/<project>/memory/ には何も作られなくなるため、
 * この設定が無いと memory が 1 件も見えない環境が生まれる。
 *
 * 読む順(優先度高い順、hooks 設定(scanHooks)と同じ readFileSync + JSON.parse の流儀):
 *   1. <cwd>/.claude/settings.local.json
 *   2. <cwd>/.claude/settings.json
 *   3. <メインワークツリー>/.claude/settings.local.json(cwd と異なるときだけ)
 *   4. 同 settings.json
 *   5. <home>/.claude/settings.json
 * cwd 側を先に見るのは、Claude Code の settings が「起動ディレクトリ」基準だから
 * (worktree から起動した場合、その worktree の settings.local.json が実際に効く)。
 * cwd 側に無ければメインワークツリー側も見る(memory はリポジトリ単位で共有されるため)。
 * 値は絶対パスか `~/` 始まりのみ有効(公式仕様どおり)。相対パスや不正 JSON はスキップして次を試す。
 * 解決した値は path.resolve で正規化し、過大な指定(ルート / HOME 自身 / HOME の祖先)は無効にする。
 */
function readAutoMemoryDirectory(fp: string, home: string): string | null {
  let cfg: any;
  try {
    cfg = JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
  const v = cfg?.autoMemoryDirectory;
  if (typeof v !== 'string' || !v) return null;
  // 相対パスは公式仕様上無効
  const raw = v.startsWith('~/') ? path.join(home, v.slice(2)) : path.isAbsolute(v) ? v : null;
  if (!raw) return null;
  // `..` や末尾のスラッシュを畳む: この値は読み取り許可(read-access.ts の前方一致)と usage の
  // 許可ルートにそのまま使われるので、表記の揺れが判定の揺れになる
  const dir = path.resolve(raw);
  /*
   * 過大な指定は「設定なし」として捨てる。ファイルシステムのルート / HOME 自身 / HOME の祖先を
   * 置き場にすると、上記 2 つの許可がホーム配下(実質全体)まで広がり、「memory の置き場」という
   * 限定が意味を失う(公式仕様にもそんな運用は無い)。
   * 比較は実パス(realDir)同士で行う: 表記だけ見ると HOME と別物でも、symlink 経由で
   * HOME(やその祖先)を指す値はガードを素通りしてしまうため。
   */
  // ケース非依存 FS では case-fold して比較する(realpathSync がケースを畳まないため、
  // `/USERS/<user>` のような HOME のケース違いがこのガードを素通りするのを防ぐ)
  const dirReal = realDir(dir);
  const homeReal = realDir(home);
  if (samePath(dirReal, path.parse(dirReal).root)) return null;
  if (isUnder(homeReal, dirReal)) return null; // dir が HOME 自身 / HOME の祖先
  // 返すのは正規化しただけの値(実パスに置き換えない): 表示・重複判定は既に realDir を通す
  return dir;
}

/*
 * 設定の出どころ。user scope の設定は「全プロジェクトが 1 つの置き場を共有する」ことを意味し、
 * その置き場の memory はどのプロジェクトのものか特定できない(公式仕様)。
 */
export type AutoMemoryScope = 'local' | 'project' | 'user';
export interface AutoMemoryDirInfo {
  /* 解決済みの絶対パス(`~/` は home 展開済み) */
  dir: string;
  scope: AutoMemoryScope;
}

export function autoMemoryDirOf(cwd: string, home: string = HOME): AutoMemoryDirInfo | null {
  const cwdResolved = path.resolve(cwd);
  const main = mainWorktreeOf(cwd);
  const bases = [cwdResolved, ...(main && main !== cwdResolved ? [main] : [])];
  const candidates: { file: string; scope: AutoMemoryScope }[] = [];
  for (const base of bases) {
    candidates.push({ file: path.join(base, '.claude', 'settings.local.json'), scope: 'local' });
    candidates.push({ file: path.join(base, '.claude', 'settings.json'), scope: 'project' });
  }
  candidates.push({ file: path.join(home, '.claude', 'settings.json'), scope: 'user' });
  for (const c of candidates) {
    const dir = readAutoMemoryDirectory(c.file, home);
    if (dir) return { dir, scope: c.scope };
  }
  return null;
}

/*
 * 解決済みの autoMemoryDirectory。解決関数はこの 1 本に集約する: スキャン(scanMemory)・
 * 読み取り許可(read-access.ts)・棚卸し(memory-triage.ts)が別々に解決すると、
 * 「一覧には出るが本文は開けない」のような食い違いが生まれるため。
 * settings 3〜5 ファイルの読み取りは cwd ごとに 1 回だけにする(スキャンのたびには読まない)。
 * 起動中に settings を書き換えた場合は再起動が要る。
 */
const autoDirMemo = new Map<string, AutoMemoryDirInfo | null>();
export function resolveAutoMemoryDir(cwd: string = process.cwd()): AutoMemoryDirInfo | null {
  const key = path.resolve(cwd);
  if (!autoDirMemo.has(key)) autoDirMemo.set(key, autoMemoryDirOf(key));
  return autoDirMemo.get(key) ?? null;
}

/*
 * web へ返す直前に、サーバー内部でしか使わないフィールドを memory セクションから落とす。
 *   - otherProjects: wrong-project の候補算出(triageProject)専用。web には参照が無く、
 *     セクション × 登録プロジェクト数だけ payload を膨らませるだけ
 *   - transcriptSlug: usageAvailable の判定(attributeMemoryUsage)専用。結果は usageAvailable
 *     に畳まれており、web は slug 自体を使わない
 * /api/memory-triage は自前で再スキャンするので影響しない。
 */
export function publicMemory(memory: MemorySection[]): MemorySection[] {
  return memory.map((sec) => {
    const out = { ...sec };
    delete out.otherProjects;
    delete out.transcriptSlug;
    return out;
  });
}

/*
 * そのセクションの Read / Write 実績を「測れる環境か」(usageAvailable)。
 * 実績の付与そのものは index.ts(attributeMemoryUsage)が行うが、判定だけはテストできるよう
 * ここに純関数で置く。
 *   - 既定・帰属ありのセクション: そのプロジェクト(worktree 含む)の transcript があるか。
 *     無ければ「Read 0 = 読まれていない」が言えないので列ごと出さない
 *   - 共有ストア(sharedStore): どのプロジェクトのセッションが読んだかは決まらないが、
 *     scanMemoryUsage は全プロジェクトの transcript を横断して置き場配下の Read / Write を
 *     file_path で拾っている。つまり実績は「全プロジェクト合算」の事実として本物なので、
 *     判定も全体の transcript の有無で行う(1 件も無ければ測れない、で従来どおり false)
 */
export function usageAvailableFor(sec: MemorySection, dirsWithTranscripts: Set<string>): boolean {
  if (sec.sharedStore) return dirsWithTranscripts.size > 0;
  return hasTranscripts(dirsWithTranscripts, sec.transcriptSlug ?? sec.id);
}

const MEMORY_TYPES: MemoryType[] = ['user', 'feedback', 'project', 'reference'];

/* frontmatter は 2 形式が混在する: トップレベル `type:` と `metadata:` 配下のネスト */
function metaValue(meta: Record<string, string>, key: string): string {
  return meta[key] || meta['metadata.' + key] || '';
}

function memoryTypeOf(meta: Record<string, string>): MemoryType | undefined {
  const v = metaValue(meta, 'type');
  return (MEMORY_TYPES as string[]).includes(v) ? (v as MemoryType) : undefined;
}

/* 本文中の [[x]] 参照(重複排除。名前 / ファイル名どちらの表記かは web 側で解決する) */
function extractLinks(body: string): string[] {
  const links = new Set<string>();
  // 文字クラスは web 側の renderMemoryBody と同一にする(片方だけ [[a[[b]] を拾う差を作らない)
  for (const m of body.matchAll(/\[\[([^\][]+)\]\]/g)) {
    const name = m[1].trim();
    if (name) links.add(name);
  }
  return [...links];
}

/*
 * MEMORY.md は毎セッションの先頭 200 行 or 25KB(先に達した方)までしか読まれない(公式仕様)。
 * その境界を超える索引行は「書いてあっても実際には注入されない」ため、常時コストに数えない。
 */
const INDEX_MAX_LINES = 200;
const INDEX_MAX_BYTES = 25 * 1024;

interface IndexEntry {
  line: string;
  /* この行の(ファイル全体基準の)行番号 */
  lineNumber: number;
  /* 200 行 / 25KB の上限外か */
  beyondLimit: boolean;
}

/*
 * MEMORY.md(索引)を「本文ファイル名 → 索引行」の Map にする。
 * 索引行は `- [title](file.md) — desc` 形式で、リンク先ファイル名が本文と対応する。
 * 併せて行番号・改行込みの累積 UTF-8 バイト数を数え、読み込み上限の内外を判定する。
 */
function readIndex(memDir: string): Map<string, IndexEntry> {
  const map = new Map<string, IndexEntry>();
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(memDir, 'MEMORY.md'), 'utf8');
  } catch {
    return map; // 索引が無い/読めない場合は索引行なし(indexTokens = 0)として扱う
  }
  // \n だけで分割する: CRLF の行には末尾の \r が残るので、改行 1 バイトを足すと自然に +2 になり、
  // Claude Code が読むバイト数と一致する(\r?\n で割ると CR の分を数え落とす)
  const lines = raw.split('\n');
  let bytes = 0;
  lines.forEach((line, i) => {
    bytes += Buffer.byteLength(line, 'utf8') + 1; // 改行 1 バイト
    const m = line.match(/\(([^()]+\.md)\)/);
    if (m) {
      const lineNumber = i + 1;
      const file = path.basename(m[1]);
      // 同じファイルの索引行が複数あるときは上限内の行を優先する
      // (実際に毎セッション注入されているのはそちらで、常時コストの真実源になる)
      const prev = map.get(file);
      if (prev && !prev.beyondLimit) return;
      map.set(file, {
        line: line.trim(),
        lineNumber,
        beyondLimit: lineNumber > INDEX_MAX_LINES || bytes > INDEX_MAX_BYTES,
      });
    }
  });
  return map;
}

function readMemoryFile(
  fp: string,
  fileName: string,
  indexEntry: IndexEntry | undefined,
  projectPath: string | null,
  otherProjects: string[],
): SkillItem | null {
  let raw: string;
  try {
    raw = fs.readFileSync(fp, 'utf8');
  } catch {
    return null; // 読めないファイルはスキップ(一覧全体を落とさない)
  }
  const { meta, body } = parseFrontmatter(raw);
  const type = memoryTypeOf(meta);
  const originSessionId = metaValue(meta, 'originSessionId');
  let updatedAt = 0;
  try {
    updatedAt = fs.statSync(fp).mtimeMs;
  } catch {
    /* mtime が取れなくても一覧には出す */
  }
  // v2.1.214+ は書き込み時に frontmatter へ `modified`(ISO 8601)を刻む。mtime はコピー・同期・
  // チェックアウトで簡単に狂うが、modified は Claude Code 自身が書いた事実なので優先する
  const modifiedRaw = metaValue(meta, 'modified');
  // 形式ガード: Date.parse は "5"(= 2001-05-01 等)や "2026"(年だけ)も通してしまい、
  // 桁の違う値を掴むと「最終更新」が何十年もずれる。日付部分の形が合う値だけを採る。
  // 未来日(1 日以上先)は時計ずれ・手書きの誤りなので不採用にして mtime に戻す
  if (/^\d{4}-\d{2}-\d{2}([T ]|$)/.test(modifiedRaw)) {
    const parsed = Date.parse(modifiedRaw);
    if (!Number.isNaN(parsed) && parsed > 0 && parsed <= Date.now() + 86400000) updatedAt = parsed;
  }
  const description = meta.description || firstBodyLine(body);
  // 鮮度の機械シグナル(テキスト / fs 層)。正規表現と existsSync だけなのでスキャン時に払える
  const bodyTokens = estimateTokens(raw);
  const signals = extractSignals(body, description, projectPath, {
    memoryType: type,
    bodyTokens,
    otherProjects,
  });
  if (indexEntry?.beyondLimit)
    signals.push({ kind: 'index-beyond-limit', value: String(indexEntry.lineNumber) });
  return {
    name: meta.name || fileName.replace(/\.md$/, ''),
    description,
    argumentHint: '',
    version: '',
    kind: 'memory',
    path: fp,
    updatedAt,
    files: [],
    // 索引行だけが毎セッション注入される。本文は Read されたときだけのコストなので分けて持つ
    indexTokens: indexEntry ? estimateTokens(indexEntry.line) : 0,
    ...(indexEntry ? { indexLine: indexEntry.line } : {}),
    ...(indexEntry?.beyondLimit ? { indexBeyondLimit: true } : {}),
    bodyTokens,
    ...(type ? { memoryType: type } : {}),
    ...(originSessionId ? { originSessionId } : {}),
    links: extractLinks(body),
    ...(signals.length ? { signals } : {}),
  };
}

/*
 * p が projectPath と「同じもの」と見なせる関係か(= 別の登録プロジェクトの候補から外す)。
 * 自分自身 / worktree 同士 / 入れ子(親子)。親の memory が子の配下パスに触れるだけで
 * wrong-project 経路に乗るのを防ぐ。既定セクションと autoDir セクションで同じ規則を使うため
 * 1 箇所に置く(除外規則を 2 箇所に書かない)。
 */
function isRelatedProject(
  p: string,
  projectPath: string,
  pMain: string | null,
  mainOf: (x: string) => string | null,
): boolean {
  if (p === projectPath) return true;
  if (pMain === projectPath || mainOf(projectPath) === p) return true;
  return p.startsWith(projectPath + path.sep) || projectPath.startsWith(p + path.sep);
}

/*
 * autoMemoryDirectory はユーザー / リポジトリが任意のディレクトリを指せるため、巨大な置き場を
 * 指されると単一スレッドのサーバーが毎 GET でブロックする。件数と 1 ファイルのサイズに上限を置く。
 * 超過分は黙って落とす(件数を画面へ伝える仕様は無い)。
 */
const AUTO_DIR_MAX_FILES = 500;
const AUTO_FILE_MAX_BYTES = 1024 * 1024;

/*
 * 重複セクション判定用の正規化。symlink 経由で同じディレクトリを指した設定
 * (例: ~/mem → ~/.claude/projects/<slug>/memory)を「別の場所」と誤認しないよう実パスで比べる。
 * 実パスが取れない(存在しない・権限が無い)場合は path.resolve で代用する。
 * 設定値の過大指定ガード(readAutoMemoryDirectory)と usage の許可ルート(index.ts)も
 * 同じ写像を通す: 実パスで見るかどうかが場所ごとに違うと、許可と判定がずれる。
 */
export function realDir(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/*
 * パス比較の正規化。macOS / Windows のファイルシステムはケース非依存だが、
 * fs.realpathSync はケースを畳まない(`/USERS/x` はそのまま `/USERS/x` を返す)ため、
 * 素の文字列比較だと `/Users/x` と `/USERS/x` を別物と誤判定する。読み取り許可・下限ガードの
 * ような「同じディレクトリか / 配下か」の判定は、これらの OS では case-fold して比べる。
 */
const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';
export function samePath(a: string, b: string): boolean {
  return CASE_INSENSITIVE_FS ? a.toLowerCase() === b.toLowerCase() : a === b;
}
export function isUnder(child: string, parent: string): boolean {
  const c = CASE_INSENSITIVE_FS ? child.toLowerCase() : child;
  const p = CASE_INSENSITIVE_FS ? parent.toLowerCase() : parent;
  return c === p || c.startsWith(p + path.sep);
}

/*
 * 列挙の起点は ~/.claude/projects/<encoded>/memory の走査(~/.claude.json の一覧ではない)。
 * memory はリポジトリ単位で、worktree 用のディレクトリは作られないため、
 * 見つけたディレクトリ名を listProjects() のエンコード名で逆引きし、
 * 引けないものはプロジェクト不明(削除済み/リネーム済みプロジェクト)として表示する。
 *
 * worktree から起動したときは memory が親リポジトリ側にあるため、cwd 完全一致だけでは
 * current が 1 件も無くなる。メインワークツリーも current 扱いにし、逆引き用の一覧にも足す
 * (~/.claude.json に親が登録されていなくても projectPath を引けるように)。
 */
export function scanMemory(cwd: string, opts: MemoryScanOptions = {}): MemorySection[] {
  const root = opts.root ?? path.join(HOME, '.claude', 'projects');
  const cwdResolved = path.resolve(cwd);
  const main = opts.mainWorktree !== undefined ? opts.mainWorktree : mainWorktreeOf(cwd);
  const projects = [...new Set([...(opts.projects ?? listProjects(cwd)), ...(main ? [main] : [])])];
  const byEncoded = new Map<string, string>();
  for (const p of projects) byEncoded.set(encodeProjectPath(p), p);
  // project → slug の順方向 Map。byEncoded は slug 衝突時に後勝ちで逆引き専用のため、別に持つ
  const slugOf = new Map(projects.map((p) => [p, encodeProjectPath(p)] as const));
  const currentPaths = new Set([cwdResolved, ...(main ? [main] : [])]);
  // 登録プロジェクトごとのメインワークツリー(.git を見るだけ)。other-project の除外判定で使い回す
  const mainCache = new Map<string, string | null>();
  const mainOf = (p: string): string | null => {
    if (!mainCache.has(p))
      mainCache.set(p, opts.mainWorktree !== undefined ? null : mainWorktreeOf(p));
    return mainCache.get(p) ?? null;
  };
  /* 並び順の優先度: cwd 完全一致 → メインワークツリー → その他(名前順) */
  const rankOf = (p: string | null): number => (p === cwdResolved ? 0 : main && p === main ? 1 : 2);

  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    // 既定の走査先が無くても autoMemoryDirectory 側は独立して見る(未インストール環境で
    // ~/.claude/projects が無くても、autoMemoryDirectory の memory は表示できるようにする)
    dirs = [];
  }

  const sections: MemorySection[] = [];
  // 既定走査で採ったディレクトリ(実パス)。autoMemoryDirectory が同じ場所を指しているときに
  // 二重にセクション化しないための照合に使う
  const scannedDirs = new Set<string>();
  for (const d of dirs) {
    const memDir = path.join(root, d.name, 'memory');
    let files: string[];
    try {
      files = fs
        .readdirSync(memDir)
        .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
        .sort((a, b) => a.localeCompare(b));
    } catch {
      continue; // memory ディレクトリが無いプロジェクトは単純に除外する
    }
    const index = readIndex(memDir);
    const projectPath = byEncoded.get(d.name) ?? null;
    // 「別プロジェクトのパス」の候補。次を除外する:
    //   - 自分自身: slug 一致(登録一致 p === projectPath はこれに包含される)。加えて
    //     **メインワークツリーの slug 一致**も自分扱いにする。memory dir の slug はメインワークツリー
    //     基準なので、メインが未登録で worktree だけ登録されている環境では p 自身の slug が
    //     d.name と一致しない(そのまま残すと、本文が自リポジトリの worktree 配下パスを
    //     参照するだけで「別の登録プロジェクトの話」というシグナルが誤って付く)
    //   - worktree 関係(メインワークツリー同士)
    //   - 入れ子プロジェクト(親子関係。親の memory が子の配下パスに触れるだけで
    //     wrong-project 経路に乗ってしまうのを防ぐ)。プロジェクト不明(projectPath null)は
    //     実パスでの親子判定ができないため、slug の区切り付き前方一致(usage.ts の
    //     hasTranscripts と同じパターン)で祖先・子孫を除外する。`-` を含む兄弟を過剰除外し得るし、
    //     メイン(pms)基準でも同じ前方一致を行うため `<main>-…` という名前の別プロジェクトも
    //     巻き込み得るが、過剰除外は「シグナルが付かない → keep」の安全側
    const otherProjects = projects.filter((p) => {
      const ps = slugOf.get(p)!;
      if (ps === d.name) return false; // 自分自身(登録一致はこれに包含)。mainOf(p)(fs 参照)を呼ぶ前に短絡
      const pMain = mainOf(p);
      const pms = pMain ? encodeProjectPath(pMain) : ps; // p の実体(worktree ならメイン)の slug
      if (pms === d.name) return false; // 自リポジトリの worktree(メインの slug が一致)
      if (!projectPath)
        return !(
          d.name.startsWith(ps + '-') ||
          ps.startsWith(d.name + '-') ||
          d.name.startsWith(pms + '-') ||
          pms.startsWith(d.name + '-')
        );
      return !isRelatedProject(p, projectPath, pMain, mainOf);
    });
    const items: SkillItem[] = [];
    for (const f of files) {
      const item = readMemoryFile(
        path.join(memDir, f),
        f,
        index.get(f),
        projectPath,
        otherProjects,
      );
      if (item) items.push(item);
    }
    if (!items.length) continue;
    scannedDirs.add(realDir(memDir));
    const beyondCount = items.filter((it) => it.indexBeyondLimit).length;
    sections.push({
      id: d.name,
      projectPath,
      // エンコードは不可逆なので、逆引きできないプロジェクト不明の表示名はエンコード名そのまま
      projectName: projectPath ? path.basename(projectPath) : d.name,
      note: memDir,
      // worktree 用の memory が将来作られたら両方 current になる(統合はしない)
      ...(projectPath && currentPaths.has(projectPath) ? { isCurrent: true } : {}),
      // orphan の真実源はここだけ(逆引き失敗は null で表す。byEncoded の値に空文字は入らない)
      ...(projectPath === null ? { orphan: true } : {}),
      usageAvailable: false, // 実測は Phase B で算出する
      // 200 行 / 25KB の上限外の索引行は実際には注入されないので常時コストから除く
      indexTokens: items.reduce(
        (sum, it) => sum + (it.indexBeyondLimit ? 0 : it.indexTokens || 0),
        0,
      ),
      ...(beyondCount ? { indexBeyondCount: beyondCount } : {}),
      // 棚卸し診断(wrong-project の移動先候補)でも同じ集合が要るので、計算元からそのまま運ぶ
      ...(otherProjects.length ? { otherProjects } : {}),
      items,
    });
  }

  // autoMemoryDirectory(公式仕様)。設定されていれば <dir> 直下に MEMORY.md + 個別 *.md が
  // プロジェクト区分なしで作られる(実測 2026-08-25)。この設定が有効な環境では Claude Code が
  // 実際に使う置き場なので、逆引き失敗ではなく明示的な現在地として orphan にはしない。
  // 解決は resolveAutoMemoryDir に集約する(読み取り許可・棚卸しと必ず同じ値を見る)。
  // 明示指定(autoMemoryDir)が常に最優先で、テストはここに null を渡して隔離する
  const auto = opts.autoMemoryDir !== undefined ? opts.autoMemoryDir : resolveAutoMemoryDir(cwd);
  // 既定走査と同じディレクトリを指しているなら、そちらで既にセクション化済み(重複表示・二重計上の回避)
  if (auto && !scannedDirs.has(realDir(auto.dir))) {
    const autoDir = auto.dir;
    let autoFiles: string[];
    try {
      autoFiles = fs
        .readdirSync(autoDir)
        .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
        .sort((a, b) => a.localeCompare(b))
        .slice(0, AUTO_DIR_MAX_FILES);
    } catch {
      autoFiles = [];
    }
    if (autoFiles.length) {
      const autoIndex = readIndex(autoDir);
      /*
       * user scope の設定では全プロジェクトが 1 つの置き場を共有する(公式仕様)ため、
       * そこにある memory がどのプロジェクトのものかは特定できない。現在のプロジェクトを
       * 帰属先として付けると、相対パスが誤った基準で解決され、別プロジェクトのブランチが
       * 「消えたブランチ」になり、現在の CLAUDE.md との重複を根拠に delete / to-skill が出る
       * ——「前提の取り違え」がそのまま破壊的な提案に化ける。よって帰属は主張せず、
       * 棚卸しは orphan と同じ制限ゲートに乗せる(sharedStore)。
       */
      const shared = auto.scope === 'user';
      const owner = main ?? cwdResolved;
      const autoProjectPath = shared ? null : owner;
      // 帰属するときは既定セクションと同じ規則で「別の登録プロジェクト」を算出する
      // (空のままだと wrong-project の候補が組めず、検出そのものが働かない)
      const autoOthers = autoProjectPath
        ? projects.filter((p) => !isRelatedProject(p, autoProjectPath, mainOf(p), mainOf))
        : [];
      const autoItems: SkillItem[] = [];
      for (const f of autoFiles) {
        const fp = path.join(autoDir, f);
        try {
          // 巨大ファイルは読み飛ばす(readMemoryFile に入る前に落として毎 GET のブロックを防ぐ)
          if (fs.statSync(fp).size > AUTO_FILE_MAX_BYTES) continue;
        } catch {
          continue; // stat できないものは読めないので同じくスキップ
        }
        const item = readMemoryFile(fp, f, autoIndex.get(f), autoProjectPath, autoOthers);
        if (item) autoItems.push(item);
      }
      if (autoItems.length) {
        const autoBeyond = autoItems.filter((it) => it.indexBeyondLimit).length;
        sections.push({
          // 既定セクション(slug がそのまま id)との衝突を避ける接頭辞。URL ルーティングも
          // /api/memory-triage の find も文字列一致なので、id の形が変わっても影響しない
          id: 'auto-' + encodeProjectPath(autoDir),
          projectPath: autoProjectPath,
          projectName: autoProjectPath ? path.basename(autoProjectPath) : path.basename(autoDir),
          note: autoDir,
          // 現に Claude Code が書き込む唯一の置き場なので、常に「現在地」として扱う
          // (web は先頭の isCurrent セクションを現在地とみなすため、並び順でも最優先にする)
          isCurrent: true,
          autoDir: true,
          ...(shared ? { sharedStore: true } : {}),
          // Read / Write 実績が計測可能かは、帰属先プロジェクトの slug で判定する
          // (transcript は現在のプロジェクトのものしか無い)。共有ストアは帰属が決まらないので
          // 持たせず、判定は全プロジェクトの transcript の有無で行う(usageAvailableFor)
          ...(shared ? {} : { transcriptSlug: encodeProjectPath(owner) }),
          usageAvailable: false,
          indexTokens: autoItems.reduce(
            (sum, it) => sum + (it.indexBeyondLimit ? 0 : it.indexTokens || 0),
            0,
          ),
          ...(autoBeyond ? { indexBeyondCount: autoBeyond } : {}),
          ...(autoOthers.length ? { otherProjects: autoOthers } : {}),
          items: autoItems,
        });
      }
    }
  }

  return sections.sort(
    (a, b) =>
      // autoDir(= 現に書き込まれている置き場)は rank より前。共有ストアは projectPath を
      // 持たないので rankOf では最後尾に落ちるが、web は先頭の isCurrent セクションを
      // 現在地として拾うため、実際に使われている置き場が先頭に来ていないと選択がずれる
      Number(!!b.autoDir) - Number(!!a.autoDir) ||
      Number(!!a.orphan) - Number(!!b.orphan) ||
      rankOf(a.projectPath) - rankOf(b.projectPath) ||
      a.projectName.localeCompare(b.projectName),
  );
}
