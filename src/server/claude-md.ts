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
import { isUnder, realDir, worktreeRootOf } from './memory';

/*
 * user scope の設定ディレクトリ。HOME/.claude の参照はこのファイルに集約する
 * (計画 11 の CLAUDE_CONFIG_DIR 対応で claudeDir() に差し替える箇所を 1 つに保つため)。
 */
export const userClaudeDir = (home: string = os.homedir()) => path.join(home, '.claude');

/* @import の展開上限(公式仕様: maximum depth of four hops) */
const MAX_IMPORT_DEPTH = 4;

/*
 * 1 ファイルの読み取り上限。公式が「Claude Code loads a CLAUDE.md file of up to 4 MiB in full
 * and skips a larger file」と定めているので同じ線に揃える。ここを公式より狭くすると、
 * Claude Code は読んでいるのに viewer は「未読」と出すことになり、常時コストを過少に出す。
 * 7 段の本体にも @import 先にも同じ上限を掛ける(本体だけ無制限だと概算のループが効かない)。
 */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/*
 * 1 ファイルから拾う参照の件数と、1 段の走査で作る @import 行の総数。
 * 参照 1 件ごとに realpath + stat が走るので、扇形に広い CLAUDE.md で毎リクエスト数千回の
 * fs 呼び出しと数 MB の JSON が出るのを防ぐ(git author に 40 件の予算を置いたのと同じ趣旨)。
 */
const MAX_IMPORT_REFS_PER_FILE = 200;
const MAX_IMPORT_ENTRIES = 500;

/*
 * @import 先を開いてよい範囲(プロジェクト配下と user scope の設定ディレクトリ配下)。
 * 判定は realpath の前後 2 回行うので、境界も解決前と解決後の両方を持つ
 * (macOS の /var → /private/var のように、解決前と後で前方一致が外れる)。
 */
interface ImportScope {
  roots: string[];
}

function importScopeOf(root: string | null, home: string): ImportScope {
  const dirs = [userClaudeDir(home), root].filter((d): d is string => !!d);
  // realDir は memory.ts の写像(realpath が取れなければ resolve で代用)。
  // 許可の判定はこの 1 本に揃える — 場所ごとに実パスで見るかが変わると許可と判定がずれる
  return { roots: [...new Set(dirs.flatMap((d) => [d, realDir(d)]))] };
}

