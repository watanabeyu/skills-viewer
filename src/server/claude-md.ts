/*
 * CLAUDE.md 群の走査。Claude Code が「毎セッションの最初に読むもの」を注入順に列挙し、
 * 常時コスト(トークン)と本文を返す。ホームの「セッションの文脈」と CLAUDE.md 画面の土台。
 *
 * 公式の読み込み順(https://code.claude.com/docs/en/memory.md、2026-09-08 確認):
 *   1. 管理ポリシー(OS 固定パス)
 *   2. ~/.claude/CLAUDE.md
 *   3. <project>/CLAUDE.md
 *   4. <project>/.claude/CLAUDE.md
 *   5. <project>/CLAUDE.local.md
 *   6. <project>/.claude/rules/*.md(frontmatter に paths: が無いものだけが起動時。有りは遅延)
 *   7. 親ディレクトリの CLAUDE.md(git root まで遡る)
 * サブディレクトリの CLAUDE.md は「そのディレクトリのファイルを読むとき」の遅延ロードなので
 * 常時コストには含めない(この走査の対象外)。
 *
 * HOME/.claude の参照はこのファイルに集約する(計画 11 の claudeDir() へ差し替えやすくするため)。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ClaudeMdFile, ClaudeMdImport, ClaudeMdLayer, ClaudeMdScan } from '../shared/types';
import { estimateTokens } from './lint';
import { parseFrontmatter } from './scan';
import { isUnder, worktreeRootOf } from './memory';

/* @import の展開上限(公式仕様: 4 段) */
const MAX_IMPORT_DEPTH = 4;

/* 管理ポリシーの置き場(OS ごとの固定パス)。本文は返さず存在と概算だけ扱う */
function managedPolicyPath(): string {
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode/CLAUDE.md';
  if (process.platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\CLAUDE.md';
  return '/etc/claude-code/CLAUDE.md';
}

function readText(fp: string): string | null {
  try {
    return fs.readFileSync(fp, 'utf8');
  } catch {
    return null; // 権限エラー等で読めない段は「無い」扱いにして一覧全体を落とさない
  }
}

function mtime(fp: string): string {
  try {
    return fs.statSync(fp).mtime.toISOString();
  } catch {
    return '';
  }
}

/*
 * 見出しごとの概算。見出し行から次の見出し行の直前までを 1 節として数えるので、
 * 節の合計は本文全体の概算とほぼ一致する(どの節が重いかを出すための内訳)。
 */
function headingsOf(body: string): { text: string; tokens: number }[] {
  const lines = body.split(/\r?\n/);
  const out: { text: string; tokens: number }[] = [];
  let cur: { text: string; buf: string[] } | null = null;
  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      if (cur) out.push({ text: cur.text, tokens: estimateTokens(cur.buf.join('\n')) });
      cur = { text: h[2].trim(), buf: [line] };
    } else if (cur) {
      cur.buf.push(line);
    }
  }
  if (cur) out.push({ text: cur.text, tokens: estimateTokens(cur.buf.join('\n')) });
  return out;
}

/*
 * @import の解決。公式は `@README` のように相対・絶対・~ 始まりを受ける。
 * コードブロック内の @ は拾わないよう、``` で囲まれた範囲は除外する。
 */
function importRefs(body: string): string[] {
  const refs: string[] = [];
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const m of line.matchAll(/(^|\s)@(\S+)/g)) {
      const ref = m[2].replace(/[.,;:)\]]+$/, ''); // 文末の句読点は取り込まない
      if (ref) refs.push(ref);
    }
  }
  return refs;
}

function resolveImport(ref: string, fromDir: string, home: string): string {
  if (ref.startsWith('~/')) return path.join(home, ref.slice(2));
  if (path.isAbsolute(ref)) return ref;
  return path.resolve(fromDir, ref);
}

/*
 * @import を深さ優先で展開する。同じ実パスは 2 度展開しない(循環はそこで打ち切って印を残す)。
 * seen は 1 ファイルの走査で共有するので、a → b → a も a → b, a → b の再掲も 1 回だけ数える。
 */
