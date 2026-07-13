/*
 * ブラウザ内編集の実体: SKILL.md / command / agent の保存と description 差し替え。
 * 本ツール初の「ファイル内容の書き換え」なので、
 *   - パス検証は manage.ts の assertManagedPath(.claude/skills|commands|agents 限定、plugin 拒否)に乗せる
 *   - mtime による競合検出(エディタ等での外部変更を上書きしない)
 *   - 保存前に ~/.cache/skills-viewer/backups/ へ1世代バックアップ(trash と同じ思想)
 * を必ず通す。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assertManagedPath } from './manage';
import { ApiError } from './errors';

/* テストから隔離できるよう env で差し替え可能にする(通常運用では未設定)。
   モジュール読み込み後に env を設定するテストのため、参照は呼び出し時に行う */
const backupDir = () =>
  process.env.SKILLS_VIEWER_BACKUP_DIR ||
  path.join(os.homedir(), '.cache', 'skills-viewer', 'backups');
const MAX_CONTENT = 512 * 1024; // request body 上限(1MB)より小さく、md として十分

export function assertEditableMd(p: string): string {
  const { real } = assertManagedPath(p);
  if (!real.endsWith('.md')) throw new ApiError('not-md', real);
  return real;
}

/* 上書き前の内容を1世代だけ退避(ファイルごとに1枠、保存のたびに更新) */
function backupOnce(real: string, content: string): void {
  try {
    const dir = backupDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, real.replace(/[^a-zA-Z0-9.]/g, '-')), content);
  } catch {
    /* バックアップ失敗で保存自体は止めない */
  }
}

/* mtime 競合チェック → バックアップ → 書き込み、の共通経路 */
function writeGuarded(real: string, next: string, baseMtime?: number): { mtime: number } {
  const st = fs.statSync(real);
  if (typeof baseMtime === 'number' && st.mtimeMs !== baseMtime) {
    throw new ApiError('edit-conflict', real);
  }
  backupOnce(real, fs.readFileSync(real, 'utf8'));
  fs.writeFileSync(real, next);
  return { mtime: fs.statSync(real).mtimeMs };
}

export function doSave(data: { src: string; content: unknown; baseMtime?: unknown }) {
  const real = assertEditableMd(data.src);
  const content = data.content;
  if (typeof content !== 'string' || !content.trim()) throw new ApiError('empty-content');
  if (content.length > MAX_CONTENT) throw new ApiError('content-too-large');
  const baseMtime = typeof data.baseMtime === 'number' ? data.baseMtime : undefined;
  return { ok: true as const, ...writeGuarded(real, content, baseMtime) };
}

/*
 * frontmatter の description だけを差し替える(AI 改善案のワンクリック適用用)。
 * - 既存の description 行(block scalar 含む)を置き換え
 * - description キーが無ければ frontmatter 先頭(name の次)に挿入
 * - frontmatter 自体が無ければ新設
 * 値は常に YAML double-quote(JSON.stringify)で書き、改行は空白に潰す。
 */
export function replaceDescription(raw: string, desc: string): string {
  const value = 'description: ' + JSON.stringify(desc.replace(/\s*\n\s*/g, ' ').trim());
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n?)/);
  if (!fm) return `---\n${value}\n---\n\n` + raw;

  const lines = fm[1].split(/\r?\n/);
  const out: string[] = [];
  let replaced = false;
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^description:\s*(.*)$/);
    if (!m || replaced) {
      out.push(lines[i]);
      i++;
      continue;
    }
    out.push(value);
    replaced = true;
    i++;
    if (['|', '>', '|-', '>-'].includes(m[1].trim())) {
      // block scalar の継続行(インデント行・空行)を捨てる
      while (i < lines.length && (lines[i].startsWith('  ') || lines[i].trim() === '')) i++;
    }
  }
  if (!replaced) {
    // name の直後、無ければ先頭に挿入
    const nameIdx = out.findIndex((l) => /^name:/.test(l));
    out.splice(nameIdx >= 0 ? nameIdx + 1 : 0, 0, value);
  }
  return '---\n' + out.join('\n') + '\n---' + fm[2] + raw.slice(fm[0].length);
}

export function doApplyDescription(data: {
  src: string;
  description: unknown;
  baseMtime?: unknown;
}) {
  const real = assertEditableMd(data.src);
  if (typeof data.description !== 'string' || !data.description.trim()) {
    throw new ApiError('empty-content');
  }
  const prev = fs.readFileSync(real, 'utf8');
  const baseMtime = typeof data.baseMtime === 'number' ? data.baseMtime : undefined;
  return {
    ok: true as const,
    ...writeGuarded(real, replaceDescription(prev, data.description), baseMtime),
  };
}
