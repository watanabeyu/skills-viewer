/*
 * skill / agent 起動履歴の集計。~/.claude/projects/<proj>/<session>.jsonl に残る3形式を拾う:
 *   - user-typed slash:  <command-name>/weall-ship</command-name>
 *   - model via tool:    "name":"Skill","input":{"skill":"weall-ship"
 *   - subagent 起動:      "subagent_type":"code-reviewer"
 * 併せて memory ファイルへの操作も同じ 1 パスで拾う(二度読みしない):
 *   - memory の参照/更新: "name":"Read|Write|Edit","input":{…"file_path":"…/memory/x.md"
 * ファイルごとに mtime でキャッシュ。トランスクリプトは Claude Code の保持期間で
 * 削除されるため、集計はその期間内のみ。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

interface Hit {
  name: string;
  ts: number;
  via: 'typed' | 'auto';
}
export interface UsageAgg {
  typed: number;
  auto: number;
  last: number;
  /* 日別回数(YYYY-MM-DD → 回数、ローカルタイムゾーン)。時系列スパークライン用 */
  daily: Record<string, number>;
}

/*
 * memory ファイルへのツール操作 1 件。Read は「参照」、Write / Edit は「作成・更新」なので
 * 区別する。worktree のセッションは親リポジトリの memory を読み書きし、そのトランスクリプトは
 * worktree 側のディレクトリに置かれるため、集計キーはディレクトリではなく file_path(実パス)。
 */
export interface MemHit {
  path: string;
  ts: number;
  kind: 'read' | 'write';
}
export interface MemUsageAgg {
  reads: number;
  writes: number;
  lastRead: number;
  /* 日別 Read 回数(YYYY-MM-DD → 回数、ローカルタイムゾーン) */
  daily: Record<string, number>;
}
/* 1 ファイルのスキャン結果。トランスクリプトを二度読みしないよう両方を同時に取る */
export interface ScanResult {
  hits: Hit[];
  memHits: MemHit[];
}

/* ローカルタイムゾーンの日付キー。web 側のスパークラインと同じ形式であること */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* キャッシュ鍵は実パス + 許可ルート(ルートが変われば拾う memHits も変わるため、mtime だけでは足りない) */
const usageCache = new Map<string, { mtimeMs: number; rootsKey: string } & ScanResult>();

/*
 * 自動メモリの置き場として追加で許可するルート(settings の autoMemoryDirectory)。
 * 既定の ~/.claude/projects/<slug>/memory/ と違い任意のパスなので、形(/memory/)では拾えない。
 * skill 集計と memory 集計は同じ 1 パス(cachedScan)を共有するため、走査の途中で許可ルートが
 * 変わるとキャッシュが無効化されて transcript を二度読みすることになる。よって値は
 * リクエストの入口で 1 回だけ設定し、以降は同じ値で走査する。
 * 未設定なら空配列 = 従来どおりのコストで、既定環境の走査量は増えない。
 */
let memoryRoots: string[] = [];
export function setMemoryRoots(roots: string[]): void {
  memoryRoots = roots;
}

function underRoot(fp: string, root: string): boolean {
  return fp.startsWith(root + '/') || fp.startsWith(root + path.sep);
}

