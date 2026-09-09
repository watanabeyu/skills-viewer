/* skill / command / agent / hook / plugin / project のファイルシステムスキャン */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Lang, Section, SkillItem } from '../shared/types';
import { estimateTokens, lintItem } from './lint';
import { encodeProjectPath } from './usage';

export const HOME = os.homedir();

/* スキャン中だけ本文を保持する内部型(refs 抽出後に破棄) */
type ScanItem = SkillItem & { _body?: string };

/* ---------- frontmatter parsing (minimal YAML: scalars + block scalars + 1段ネスト) ---------- */

/* スカラー値のクォート剥がし(double-quote は edit.ts の書き込みと対になる JSON 互換) */
function scalarValue(value: string): string {
  if (/^".*"$/.test(value)) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  return value.replace(/^'|'$/g, '');
}

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
      } else if (value === '' && /^\s+\S/.test(lines[i + 1] || '')) {
        // 値なし行 + インデント行 = 1段ネストのマップ(memory の `metadata:` 配下)。
        // 親キーは従来どおり空文字で残し、子は `metadata.type` のドット key で持たせる
        meta[key] = value;
        i++;
        while (i < lines.length && /^\s+\S/.test(lines[i])) {
          const child = lines[i].match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
          if (child) meta[key + '.' + child[1]] = scalarValue(child[2].trim());
          i++;
        }
        continue;
      } else {
        value = scalarValue(value);
        i++;
      }
      meta[key] = value;
    }
  }
  return { meta, body };
}

