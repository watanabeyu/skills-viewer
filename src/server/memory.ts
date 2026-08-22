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
import { encodeProjectPath } from './usage';

export interface MemoryScanOptions {
  /* ~/.claude/projects 相当のルート(テストで差し替える) */
  root?: string;
  /* 逆引きに使うプロジェクトパス一覧(テストで差し替える) */
  projects?: string[];
  /* メインワークツリーの実パス(テストで差し替える)。既定は mainWorktreeOf(cwd) */
  mainWorktree?: string | null;
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
 * MEMORY.md(索引)を「本文ファイル名 → 索引行」の Map にする。
 * 索引行は `- [title](file.md) — desc` 形式で、リンク先ファイル名が本文と対応する。
 */
function readIndex(memDir: string): Map<string, string> {
  const map = new Map<string, string>();
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(memDir, 'MEMORY.md'), 'utf8');
  } catch {
    return map; // 索引が無い/読めない場合は索引行なし(indexTokens = 0)として扱う
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/\(([^()]+\.md)\)/);
    if (m) map.set(path.basename(m[1]), line.trim());
  }
  return map;
}

function readMemoryFile(fp: string, fileName: string, indexLine: string): SkillItem | null {
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
  return {
    name: meta.name || fileName.replace(/\.md$/, ''),
    description: meta.description || firstBodyLine(body),
    argumentHint: '',
    version: '',
    kind: 'memory',
    path: fp,
    updatedAt,
    files: [],
    // 索引行だけが毎セッション注入される。本文は Read されたときだけのコストなので分けて持つ
    indexTokens: indexLine ? estimateTokens(indexLine) : 0,
    bodyTokens: estimateTokens(raw),
    ...(type ? { memoryType: type } : {}),
    ...(originSessionId ? { originSessionId } : {}),
    links: extractLinks(body),
  };
}

/*
 * 列挙の起点は ~/.claude/projects/<encoded>/memory の走査(~/.claude.json の一覧ではない)。
 * memory はリポジトリ単位で、worktree 用のディレクトリは作られないため、
 * 見つけたディレクトリ名を listProjects() のエンコード名で逆引きし、
 * 引けないものは孤児(削除済み/リネーム済みプロジェクト)として表示する。
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
  const currentPaths = new Set([cwdResolved, ...(main ? [main] : [])]);
  /* 並び順の優先度: cwd 完全一致 → メインワークツリー → その他(名前順) */
  const rankOf = (p: string | null): number => (p === cwdResolved ? 0 : main && p === main ? 1 : 2);

  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }

  const sections: MemorySection[] = [];
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
    const items: SkillItem[] = [];
    for (const f of files) {
      const item = readMemoryFile(path.join(memDir, f), f, index.get(f) || '');
      if (item) items.push(item);
    }
    if (!items.length) continue;
    const projectPath = byEncoded.get(d.name) ?? null;
    sections.push({
      id: d.name,
      projectPath,
      // エンコードは不可逆なので、逆引きできない孤児の表示名はエンコード名そのまま
      projectName: projectPath ? path.basename(projectPath) : d.name,
      note: memDir,
      // worktree 用の memory が将来作られたら両方 current になる(統合はしない)
      ...(projectPath && currentPaths.has(projectPath) ? { isCurrent: true } : {}),
      ...(projectPath ? {} : { orphan: true }),
      usageAvailable: false, // 実測は Phase B で算出する
      indexTokens: items.reduce((sum, it) => sum + (it.indexTokens || 0), 0),
      items,
    });
  }

  return sections.sort(
    (a, b) =>
      Number(!!a.orphan) - Number(!!b.orphan) ||
      rankOf(a.projectPath) - rankOf(b.projectPath) ||
      a.projectName.localeCompare(b.projectName),
  );
}
