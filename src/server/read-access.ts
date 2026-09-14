/*
 * 読み取り許可のパス検証と「エディタで開く」の実体。
 *
 * v0.9.0 で viewer からファイルの書き換えを廃止したので(計画 15 判断 1)、
 * 残る fs アクセスは「.md を読む」と「エディタに渡す」の 2 つだけになった。
 * どちらも realpath 解決後に許可範囲(.claude 配下 / autoMemoryDirectory 配下)を確かめる。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { isUnder, resolveAutoMemoryDir, samePath } from './memory';
import { claudeMdPaths } from './claude-md';
import { ApiError } from './errors';

/*
 * 許可範囲の母集団になるプロジェクト(計画 16 判断 4、レビュー 1 周目で縮めた)。
 * cwd と「いま選んでいるプロジェクト」の 2 つだけ ── ホーム ② が「選んだプロジェクトで claude を
 * 起動したら何が入るか」を答えるので、選んだものの CLAUDE.md と自動メモリは読めなければならない。
 * 逆に、選んでいないプロジェクトまで広げてはいけない: autoMemoryDirectory は各プロジェクトの
 * .claude/settings.json(clone に含まれる commit 済みのファイル)からも読むため、登録簿の全件を
 * 母集団にすると「clone しただけの悪意あるリポジトリが ~/Documents を許可範囲に足す」ことができる
 * (下限ガードは HOME 自身とその祖先しか弾けないので、HOME 直下の兄弟は守れない)。
 * 選択は resolveSelectedProject が候補との一致だけで決めるので、任意のパスはここに入らない。
 * この関数は登録簿(listProjects)も worktree 列挙も呼ばない ── 登録簿を読むのは選択の解決だけ。
 */
function accessRoots(cwd: string, selectedPath?: string): string[] {
  return [...new Set([path.resolve(cwd), ...(selectedPath ? [path.resolve(selectedPath)] : [])])];
}

/* realpath 解決(存在しないパスは not-found に正規化) */
function realpathOrThrow(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    throw new ApiError('not-found', p);
  }
}

/*
 * 自動メモリの置き場(settings の autoMemoryDirectory)の realpath。キャッシュは解決値ごとに 1 回。
 * 設定が有効な環境では memory の実体が .claude の外へ丸ごと移るため、
 * 一覧に出ている本文が読めない(fetchFile・棚卸しモーダル・エディタで開くが全滅する)。
 */
const autoRealMemo = new Map<string, string>();
function autoMemoryRoot(root: string): string | null {
  const info = resolveAutoMemoryDir(root);
  if (!info) return null;
  const cached = autoRealMemo.get(info.dir);
  if (cached) return cached;
  try {
    const real = fs.realpathSync(info.dir);
    // 解決できたときだけ覚える(置き場がまだ無い時点の失敗を焼き付けない。
    // ディレクトリは後から作られ得るので、次のリクエストで解決し直せるようにする)
    autoRealMemo.set(info.dir, real);
    return real;
  } catch {
    return null;
  }
}

/*
 * 解決済み autoMemoryDirectory の配下か。realpath 同士を path.sep 区切りで前方一致させる
 * (symlink 経由のパスで一致が外れないように / `<dir>-other` のような兄弟を巻き込まないように)。
 * `.claude` のルールは緩めず、この許可を足すだけ。
 */
function underAutoMemory(real: string, root: string): boolean {
  const dir = autoMemoryRoot(root);
  // isUnder はケース非依存 FS で case-fold する(dir が `/USERS/…` のとき
  // 実ファイルの realpath `/Users/…` と取り違えないように)
  return !!dir && real !== dir && isUnder(real, dir);
}

/* cwd / 選んだプロジェクトの置き場の配下か。解決は解決値ごとに memo 済みなので安い */
function underAnyAutoMemory(real: string, cwd: string, selectedPath?: string): boolean {
  return accessRoots(cwd, selectedPath).some((root) => underAutoMemory(real, root));
}

const underDotClaude = (real: string) => real.includes(path.sep + '.claude' + path.sep);

/*
 * CLAUDE.md 群(計画 15 Phase E2)。<project>/CLAUDE.md・CLAUDE.local.md・親ディレクトリの CLAUDE.md は
 * .claude の外にあるので、走査(claude-md.ts)が実際に列挙したファイルに限って許可する。
 * 名前も場所も走査側で固定されているため、任意の .md が開くことはない。
 * 管理ポリシーは本文を返さない段なので claudeMdPaths が含めない(許可の対象外)。
 * @import 先は展開位置の印だけを出す(本文は読まない)ので対象外。
 */
function isClaudeMdLayerFile(target: string, root: string): boolean {
  for (const fp of claudeMdPaths({ root })) {
    // ケース非依存 FS では realpath もケースを畳まないので、比較側で畳む(v0.8.1 の判断)。
    // 生パスと realpath の両方で見るのは、呼び出し側が realpath を通しているかどちらもあり得るため
    if (samePath(fp, target)) return true;
    try {
      if (samePath(fs.realpathSync(fp), target)) return true;
    } catch {
      /* 列挙後に消えた等。次のファイルへ */
    }
  }
  return false;
}