/* 管理ポリシーの置き場(OS ごとの固定パス)。本文は返さず存在と概算だけ扱う */
function managedPolicyPath(): string {
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode/CLAUDE.md';
  if (process.platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\CLAUDE.md';
  return '/etc/claude-code/CLAUDE.md';
}

function readText(fp: string): string | null {
  try {
    // 公式も 4 MiB 超の CLAUDE.md は読まない。読む前に大きさで落とす
    // (毎リクエストの全読みと概算の文字単位ループが効かないように)
    if (fs.statSync(fp).size > MAX_FILE_BYTES) return null;
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
 * @import の解決。除外の規則は公式に合わせる(memory.md「Import parsing skips Markdown code
 * spans and fenced code blocks. … writing `@README` keeps the text literal, while @README
 * outside backticks imports the file」): ``` のフェンス内と ` ` のコードスパン内は拾わず、
 * それ以外の @ トークンは拡張子もスラッシュも無くても参照として扱う。
 *
 * かつては「パスに見えるもの」だけを拾っていたが、それだと公式が読む `@README` `@Makefile` を
 * 落として常時コストを過少に出す。散文の「@alice に聞く」は解決に失敗して exists: false の行に
 * なるだけで、境界の外は下の inImportScope が開かない。
 */
const trimTail = (s: string): string => {
  // 正規表現の [.,;:)\]]+$ は「.」の長い連なりでバックトラックし、200KB の 1 行で数秒止まる。
  // 末尾から数えるだけにして入力長に線形にする
  let end = s.length;
  while (end > 0 && '.,;:)]'.includes(s[end - 1])) end--;
  return s.slice(0, end);
};

function importRefs(body: string): string[] {
  const refs: string[] = [];
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // コードスパンは中身ごと落とす(`@README` は文字どおりの表記で参照ではない)
    const bare = line.replace(/`[^`]*`/g, ' ');
    for (const m of bare.matchAll(/(^|\s)@(\S+)/g)) {
      const ref = trimTail(m[2]);
      // 参照 1 件の長さの上限。これを超えるものはパスではなく、後段の realpath も無駄になる
      if (!ref || ref.length > 1024) continue;
      refs.push(ref);
      if (refs.length >= MAX_IMPORT_REFS_PER_FILE) return refs;
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
 * @import を深さ優先で展開する。
 * - stack は展開の経路(自分の先祖)。ここに居れば本当の循環
 * - seen は 1 ファイルの走査で数えた実パス。経路が違うのに再登場したのはダイヤモンド参照で、
 *   二重計上を避けるために展開しないが循環ではない(表示の文言を分ける)
 */
function expandImports(
  body: string,
  fromDir: string,
  home: string,
  depth: number,
  seen: Set<string>,
  stack: Set<string>,
  scope: ImportScope,
  out: ClaudeMdImport[],
): void {
  for (const ref of importRefs(body)) {
    if (out.length >= MAX_IMPORT_ENTRIES) return;
    const abs = resolveImport(ref, fromDir, home);
    /*
     * 読み取りの境界の外は realpath も stat もしない。CLAUDE.md は clone したリポジトリから
     * 来るファイルなので、@/etc/hosts や @~/.ssh/config を素直に解決すると、本文を読まなくても
     * 「存在するか」「symlink の先はどこか」をブラウザへ返してしまう(覗く材料になる)。
     * 字句で先に落とし、返すのも要求されたパスのまま(解決後のフルパスは出さない)。
     */
    if (!openableImport(abs, scope)) {
      out.push({ ref, path: abs, exists: false, depth, tokens: 0, skipped: 'out-of-scope' });
      continue;
    }
    let real = abs;
    let size = 0;
    let exists: boolean;
    try {
      real = fs.realpathSync(abs);
      const st = fs.statSync(real);
      exists = st.isFile();
      size = st.size;
    } catch {
      exists = false;
    }
    if (!exists) {
      out.push({ ref, path: abs, exists: false, depth, tokens: 0 });
      continue;
    }
    // symlink で境界の外へ出ていないか、解決後にもう一度見る
    if (!openableImport(real, scope)) {
      out.push({ ref, path: abs, exists: false, depth, tokens: 0, skipped: 'out-of-scope' });
      continue;
    }
    if (stack.has(real)) {
      out.push({ ref, path: real, exists: true, depth, tokens: 0, skipped: 'cycle' });
      continue;
    }
    if (seen.has(real)) {
      out.push({ ref, path: real, exists: true, depth, tokens: 0, skipped: 'duplicate' });
      continue;
    }
    if (depth > MAX_IMPORT_DEPTH) {
      out.push({ ref, path: real, exists: true, depth, tokens: 0, skipped: 'depth' });
      continue;
    }
    if (size > MAX_FILE_BYTES) {
      out.push({ ref, path: real, exists: true, depth, tokens: 0, skipped: 'too-large' });
      continue;
    }
    seen.add(real);
    const raw = readText(real);
    if (raw === null) {
      out.push({ ref, path: real, exists: false, depth, tokens: 0 });
      continue;
    }
    out.push({ ref, path: real, exists: true, depth, tokens: estimateTokens(raw) });
    stack.add(real);
    expandImports(raw, path.dirname(real), home, depth + 1, seen, stack, scope, out);
    stack.delete(real);
  }
}

/*
 * @import 先として開いてよい範囲。Claude Code 自身が読むのはプロジェクト配下のファイル
 * (@README など)と user scope の設定なので、その 2 つに限る。
 */
const inImportScope = (p: string, scope: ImportScope): boolean =>
  scope.roots.some((r) => isUnder(p, r));

/*
 * 境界の中でも開かないもの。公式の @import は拡張子を問わない(@package.json も読む)ので
 * .md に絞ることはしないが、秘密が入る場所は外す:
 * - .git 配下(/api/diff も明示的に弾いている)
 * - 名前が . で始まるファイル(~/.claude/.credentials.json、リポジトリの .env)
 * どちらも「参照されたら概算サイズを返す」だけでも渡したくない場所。
 */
function openableImport(p: string, scope: ImportScope): boolean {
  if (!inImportScope(p, scope)) return false;
  const parts = p.split(path.sep);
  if (parts.includes('.git')) return false;
  const base = parts[parts.length - 1] || '';
  return !base.startsWith('.');
}

/* 1 ファイル分の読み取り。本文を返さない段(管理ポリシー)は withhold で切り替える */
function readFile(
  fp: string,
  home: string,
  scope: ImportScope,
  opts: { withhold?: boolean } = {},
): ClaudeMdFile | null {
  const raw = readText(fp);
  if (raw === null) return null;
  const ownTokens = estimateTokens(raw);
  const imports: ClaudeMdImport[] = [];
  const seen = new Set<string>();
  const stack = new Set<string>();
  try {
    const self = fs.realpathSync(fp);
    seen.add(self);
    stack.add(self);
  } catch {
    seen.add(fp);
    stack.add(fp);
  }
  expandImports(raw, path.dirname(fp), home, 1, seen, stack, scope, imports);
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
  scope: ImportScope,
  opts: { withhold?: boolean } = {},
): ClaudeMdLayer {
  const f = fs.existsSync(fp) ? readFile(fp, home, scope, opts) : null;
  return { kind, label: fp, files: f ? [f] : [], tokens: f ? f.tokens : 0 };
}

/*
 * .claude/rules/*.md。frontmatter に paths: があるものは「そのパスのファイルを読むとき」の
 * 遅延ロードなので常時コストに含めない(件数だけ lazy で残す)。
 * paths: の値は YAML リストで、既存の parseFrontmatter では中身を取れない。
 * ここで要るのは有無だけなので、キーの存在で判定する(真偽値で見ると空文字列に負ける)。
 */
function rulesLayer(root: string, home: string, scope: ImportScope): ClaudeMdLayer {
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
    const f = readFile(fp, home, scope);
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
    if (!gitRoot) {
      dirs.push(cur); // git 管理外は 1 つ上だけ
      break;
    }
    // git 配下は境界の判定を先に置く。root 自身が git root(普通のリポジトリを開いた場合)なら
    // 親は範囲外なので 1 件も拾わない
    if (!isUnder(cur, gitRoot)) break;
    dirs.push(cur);
    if (cur === gitRoot) break;
    cur = path.dirname(cur);
  }
  return dirs;
}

/*
 * 親ディレクトリの CLAUDE.md。git root まで遡り、ホームやファイルシステムのルートには出ない。
 * git 管理外なら 1 つ上だけ見る(どこまでも遡ると無関係な親の CLAUDE.md を拾う)。
 */
function parentLayer(root: string, home: string, scope: ImportScope): ClaudeMdLayer {
  const layer: ClaudeMdLayer = {
    kind: 'parent',
    label: path.join(path.dirname(root), 'CLAUDE.md'),
    files: [],
    tokens: 0,
  };
  for (const dir of parentDirs(root, home)) {
    const fp = path.join(dir, 'CLAUDE.md');
    if (!fs.existsSync(fp)) continue;
    const f = readFile(fp, home, scope);
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
  const scope = importScopeOf(root, home);
  const layers: ClaudeMdLayer[] = [
    singleLayer('managed', opts.managedPath ?? managedPolicyPath(), home, scope, {
      withhold: true,
    }),
    singleLayer('user', path.join(userClaudeDir(home), 'CLAUDE.md'), home, scope),
  ];
  if (root) {
    layers.push(
      singleLayer('project', path.join(root, 'CLAUDE.md'), home, scope),
      singleLayer('project-dot', path.join(root, '.claude', 'CLAUDE.md'), home, scope),
      singleLayer('local', path.join(root, 'CLAUDE.local.md'), home, scope),
      rulesLayer(root, home, scope),
      parentLayer(root, home, scope),
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
  const out = [path.join(userClaudeDir(home), 'CLAUDE.md')];
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
  const userDir = userClaudeDir(home);
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