function scanLine(line: string, out: ScanResult, extraRoots: string[] = []): void {
  const hits = out.hits;
  const isCmd = line.includes('<command-name>');
  const isSkill = line.includes('"name":"Skill"');
  const isAgent = line.includes('"subagent_type"');
  // memory 本文への Read / Write / Edit だけが対象なので、/memory/(と許可ルート)を含まない行は
  // 正規表現にかけない(file_path を持つ行は transcript の大半を占めるため、この前置きが起動時間に効く)
  const isFile =
    line.includes('"file_path"') &&
    (line.includes('/memory/') || extraRoots.some((r) => line.includes(r)));
  if (!isCmd && !isSkill && !isAgent && !isFile) return;
  const tm = line.match(/"timestamp":"([^"]+)"/);
  const ts = tm ? Date.parse(tm[1]) || 0 : 0;
  if (isCmd) {
    for (const m of line.matchAll(/<command-name>\/?([^<]+)<\/command-name>/g)) {
      hits.push({ name: m[1].trim(), ts, via: 'typed' });
    }
  }
  if (isSkill) {
    for (const m of line.matchAll(/"name":"Skill","input":\{"skill":"([^"]+)"/g)) {
      hits.push({ name: m[1], ts, via: 'auto' });
    }
  }
  if (isAgent) {
    // Agent/Task ツールによるサブエージェント起動(agent 定義の使用実績として扱う)
    for (const m of line.matchAll(/"subagent_type":"([^"]+)"/g)) {
      hits.push({ name: m[1], ts, via: 'auto' });
    }
  }
  if (isFile) {
    // memory 本文への Read / Write / Edit のみを拾う(skill ファイル等の操作は対象外)。
    // input のキー順は固定ではない(実データの Edit は {"replace_all":…,"file_path":…} の順)ので
    // file_path を第 1 キーと決め打ちしない。走査量を抑えるため間は 160 字までの遅延一致にする。
    for (const m of line.matchAll(
      /"name":"(Read|Write|Edit)","input":\{[^{}]{0,160}?"file_path":"([^"]+)"/g,
    )) {
      const fp = m[2];
      // 自動メモリは <encoded>/memory/ 直下の *.md。ここでは形だけで拾い、
      // 置き場(~/.claude/projects 相当)の判定は scanMemoryUsage(root) の後段に任せる
      // (root をテスト・設定で差し替えても判定が効くように)。
      // 許可ルート(autoMemoryDirectory)配下は形が違う(直下の *.md)ので別条件で拾う
      const shaped =
        /\/memory\/[^/]+\.md$/.test(fp) ||
        extraRoots.some((r) => underRoot(fp, r) && /\.md$/.test(fp));
      if (!shaped) continue;
      // MEMORY.md は索引であって一覧のアイテムではないので除外する。
      if (path.posix.basename(fp) === 'MEMORY.md') continue;
      out.memHits.push({ path: fp, ts, kind: m[1] === 'Read' ? 'read' : 'write' });
    }
  }
}

/*
 * トランスクリプトは合計 GB 級になり得るため全文を一括読みせず、チャンク単位で読んで
 * 行ごとに処理する(メモリ使用はチャンク + 改行待ちの1行分に収まる)。
 * chunkSize はテスト用に指定可能。StringDecoder が境界で割れたマルチバイト文字を繋ぐ。
 */
export function scanTranscript(
  fp: string,
  chunkSize = 1 << 20,
  /* 自動メモリとして追加で許可する置き場のルート(autoMemoryDirectory) */
  extraRoots: string[] = [],
): ScanResult {
  const out: ScanResult = { hits: [], memHits: [] };
  let fd: number;
  try {
    fd = fs.openSync(fp, 'r');
  } catch {
    return out;
  }
  try {
    const buf = Buffer.alloc(chunkSize);
    const decoder = new StringDecoder('utf8');
    let rest = '';
    let bytes: number;
    while ((bytes = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      const lines = (rest + decoder.write(buf.subarray(0, bytes))).split('\n');
      rest = lines.pop() || '';
      for (const line of lines) scanLine(line, out, extraRoots);
    }
    rest += decoder.end();
    if (rest) scanLine(rest, out, extraRoots);
  } catch {
    /* 途中で読めなくなったら部分結果を返す */
  } finally {
    fs.closeSync(fd);
  }
  return out;
}

/* skill / agent 起動だけを見たい呼び出し元向けの薄いラッパ */
export function extractHits(fp: string, chunkSize = 1 << 20): Hit[] {
  return scanTranscript(fp, chunkSize).hits;
}

/* mtime キャッシュ経由で 1 ファイル分のスキャン結果を得る(skill / memory 集計で共用) */
function cachedScan(fp: string): ScanResult | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(fp);
  } catch {
    return null;
  }
  // 許可ルートが変わると拾う memHits も変わるので、mtime と一緒に鍵にする
  const rootsKey = memoryRoots.join('\0');
  let entry = usageCache.get(fp);
  if (!entry || entry.mtimeMs !== st.mtimeMs || entry.rootsKey !== rootsKey) {
    entry = { mtimeMs: st.mtimeMs, rootsKey, ...scanTranscript(fp, undefined, memoryRoots) };
    usageCache.set(fp, entry);
  }
  return entry;
}

