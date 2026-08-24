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
import { encodeProjectPath } from './usage';

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
 * dir が属する git のメインワークツリーのルート。git コマンドは呼ばず .git だけを見る。
 *   - `<dir>/.git` がディレクトリ = 通常のリポジトリなので dir 自身
 *   - `<dir>/.git` がファイル = worktree。中身の `gitdir: <p>` が
 *     `…/.git/worktrees/<name>` ならその 3 つ上がメインワークツリーのルート
 * それ以外(submodule の gitdir、.git が無い、読めない)は null。
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
  let raw: string;
  try {
    raw = fs.readFileSync(gitPath, 'utf8');
  } catch {
    return null;
  }
  const m = raw.match(/^gitdir:\s*(.+)$/m);
  if (!m) return null;
  const gitdir = m[1].trim();
  // linked worktree の gitdir だけを対象にする(submodule の .git ファイルも同じ形式なので形で弾く)
  if (!/(?:^|[/\\])\.git[/\\]worktrees[/\\][^/\\]+[/\\]?$/.test(gitdir)) return null;
  // git は通常フルパスを書くが、相対で書かれていても壊れないよう dir を起点に解決する
  return path.resolve(dir, gitdir, '..', '..', '..');
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
  if (v.startsWith('~/')) return path.join(home, v.slice(2));
  if (path.isAbsolute(v)) return v;
  return null; // 相対パスは公式仕様上無効
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
 * 読み取り許可(manage.ts)・棚卸し(memory-triage.ts)が別々に解決すると、
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
 * otherProjects は wrong-project の候補算出(triageProject)専用で web には参照が無く、
 * セクション × 登録プロジェクト数だけ payload を膨らませるだけ。
 * /api/memory-triage は自前で再スキャンするので影響しない。
 */
export function publicMemory(memory: MemorySection[]): MemorySection[] {
  return memory.map((sec) => {
    const out = { ...sec };
    delete out.otherProjects;
    return out;
  });
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
    scannedDirs.add(path.resolve(memDir));
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
  if (auto && !scannedDirs.has(path.resolve(auto.dir))) {
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
          isCurrent: true,
          autoDir: true,
          ...(shared ? { sharedStore: true } : {}),
          // transcript は現在のプロジェクトのものしか無いので(共有ストアでも同じ)、
          // Read / Write 実績が計測可能かは現在のプロジェクトの slug で判定する
          transcriptSlug: encodeProjectPath(owner),
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
      Number(!!a.orphan) - Number(!!b.orphan) ||
      rankOf(a.projectPath) - rankOf(b.projectPath) ||
      a.projectName.localeCompare(b.projectName),
  );
}
