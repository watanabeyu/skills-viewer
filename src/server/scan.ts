/* skill / command / agent / hook / plugin / project のファイルシステムスキャン */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Section, SkillItem } from '../shared/types';

export const HOME = os.homedir();

/* スキャン中だけ本文を保持する内部型(refs 抽出後に破棄) */
type ScanItem = SkillItem & { _body?: string };

/* ---------- frontmatter parsing (minimal YAML: scalars + block scalars) ---------- */

export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  let body = raw;
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (m) {
    body = raw.slice(m[0].length);
    const lines = m[1].split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
      const kv = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!kv) {
        i++;
        continue;
      }
      const key = kv[1];
      let value = kv[2].trim();
      if (value === '|' || value === '>' || value === '|-' || value === '>-') {
        const block: string[] = [];
        i++;
        while (i < lines.length && (lines[i].startsWith('  ') || lines[i].trim() === '')) {
          block.push(lines[i].replace(/^ {2}/, ''));
          i++;
        }
        value = block.join('\n').trim();
      } else {
        value = value.replace(/^["']|["']$/g, '');
        i++;
      }
      meta[key] = value;
    }
  }
  return { meta, body };
}

function firstBodyLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const t = line.replace(/^#+\s*/, '').trim();
    if (t) return t;
  }
  return '';
}

function fileMtime(fp: string): number {
  try {
    return fs.statSync(fp).mtimeMs;
  } catch {
    return 0;
  }
}

/* skill ディレクトリ内のファイル一覧(相対パス、深さ3・40件まで) */
function listFiles(dir: string, prefix = '', depth = 0, acc: string[] = []): string[] {
  if (depth > 3 || acc.length >= 40) return acc;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name === '.DS_Store') continue;
    if (acc.length >= 40) break;
    if (e.isDirectory()) listFiles(path.join(dir, e.name), prefix + e.name + '/', depth + 1, acc);
    else acc.push(prefix + e.name);
  }
  return acc;
}

/* ---------- scanners ---------- */

function readSkillDir(dir: string, nameHint: string): ScanItem | null {
  const skillMd = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) return null;
  const raw = fs.readFileSync(skillMd, 'utf8');
  const { meta, body } = parseFrontmatter(raw);
  return {
    name: meta.name || nameHint,
    description: meta.description || firstBodyLine(body),
    argumentHint: meta['argument-hint'] || '',
    version: meta.version || '',
    kind: 'skill',
    path: skillMd,
    updatedAt: fileMtime(skillMd),
    files: listFiles(dir).sort(),
    _body: body, // 参照抽出用(scanSections で refs 化して破棄)
  };
}

