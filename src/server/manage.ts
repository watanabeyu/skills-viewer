/* コピー / ゴミ箱行き削除 / md 読み取り / エディタで開く の実体とパス検証 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { listProjects } from './scan';
import { isUnder, resolveAutoMemoryDir } from './memory';
import { ApiError } from './errors';

const HOME = os.homedir();

type ManagedKind = 'skill' | 'command' | 'agent';

/* realpath 解決(存在しないパスは not-found に正規化) */
function realpathOrThrow(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    throw new ApiError('not-found', p);
  }
}

/* skills(ディレクトリ) / commands / agents(単一 .md) を管理対象とする */
export function assertManagedPath(p: string): { real: string; kind: ManagedKind } {
  const real = realpathOrThrow(p);
  const sep = path.sep;
  // plugin 配下(.claude/plugins/<name>/skills/… 等)は kind 判定より先に弾く。
  // within() は「.claude 直下の skills/」を要求するため、後段では到達しない
  if (real.includes(sep + '.claude' + sep + 'plugins' + sep)) {
    throw new ApiError('plugin-managed');
  }
  const within = (sub: string) => real.includes(sep + '.claude' + sep + sub + sep);
  const kind: ManagedKind | null = within('skills')
    ? 'skill'
    : within('commands')
      ? 'command'
      : within('agents')
        ? 'agent'
        : null;
  if (!kind) throw new ApiError('not-managed-path', real);
  return { real, kind };
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

/* 読み取り専用は plugin 配下も許可(.claude 配下 + 自動メモリの置き場配下の .md のみ) */
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

function assertKnownTarget(target: string, cwd: string): string {
  const resolved = path.resolve(target);
  const known = new Set([HOME, ...listProjects(cwd)]);
  if (!known.has(resolved)) throw new ApiError('unknown-copy-target', resolved);
  return resolved;
}

/* 同名がある場合は -copy, -copy2, … サフィックス(design 仕様) */
export function uniqueDest(to: string, isFile: boolean): string {
  if (!fs.existsSync(to)) return to;
  const dir = path.dirname(to);
  const base = isFile ? path.basename(to, '.md') : path.basename(to);
  const ext = isFile ? '.md' : '';
  for (let i = 1; i < 100; i++) {
    const cand = path.join(dir, base + '-copy' + (i === 1 ? '' : i) + ext);
    if (!fs.existsSync(cand)) return cand;
  }
  throw new ApiError('no-free-name');
}

const KIND_SUBDIR: Record<ManagedKind, string> = {
  skill: 'skills',
  command: 'commands',
  agent: 'agents',
};

export function doCopy({ src, target }: { src: string; target: string }, cwd: string) {
  const { real, kind } = assertManagedPath(src);
  const dstRoot = assertKnownTarget(target, cwd);
  let from: string, to: string;
  if (kind === 'skill') {
    from = path.dirname(real); // skill ディレクトリ丸ごと(references 等を含む)
    to = uniqueDest(path.join(dstRoot, '.claude', 'skills', path.basename(from)), false);
  } else {
    from = real;
    to = uniqueDest(path.join(dstRoot, '.claude', KIND_SUBDIR[kind], path.basename(real)), true);
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
  const destMd = kind === 'skill' ? path.join(to, 'SKILL.md') : to;
  const destName = kind === 'skill' ? path.basename(to) : path.basename(to, '.md');
  return { ok: true, dest: to, destMd, destName };
}

/* ---- ゴミ箱行き削除(復元可能) ---- */

function trashRoot(): string {
  if (process.platform === 'darwin') return path.join(HOME, '.Trash');
  const linuxTrash = path.join(HOME, '.local', 'share', 'Trash', 'files');
  if (fs.existsSync(linuxTrash)) return linuxTrash;
  return path.join(HOME, '.cache', 'skills-viewer', 'trash'); // 最終フォールバック
}

function moveToTrash(target: string): string {
  const root = trashRoot();
  fs.mkdirSync(root, { recursive: true });
  let dest = path.join(root, path.basename(target));
  if (fs.existsSync(dest)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    dest = path.join(root, path.basename(target) + ' ' + stamp);
  }
  try {
    fs.renameSync(target, dest);
  } catch (e: any) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(target, dest, { recursive: true }); // 別ボリューム(rename 不可)は copy + rm
    fs.rmSync(target, { recursive: true });
  }
  return dest;
}

export function doDelete({ src }: { src: string }) {
  const { real, kind } = assertManagedPath(src);
  const target = kind === 'skill' ? path.dirname(real) : real;
  if (kind === 'skill' && path.basename(path.dirname(target)) !== 'skills') {
    throw new ApiError('unexpected-skill-dir', target);
  }
  const trashedTo = moveToTrash(target);
  return { ok: true, deleted: target, trashedTo };
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