function expandImports(
  body: string,
  fromDir: string,
  home: string,
  depth: number,
  seen: Set<string>,
  out: ClaudeMdImport[],
): void {
  for (const ref of importRefs(body)) {
    const abs = resolveImport(ref, fromDir, home);
    let real = abs;
    let exists: boolean;
    try {
      real = fs.realpathSync(abs);
      exists = fs.statSync(real).isFile();
    } catch {
      exists = false;
    }
    if (!exists) {
      out.push({ ref, path: abs, exists: false, depth, tokens: 0 });
      continue;
    }
    if (seen.has(real)) {
      out.push({ ref, path: real, exists: true, depth, tokens: 0, skipped: 'cycle' });
      continue;
    }
    if (depth > MAX_IMPORT_DEPTH) {
      out.push({ ref, path: real, exists: true, depth, tokens: 0, skipped: 'depth' });
      continue;
    }
    seen.add(real);
    const raw = readText(real);
    if (raw === null) {
      out.push({ ref, path: real, exists: false, depth, tokens: 0 });
      continue;
    }
    out.push({ ref, path: real, exists: true, depth, tokens: estimateTokens(raw) });
    expandImports(raw, path.dirname(real), home, depth + 1, seen, out);
  }
}

/* 1 ファイル分の読み取り。本文を返さない段(管理ポリシー)は withhold で切り替える */
function readFile(
  fp: string,
  home: string,
  opts: { withhold?: boolean } = {},
): ClaudeMdFile | null {
  const raw = readText(fp);
  if (raw === null) return null;
  const ownTokens = estimateTokens(raw);
  const imports: ClaudeMdImport[] = [];
  const seen = new Set<string>();
  try {
    seen.add(fs.realpathSync(fp));
  } catch {
    seen.add(fp);
  }
  expandImports(raw, path.dirname(fp), home, 1, seen, imports);
  const importTokens = imports.reduce((n, im) => n + im.tokens, 0);
  return {
    path: fp,
    ownTokens,
    tokens: ownTokens + importTokens,
    updatedAt: mtime(fp),
    headings: opts.withhold ? [] : headingsOf(raw),
    imports,
    ...(opts.withhold ? { bodyWithheld: true as const } : {}),
  };
}

/* 単一ファイルの段。無くても「どこを見たか」を残すため files: [] で返す */
function singleLayer(
  kind: ClaudeMdLayer['kind'],
  fp: string,
  home: string,
  opts: { withhold?: boolean } = {},
): ClaudeMdLayer {
  const f = fs.existsSync(fp) ? readFile(fp, home, opts) : null;
  return { kind, label: fp, files: f ? [f] : [], tokens: f ? f.tokens : 0 };
}

/*
 * .claude/rules/*.md。frontmatter に paths: があるものは「そのパスのファイルを読むとき」の
 * 遅延ロードなので常時コストに含めない(件数だけ lazy で残す)。
 * paths: の値は YAML リストで、既存の parseFrontmatter では中身を取れない。
 * ここで要るのは有無だけなので、キーの存在で判定する(真偽値で見ると空文字列に負ける)。
 */
function rulesLayer(root: string, home: string): ClaudeMdLayer {
  const dir = path.join(root, '.claude', 'rules');
  const layer: ClaudeMdLayer = {
    kind: 'rules',
    label: path.join(dir, '*.md'),
    files: [],
    tokens: 0,
  };
  let names: string[];
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name)
      .sort();
  } catch {
    return layer;
  }
  for (const name of names) {
    const fp = path.join(dir, name);
    const raw = readText(fp);
    if (raw === null) continue;
    const f = readFile(fp, home);
    if (!f) continue;
    const lazy = 'paths' in parseFrontmatter(raw).meta;
    layer.files.push(lazy ? { ...f, lazy: true } : f);
    if (!lazy) layer.tokens += f.tokens;
  }
  return layer;
}

/*
 * 親ディレクトリの探索範囲。git root まで遡り、ホームとその祖先・ファイルシステムのルートには出ない。
 * git 管理外なら 1 つ上だけ(どこまでも遡ると無関係な親の CLAUDE.md を拾う)。
 * 本文の読み取り(parentLayer)とパスの列挙(claudeMdPaths)で同じ範囲を使う。
 */
function parentDirs(root: string, home: string): string[] {
  const gitRoot = worktreeRootOf(root);
  const dirs: string[] = [];
  let cur = path.dirname(path.resolve(root));
  for (;;) {
    if (cur === path.dirname(cur)) break; // ファイルシステムのルート
    if (cur === home || isUnder(home, cur)) break; // ホームとその祖先には出ない
    dirs.push(cur);
    if (!gitRoot) break; // git 管理外は 1 つ上だけ
    if (cur === gitRoot || !isUnder(cur, gitRoot)) break;
    cur = path.dirname(cur);
  }
  return dirs;
}