/*
 * 実在を前提にしない許可判定。削除済みファイルの過去の内容を扱う GET /api/diff は
 * realpath を通せないので、そこだけ字句の前方一致に落とす。
 *
 * 実在するなら判定は assertReadableMd と同じ(解決後のパスが境界の中)にする。
 * 字句一致で即 true にすると、経路に `.claude` を含む symlink が別のリポジトリを指している場合に
 * /api/file が拒否する同じパスを /api/diff が通してしまう(clone してきたリポジトリが仕込める)。
 */
export function allowedPath(
  abs: string,
  cwd: string = process.cwd(),
  selectedPath?: string,
): boolean {
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    /*
     * 解決できない = 消えている。字句だけで境界を見る。
     * CLAUDE.md 群はここで見ない: claudeMdPaths が existsSync で絞るので、消えたパスが
     * 一致することはない(判定を足しても常に false になり、rules ディレクトリの readdir と
     * 全候補の realpath を無駄に走らせるだけ)。消えた CLAUDE.md の差分を出したいなら、
     * 走査側に「存在で絞らない列挙」を足す必要がある ── 許可の広がりを伴うので別途。
     */
    return underDotClaude(abs) || underAnyAutoMemory(abs, cwd, selectedPath);
  }
  return allowed(real, cwd, selectedPath);
}

/*
 * AI(claude -p)に本文を送ってよいか。表示のための読み取りより狭くする。
 * CLAUDE.local.md は通常 gitignore される私的なファイルで、.claude 配下の定義ファイルとは
 * 機微度が違う(README は memory 棚卸しについて「見出しだけを送る」と約束している)。
 *
 * 自動メモリの置き場だけは表示用と同じ「cwd と選んだプロジェクト」に広げる(計画 16 判断 4):
 * 選んだプロジェクトの memory 棚卸しは本文を CLI に送るため(cwd の分は従来から送っている)。
 * CLAUDE.md 群はここに入れない ── 表示だけという README Security の約束を保つ。
 */
export function assertAiReadableMd(
  p: string,
  cwd: string = process.cwd(),
  selectedPath?: string,
): string {
  const real = realpathOrThrow(p);
  if (!real.endsWith('.md')) throw new ApiError('not-md', real);
  if (!underDotClaude(real) && !underAnyAutoMemory(real, cwd, selectedPath))
    throw new ApiError('not-readable-path', real);
  return real;
}

/*
 * 表示用の集合 = .claude 配下 ∪ cwd / 選んだプロジェクトの置き場配下 ∪ 同じ 2 root の CLAUDE.md 群。
 * 置き場を先に一巡してから CLAUDE.md 群を見るのは、置き場の解決が memo 済みで安いのに対し、
 * CLAUDE.md 群は root ごとに existsSync + realpath を伴うため。
 */
const allowed = (real: string, cwd: string, selectedPath?: string) => {
  if (underDotClaude(real)) return true;
  const roots = accessRoots(cwd, selectedPath);
  return (
    roots.some((root) => underAutoMemory(real, root)) ||
    roots.some((root) => isClaudeMdLayerFile(real, root))
  );
};

/* 読み取りは plugin 配下も許可(.claude 配下 + 自動メモリの置き場配下 + CLAUDE.md 群の .md のみ) */
export function assertReadableMd(
  p: string,
  cwd: string = process.cwd(),
  selectedPath?: string,
): string {
  const real = realpathOrThrow(p);
  if (!real.endsWith('.md')) throw new ApiError('not-md', real);
  if (!allowed(real, cwd, selectedPath)) throw new ApiError('not-readable-path', real);
  return real;
}

/*
 * エディタで開くのは .claude 配下(settings.json 等も含む)と自動メモリの置き場配下、CLAUDE.md 群。
 * export はテスト用(openInEditor はエディタを実起動するのでテストから直接は呼べない。
 * テスト欠落の穴埋め: tests/read-access.test.ts)。ロジックは変えていない。
 */
export function assertOpenablePath(p: string, cwd: string, selectedPath?: string): string {
  const real = realpathOrThrow(p);
  if (!allowed(real, cwd, selectedPath)) throw new ApiError('not-openable-path', real);
  return real;
}

/* ---- エディタで開く(OS デフォルト設定時のフォールバック) ---- */
/* CSB_EDITOR → cursor → code → subl → zed の順で CLI を探し、無ければ OS 既定で開く */

let editorCache: { cmd: string | null } | undefined;

function detectEditor(): { cmd: string | null } {
  if (editorCache) return editorCache;
  const candidates = [process.env.CSB_EDITOR, 'cursor', 'code', 'subl', 'zed'].filter(
    (c): c is string => Boolean(c),
  );
  for (const cmd of candidates) {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
      stdio: 'ignore',
    });
    if (r.status === 0) return (editorCache = { cmd });
  }
  return (editorCache = { cmd: null });
}

export function openInEditor(
  { src }: { src: string },
  cwd: string = process.cwd(),
  selectedPath?: string,
) {
  const real = assertOpenablePath(src, cwd, selectedPath);
  const { cmd } = detectEditor();
  if (cmd) {
    spawn(cmd, [real], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, editor: cmd };
  }
  // Windows は cmd を経由しない(shell:true や cmd /c start はパス中の & 等が解釈され得る)。
  // explorer.exe は引数をそのままファイルパスとして扱うためメタ文字が無害。
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(opener, [real], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true, editor: opener };
}