/* ~/.claude/projects 配下の <ディレクトリ名, jsonl 実パス[]> 一覧(root はテストで差し替える) */
function listTranscripts(root: string): { name: string; files: string[] }[] {
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  const out: { name: string; files: string[] }[] = [];
  for (const d of dirs) {
    const dir = path.join(root, d.name);
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    out.push({ name: d.name, files: files.map((f) => path.join(dir, f)) });
  }
  return out;
}

/*
 * トランスクリプトの親ディレクトリ = 呼び出し元プロジェクト(パスを [^a-zA-Z0-9]→'-' で
 * エンコードした名前)。同名 skill を正しい定義に帰属させるため、ディレクトリ別に集計する。
 */
export function scanUsageByDir(): Record<string, Record<string, UsageAgg>> {
  const byDir: Record<string, Record<string, UsageAgg>> = {};
  const root = path.join(os.homedir(), '.claude', 'projects');
  for (const d of listTranscripts(root)) {
    const agg = byDir[d.name] || (byDir[d.name] = {});
    for (const fp of d.files) {
      const entry = cachedScan(fp);
      if (!entry) continue;
      for (const h of entry.hits) {
        const a = agg[h.name] || (agg[h.name] = { typed: 0, auto: 0, last: 0, daily: {} });
        a[h.via === 'typed' ? 'typed' : 'auto']++;
        if (h.ts > a.last) a.last = h.ts;
        if (h.ts > 0) {
          const day = dayKey(h.ts);
          a.daily[day] = (a.daily[day] || 0) + 1;
        }
      }
    }
  }
  return byDir;
}

/*
 * memory ファイルの Read / Write / Edit 実績。worktree のセッションは親リポジトリの memory を
 * 触り、そのトランスクリプトは worktree 側のディレクトリに残るため、ディレクトリ別ではなく
 * 全ディレクトリ横断・file_path キーで集計し、root 配下のパスだけを自動メモリとして採る。
 * dirsWithTranscripts は jsonl を 1 件以上持つディレクトリ名(usageAvailable 判定用。
 * 走査を共有するためここで一緒に返す)。
 */
export function scanMemoryUsage(
  root = path.join(os.homedir(), '.claude', 'projects'),
  /* 追加で自動メモリとみなす置き場(autoMemoryDirectory)。省略時は設定済みの値のまま */
  allowRoots?: string[],
): {
  byPath: Record<string, MemUsageAgg>;
  dirsWithTranscripts: Set<string>;
} {
  if (allowRoots) setMemoryRoots(allowRoots);
  const byPath: Record<string, MemUsageAgg> = {};
  const dirsWithTranscripts = new Set<string>();
  for (const d of listTranscripts(root)) {
    if (d.files.length) dirsWithTranscripts.add(d.name);
    for (const fp of d.files) {
      const entry = cachedScan(fp);
      if (!entry) continue;
      for (const h of entry.memHits) {
        // root 外の memory/ ディレクトリ(リポジトリ内の src/memory/*.md など)は自動メモリではない。
        // 許可ルート(autoMemoryDirectory)配下は root 外でも自動メモリとして採る
        if (!underRoot(h.path, root) && !memoryRoots.some((r) => underRoot(h.path, r))) continue;
        const a =
          byPath[h.path] || (byPath[h.path] = { reads: 0, writes: 0, lastRead: 0, daily: {} });
        if (h.kind === 'write') {
          a.writes++;
          continue; // 日別・最終参照は Read(参照)だけを数える
        }
        a.reads++;
        if (h.ts > a.lastRead) a.lastRead = h.ts;
        if (h.ts > 0) {
          const day = dayKey(h.ts);
          a.daily[day] = (a.daily[day] || 0) + 1;
        }
      }
    }
  }
  return { byPath, dirsWithTranscripts };
}

/*
 * そのプロジェクトの transcript が 1 件でもあるか(usageAvailable 判定)。
 * worktree のディレクトリ名は親のエンコード名 + '-' で始まるので前方一致も許すが、
 * 区切りを要求しないと -Users-x-repo2 が -Users-x-repo に一致してしまう。
 */
export function hasTranscripts(dirs: Set<string>, encoded: string): boolean {
  return dirs.has(encoded) || [...dirs].some((d) => d.startsWith(encoded + '-'));
}

/* Claude Code のトランスクリプトディレクトリ名と同じ規則でプロジェクトパスをエンコード */
export function encodeProjectPath(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}