export function firstBodyLine(body: string): string {
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

/*
 * frontmatter の真偽値。parseFrontmatter は値を正規化せず生文字列を返すので、
 * YAML 的に真である True / TRUE / yes も拾う(取りこぼすと「モデルから呼べない」表示が
 * 誤るうえ、description が予算に計上されてしまう)。
 */
const isTruthy = (v: string | undefined) => /^(true|yes)$/i.test((v || '').trim());

/* hidden / allowedTools の組み立て。readSkillDir と scanMdRoot で同じ規則を使う */
function metaFlags(meta: Record<string, string>): { hidden?: true; allowedTools?: string[] } {
  const tools = allowedToolsOf(meta);
  return {
    ...(isTruthy(meta['disable-model-invocation']) ? { hidden: true as const } : {}),
    ...(tools ? { allowedTools: tools } : {}),
  };
}

/*
 * frontmatter の allowed-tools。実データは `Read, Write, Bash(git *), ...` の
 * カンマ区切り 1 行(YAML リストではない)。空なら undefined を返す。
 */
export function allowedToolsOf(meta: Record<string, string>): string[] | undefined {
  const raw = meta['allowed-tools'];
  if (!raw) return undefined;
  const list = raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return list.length ? list : undefined;
}

function readSkillDir(dir: string, nameHint: string): ScanItem | null {
  const skillMd = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(skillMd, 'utf8');
  } catch {
    return null; // 権限エラー等で読めない skill はスキップ(一覧全体を落とさない)
  }
  const { meta, body } = parseFrontmatter(raw);
  const name = meta.name || nameHint;
  const lint = lintItem(meta, name, 'skill');
  return {
    name,
    description: meta.description || firstBodyLine(body),
    argumentHint: meta['argument-hint'] || '',
    version: meta.version || '',
    kind: 'skill',
    path: skillMd,
    updatedAt: fileMtime(skillMd),
    files: listFiles(dir).sort(),
    ...(meta.category ? { category: meta.category } : {}),
    ...metaFlags(meta),
    ...(lint.length ? { lint } : {}),
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
    let raw: string;
    try {
      raw = fs.readFileSync(fp, 'utf8');
    } catch {
      continue; // 読めないファイルはスキップ(一覧全体を落とさない)
    }
    const { meta, body } = parseFrontmatter(raw);
    const name = meta.name || entry.name.replace(/\.md$/, '');
    const lint = lintItem(meta, name, kind);
    items.push({
      name,
      description: meta.description || firstBodyLine(body),
      argumentHint: kind === 'command' ? meta['argument-hint'] || '' : '',
      version: meta.version || '',
      kind,
      path: fp,
      updatedAt: fileMtime(fp),
      files: [entry.name],
      ...(meta.category ? { category: meta.category } : {}),
      ...metaFlags(meta),
      ...(lint.length ? { lint } : {}),
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
const BUILTIN_DEFS: [name: string, ja: string, en: string][] = [
  [
    'review',
    'GitHub PR のレビュー(作業中の差分は /code-review)',
    'Review a GitHub PR (use /code-review for your working diff)',
  ],
  [
    'security-review',
    '現在ブランチの変更のセキュリティレビュー',
    'Security review of the changes on the current branch',
  ],
  [
    'code-review',
    'ローカル差分/ブランチのコードレビュー(ultra で multi-agent クラウドレビュー)',
    'Code review of a local diff / branch (ultra runs a multi-agent cloud review)',
  ],
  [
    'simplify',
    '変更コードの再利用・簡素化・効率の観点でのクリーンアップ',
    'Clean up changed code for reuse, simplification and efficiency',
  ],
  [
    'verify',
    '変更が実際に意図通り動くかをアプリを動かして検証',
    'Verify a change actually works by exercising the app',
  ],
  [
    'run',
    'プロジェクトのアプリを起動して変更を確認',
    "Launch the project's app to see a change working",
  ],
  ['init', 'CLAUDE.md の新規作成', 'Initialize a new CLAUDE.md'],
  [
    'loop',
    'プロンプト/コマンドの定期実行(常駐)',
    'Run a prompt or command on a recurring interval',
  ],
  [
    'schedule',
    'cron スケジュールのクラウドエージェント(routine)管理',
    'Manage scheduled cloud agents (routines) on a cron schedule',
  ],
  [
    'deep-research',
    'Web 多源リサーチ + 検証 + 引用付きレポート',
    'Multi-source web research with verification and a cited report',
  ],
  ['claude-api', 'Claude API / Anthropic SDK リファレンス', 'Claude API / Anthropic SDK reference'],
  [
    'update-config',
    'settings.json / permissions / hooks の設定変更',
    'Configure settings.json / permissions / hooks',
  ],
  ['keybindings-help', 'キーボードショートカットのカスタマイズ', 'Customize keyboard shortcuts'],
  [
    'fewer-permission-prompts',
    '許可プロンプト削減のための allowlist 追加',
    'Add an allowlist to reduce permission prompts',
  ],
];

/* path='' は実ファイルなし(Claude Code 本体同梱)を表す。表示文言はクライアント側で解決 */
function builtinItems(lang: Lang): ScanItem[] {
  return BUILTIN_DEFS.map(([name, ja, en]) => ({
    name,
    description: lang === 'ja' ? ja : en,
    argumentHint: '',
    version: '',
    kind: 'skill' as const,
    path: '',
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

/*
 * project セクションの id。URL(?project=<id>)に載せて共有・リロードをまたぐので、
 * 配列の位置ではなくパスから決める(設計判断 13)。listProjects は毎リクエスト
 * ~/.claude.json を読み直し、アイテム 0 件のプロジェクトを除いて並べ替えるため、
 * 位置ベース('proj-' + index)だとプロジェクトの増減で指す先がずれる。
 * エンコードは transcript のディレクトリ名・MemorySection.id と同じ規則。
 */
export const projectSectionId = (projectPath: string): string =>
  'proj-' + encodeProjectPath(path.resolve(projectPath));

/* 並び順: current プロジェクト → 他プロジェクト → user → plugin → built-in */
export function scanSections(cwd: string, lang: Lang = 'en'): Section[] {
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
    ...projects.map((p) => ({
      id: projectSectionId(p.path),
      source: 'project' as const,
      projectName: path.basename(p.path),
      isCurrent: p.current,
      note: p.path,
      items: p.items,
    })),
    {
      id: 'user',
      source: 'user',
      note: path.join(HOME, '.claude'),
      items: scanClaudeDir(HOME),
    },
    {
      id: 'plugin',
      source: 'plugin',
      note: path.join(HOME, '.claude', 'plugins'),
      items: scanPlugins(),
    },
    {
      id: 'builtin',
      source: 'built-in',
      note: '',
      items: builtinItems(lang),
    },
  ];
  attachRefs(sections);
  // name + description は毎セッション注入されるため、その分のトークンを概算しておく。
  // hook は設定エントリ(description 注入なし)、hidden はモデルの一覧に載らないので対象外
  for (const s of sections) {
    for (const it of s.items) {
      if (it.kind !== 'hook' && !it.hidden)
        it.tokens = estimateTokens(it.name + ': ' + it.description);
    }
  }
  return sections;
}