function scanSkillsRoot(root: string): ScanItem[] {
  if (!fs.existsSync(root)) return [];
  const items: ScanItem[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const item = readSkillDir(path.join(root, entry.name), entry.name);
    if (item) items.push(item);
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

/* commands / agents は単一 .md 形式(kind だけ違う) */
function scanMdRoot(root: string, kind: 'command' | 'agent'): ScanItem[] {
  if (!fs.existsSync(root)) return [];
  const items: ScanItem[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const fp = path.join(root, entry.name);
    const raw = fs.readFileSync(fp, 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    items.push({
      name: meta.name || entry.name.replace(/\.md$/, ''),
      description: meta.description || firstBodyLine(body),
      argumentHint: kind === 'command' ? meta['argument-hint'] || '' : '',
      version: meta.version || '',
      kind,
      path: fp,
      updatedAt: fileMtime(fp),
      files: [entry.name],
      _body: body,
    });
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

/* settings.json / settings.local.json の hooks 設定(1 hook = 1 item、読み取り専用) */
function scanHooks(claudeDir: string): ScanItem[] {
  const items: ScanItem[] = [];
  for (const file of ['settings.json', 'settings.local.json']) {
    const fp = path.join(claudeDir, file);
    if (!fs.existsSync(fp)) continue;
    let cfg: any;
    try {
      cfg = JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch {
      continue;
    }
    for (const [event, matchers] of Object.entries(cfg.hooks || {})) {
      for (const m of Array.isArray(matchers) ? matchers : []) {
        for (const h of m.hooks || []) {
          items.push({
            name: event + (m.matcher ? ` (${m.matcher})` : ''),
            description: h.command || JSON.stringify(h),
            argumentHint: '',
            version: '',
            kind: 'hook',
            path: fp,
            updatedAt: fileMtime(fp),
            files: [],
          });
        }
      }
    }
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

function scanClaudeDir(root: string): ScanItem[] {
  const claudeDir = path.join(root, '.claude');
  return [
    ...scanSkillsRoot(path.join(claudeDir, 'skills')),
    ...scanMdRoot(path.join(claudeDir, 'commands'), 'command'),
    ...scanMdRoot(path.join(claudeDir, 'agents'), 'agent'),
    ...scanHooks(claudeDir),
  ];
}

function scanPlugins(): ScanItem[] {
  const manifest = path.join(HOME, '.claude', 'plugins', 'installed_plugins.json');
  if (!fs.existsSync(manifest)) return [];
  let installed: any;
  try {
    installed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  } catch {
    return [];
  }
  const items: ScanItem[] = [];
  for (const [pluginKey, entries] of Object.entries<any>(installed.plugins || {})) {
    const pluginName = pluginKey.split('@')[0];
    for (const entry of (entries as any[]) || []) {
      const installPath = entry.installPath;
      if (!installPath || !fs.existsSync(installPath)) continue;
      for (const skill of scanSkillsRoot(path.join(installPath, 'skills'))) {
        items.push({
          ...skill,
          name: `${pluginName}:${skill.name}`,
          version: skill.version || entry.version || '',
        });
      }
      for (const cmd of scanMdRoot(path.join(installPath, 'commands'), 'command')) {
        items.push({
          ...cmd,
          name: `${pluginName}:${cmd.name}`,
          version: cmd.version || entry.version || '',
        });
      }
      for (const ag of scanMdRoot(path.join(installPath, 'agents'), 'agent')) {
        items.push({
          ...ag,
          name: `${pluginName}:${ag.name}`,
          version: ag.version || entry.version || '',
        });
      }
    }
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

/* projects Claude Code has been used in (registry: ~/.claude.json) + cwd */
export function listProjects(cwd: string): string[] {
  let registered: string[] = [];
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'));
    registered = Object.keys(cfg.projects || {});
  } catch {
    /* no registry — fall back to cwd only */
  }
  const set = new Set(registered.map((p) => path.resolve(p)));
  set.add(path.resolve(cwd));
  set.delete(path.resolve(HOME)); // user-level .claude is its own section
  return [...set].filter((p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

/* built-in skills live inside the Claude Code binary — not scannable, so a static list */
const BUILTIN_DEFS: [string, string][] = [
  ['review', 'GitHub PR のレビュー(作業中の差分は /code-review)'],
  ['security-review', '現在ブランチの変更のセキュリティレビュー'],
  ['code-review', 'ローカル差分/ブランチのコードレビュー(ultra で multi-agent クラウドレビュー)'],
  ['simplify', '変更コードの再利用・簡素化・効率の観点でのクリーンアップ'],
  ['verify', '変更が実際に意図通り動くかをアプリを動かして検証'],
  ['run', 'プロジェクトのアプリを起動して変更を確認'],
  ['init', 'CLAUDE.md の新規作成'],
  ['loop', 'プロンプト/コマンドの定期実行(常駐)'],
  ['schedule', 'cron スケジュールのクラウドエージェント(routine)管理'],
  ['deep-research', 'Web 多源リサーチ + 検証 + 引用付きレポート'],
  ['claude-api', 'Claude API / Anthropic SDK リファレンス'],
  ['update-config', 'settings.json / permissions / hooks の設定変更'],
  ['keybindings-help', 'キーボードショートカットのカスタマイズ'],
  ['fewer-permission-prompts', '許可プロンプト削減のための allowlist 追加'],
];

function builtinItems(): ScanItem[] {
  return BUILTIN_DEFS.map(([name, description]) => ({
    name,
    description,
    argumentHint: '',
    version: '',
    kind: 'skill' as const,
    path: '(Claude Code 本体に同梱)',
    files: [],
  }));
}

/*
 * SKILL.md 本文中の /skill名 を既知の skill 名と突き合わせて参照候補を抽出。
 * - 照合スコープ: project の skill は「同一プロジェクト + user/plugin/built-in」のみ。
 *   他プロジェクトの skill 名は候補にしない(別プロジェクトの同名語句への誤マッチ防止)。
 * - スラッシュコマンドの形( `/x` が単語やパスの一部でない)だけをマッチ。
 *   例: 「reuse/quality」「.claude/skills/foo」「/path/to/x」は対象外。
 */
const SLASH_CMD_RE = /(?<![\w/.@-])\/([a-z0-9][a-z0-9:_-]*)(?![\w/-])/g;

function namesOf(sections: Section[]): Set<string> {
  const set = new Set<string>();
  for (const s of sections) {
    for (const it of s.items) {
      set.add(it.name);
      const short = it.name.split(':').pop();
      if (short) set.add(short);
    }
  }
  return set;
}

function attachRefs(sections: Section[]): void {
  const globalNames = namesOf(sections.filter((s) => s.source !== 'project'));
  for (const s of sections) {
    const known = s.source === 'project' ? new Set([...namesOf([s]), ...globalNames]) : globalNames;
    for (const it of s.items as ScanItem[]) {
      const refs = new Set<string>();
      for (const m of (it._body || '').matchAll(SLASH_CMD_RE)) {
        const cand = m[1];
        if (known.has(cand) && cand !== it.name && cand !== it.name.split(':').pop())
          refs.add(cand);
      }
      it.refs = [...refs];
      delete it._body;
    }
  }
}

/* 並び順: current プロジェクト → 他プロジェクト → user → plugin → built-in */
export function scanSections(cwd: string): Section[] {
  const cwdResolved = path.resolve(cwd);
  const projects = listProjects(cwd)
    .map((p) => ({ path: p, items: scanClaudeDir(p), current: p === cwdResolved }))
    .filter((p) => p.items.length > 0)
    .sort(
      (a, b) =>
        Number(b.current) - Number(a.current) ||
        path.basename(a.path).localeCompare(path.basename(b.path)),
    );

  const sections: Section[] = [
    ...projects.map((p, i) => ({
      id: 'proj-' + i,
      source: 'project' as const,
      heading: 'project — ' + path.basename(p.path) + (p.current ? ' (current)' : ''),
      note: p.path,
      manage: true,
      items: p.items,
    })),
    {
      id: 'user',
      source: 'user',
      heading: 'user',
      manage: true,
      note: path.join(HOME, '.claude'),
      items: scanClaudeDir(HOME),
    },
    {
      id: 'plugin',
      source: 'plugin',
      heading: 'plugin',
      note: path.join(HOME, '.claude', 'plugins'),
      items: scanPlugins(),
    },
    {
      id: 'builtin',
      source: 'built-in',
      heading: 'built-in',
      note: 'Claude Code 本体同梱(静的リスト。正確な一覧は /skills)',
      items: builtinItems(),
    },
  ];
  attachRefs(sections);
  return sections;
}
