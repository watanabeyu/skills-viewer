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
import { isUnder, resolveAutoMemoryDir } from './memory';
import { ApiError } from './errors';

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
function autoMemoryRoot(cwd: string): string | null {
  const info = resolveAutoMemoryDir(cwd);
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
function underAutoMemory(real: string, cwd: string): boolean {
  const root = autoMemoryRoot(cwd);
  // isUnder はケース非依存 FS で case-fold する(root が `/USERS/…` のとき
  // 実ファイルの realpath `/Users/…` と取り違えないように)
  return !!root && real !== root && isUnder(real, root);
}

const underDotClaude = (real: string) => real.includes(path.sep + '.claude' + path.sep);

/* 読み取りは plugin 配下も許可(.claude 配下 + 自動メモリの置き場配下の .md のみ) */
export function assertReadableMd(p: string, cwd: string = process.cwd()): string {
  const real = realpathOrThrow(p);
  if (!real.endsWith('.md')) throw new ApiError('not-md', real);
  if (!underDotClaude(real) && !underAutoMemory(real, cwd))
    throw new ApiError('not-readable-path', real);
  return real;
}

/* エディタで開くのは .claude 配下(settings.json 等も含む)と自動メモリの置き場配下 */
function assertOpenablePath(p: string, cwd: string): string {
  const real = realpathOrThrow(p);
  if (!underDotClaude(real) && !underAutoMemory(real, cwd))
    throw new ApiError('not-openable-path', real);
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

export function openInEditor({ src }: { src: string }, cwd: string = process.cwd()) {
  const real = assertOpenablePath(src, cwd);
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
