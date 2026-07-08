/* コピー / ゴミ箱行き削除 / md 読み取り / エディタで開く の実体とパス検証 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { listProjects } from './scan';

const HOME = os.homedir();

type ManagedKind = 'skill' | 'command' | 'agent';

/* skills(ディレクトリ) / commands / agents(単一 .md) を管理対象とする */
export function assertManagedPath(p: string): { real: string; kind: ManagedKind } {
  const real = fs.realpathSync(p);
  const sep = path.sep;
  const within = (sub: string) => real.includes(sep + '.claude' + sep + sub + sep);
  const kind: ManagedKind | null = within('skills')
    ? 'skill'
    : within('commands')
      ? 'command'
      : within('agents')
        ? 'agent'
        : null;
  if (!kind) throw new Error('管理対象外のパスです: ' + real);
  if (real.includes(sep + '.claude' + sep + 'plugins' + sep)) {
    throw new Error('plugin 配下は /plugin コマンドで管理してください');
  }
  return { real, kind };
}

/* 読み取り専用は plugin 配下も許可(.claude 配下の .md のみ) */
export function assertReadableMd(p: string): string {
  const real = fs.realpathSync(p);
  if (!real.endsWith('.md')) throw new Error('md ファイルではありません');
  if (!real.includes(path.sep + '.claude' + path.sep))
    throw new Error('読み取り対象外のパスです: ' + real);
  return real;
}

/* エディタで開くのは .claude 配下ならなんでも良い(settings.json 等も含む) */
function assertOpenablePath(p: string): string {
  const real = fs.realpathSync(p);
  if (!real.includes(path.sep + '.claude' + path.sep)) throw new Error('対象外のパスです: ' + real);
  return real;
}

function assertKnownTarget(target: string, cwd: string): string {
  const resolved = path.resolve(target);
  const known = new Set([HOME, ...listProjects(cwd)]);
  if (!known.has(resolved)) throw new Error('未知のコピー先です: ' + resolved);
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
  throw new Error('コピー先の空き名が見つかりません');
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
    throw new Error('skill ディレクトリ構造が想定外です: ' + target);
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

export function openInEditor({ src }: { src: string }) {
  const real = assertOpenablePath(src);
  const { cmd } = detectEditor();
  if (cmd) {
    spawn(cmd, [real], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, editor: cmd };
  }
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(opener, [real], {
    detached: true,
    stdio: 'ignore',
    shell: process.platform === 'win32',
  }).unref();
  return { ok: true, editor: opener };
}