/*
 * 親ディレクトリの CLAUDE.md。git root まで遡り、ホームやファイルシステムのルートには出ない。
 * git 管理外なら 1 つ上だけ見る(どこまでも遡ると無関係な親の CLAUDE.md を拾う)。
 */
function parentLayer(root: string, home: string): ClaudeMdLayer {
  const layer: ClaudeMdLayer = {
    kind: 'parent',
    label: path.join(path.dirname(root), 'CLAUDE.md'),
    files: [],
    tokens: 0,
  };
  for (const dir of parentDirs(root, home)) {
    const fp = path.join(dir, 'CLAUDE.md');
    if (!fs.existsSync(fp)) continue;
    const f = readFile(fp, home);
    if (!f) continue;
    layer.files.push(f);
    layer.tokens += f.tokens;
  }
  return layer;
}

/*
 * 注入順に 7 段を並べる。無い段も files: [] で残す(「何が読まれていないか」も情報なので、
 * 画面側で「なし」の行として出せるようにする)。
 * root / home はテストから差し替えられるよう引数で受ける。
 */
export function claudeMdLayers(
  opts: { root?: string | null; home?: string; managedPath?: string } = {},
): ClaudeMdScan {
  const home = opts.home ?? os.homedir();
  const root = opts.root ? path.resolve(opts.root) : null;
  const layers: ClaudeMdLayer[] = [
    singleLayer('managed', opts.managedPath ?? managedPolicyPath(), home, { withhold: true }),
    singleLayer('user', path.join(home, '.claude', 'CLAUDE.md'), home),
  ];
  if (root) {
    layers.push(
      singleLayer('project', path.join(root, 'CLAUDE.md'), home),
      singleLayer('project-dot', path.join(root, '.claude', 'CLAUDE.md'), home),
      singleLayer('local', path.join(root, 'CLAUDE.local.md'), home),
      rulesLayer(root, home),
      parentLayer(root, home),
    );
  }
  return { layers, tokens: layers.reduce((n, l) => n + l.tokens, 0) };
}

/*
 * 走査が見るファイルのパスだけを列挙する(本文を読まず、トークンも数えない)。
 * 読み取り・エディタ起動の許可判定(read-access.ts)は「このパスか」だけを知りたいので、
 * claudeMdLayers を呼ぶと 1 リクエストごとに全文の読み取りと @import の展開が走ってしまう。
 * 管理ポリシーは本文を返さない段なので含めない(許可の対象外)。
 */
export function claudeMdPaths(opts: { root?: string | null; home?: string } = {}): string[] {
  const home = opts.home ?? os.homedir();
  const root = opts.root ? path.resolve(opts.root) : null;
  const out = [path.join(home, '.claude', 'CLAUDE.md')];
  if (root) {
    out.push(
      path.join(root, 'CLAUDE.md'),
      path.join(root, '.claude', 'CLAUDE.md'),
      path.join(root, 'CLAUDE.local.md'),
    );
    const rulesDir = path.join(root, '.claude', 'rules');
    try {
      for (const e of fs.readdirSync(rulesDir, { withFileTypes: true }))
        if (e.isFile() && e.name.endsWith('.md')) out.push(path.join(rulesDir, e.name));
    } catch {
      /* rules ディレクトリが無い環境 */
    }
    for (const dir of parentDirs(root, home)) out.push(path.join(dir, 'CLAUDE.md'));
  }
  return out.filter((fp) => fs.existsSync(fp));
}

/* 差分追跡(snapshot)へ渡す参照。遅延ロードの rules も「変わったら知りたい」ので含める */
export function claudeMdRefs(
  scan: ClaudeMdScan,
  home = os.homedir(),
): {
  path: string;
  exists: boolean;
  name?: string;
  source?: 'user' | 'project';
}[] {
  const userDir = path.join(home, '.claude');
  const out: { path: string; exists: boolean; name?: string; source?: 'user' | 'project' }[] = [];
  for (const layer of scan.layers) {
    // 管理ポリシーは OS が配るもので、利用者の変更対象ではないので追跡しない
    if (layer.kind === 'managed') continue;
    for (const f of layer.files) {
      out.push({
        path: f.path,
        exists: true,
        name: path.basename(f.path),
        source: isUnder(f.path, userDir) ? 'user' : 'project',
      });
    }
  }
  return out;
}
