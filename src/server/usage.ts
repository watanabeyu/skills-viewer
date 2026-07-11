/*
 * skill / agent 起動履歴の集計。~/.claude/projects/<proj>/<session>.jsonl に残る3形式を拾う:
 *   - user-typed slash:  <command-name>/weall-ship</command-name>
 *   - model via tool:    "name":"Skill","input":{"skill":"weall-ship"
 *   - subagent 起動:      "subagent_type":"code-reviewer"
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

/* ローカルタイムゾーンの日付キー。web 側のスパークラインと同じ形式であること */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const usageCache = new Map<string, { mtimeMs: number; hits: Hit[] }>();

function scanLine(line: string, hits: Hit[]): void {
  const isCmd = line.includes('<command-name>');
  const isSkill = line.includes('"name":"Skill"');
  const isAgent = line.includes('"subagent_type"');
  if (!isCmd && !isSkill && !isAgent) return;
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
}

/*
 * トランスクリプトは合計 GB 級になり得るため全文を一括読みせず、チャンク単位で読んで
 * 行ごとに処理する(メモリ使用はチャンク + 改行待ちの1行分に収まる)。
 * chunkSize はテスト用に指定可能。StringDecoder が境界で割れたマルチバイト文字を繋ぐ。
 */
export function extractHits(fp: string, chunkSize = 1 << 20): Hit[] {
  const hits: Hit[] = [];
  let fd: number;
  try {
    fd = fs.openSync(fp, 'r');
  } catch {
    return hits;
  }
  try {
    const buf = Buffer.alloc(chunkSize);
    const decoder = new StringDecoder('utf8');
    let rest = '';
    let bytes: number;
    while ((bytes = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      const lines = (rest + decoder.write(buf.subarray(0, bytes))).split('\n');
      rest = lines.pop() || '';
      for (const line of lines) scanLine(line, hits);
    }
    rest += decoder.end();
    if (rest) scanLine(rest, hits);
  } catch {
    /* 途中で読めなくなったら部分結果を返す */
  } finally {
    fs.closeSync(fd);
  }
  return hits;
}

/*
 * トランスクリプトの親ディレクトリ = 呼び出し元プロジェクト(パスを [^a-zA-Z0-9]→'-' で
 * エンコードした名前)。同名 skill を正しい定義に帰属させるため、ディレクトリ別に集計する。
 */
export function scanUsageByDir(): Record<string, Record<string, UsageAgg>> {
  const byDir: Record<string, Record<string, UsageAgg>> = {};
  const root = path.join(os.homedir(), '.claude', 'projects');
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return byDir;
  }
  for (const d of dirs) {
    const dir = path.join(root, d.name);
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    const agg = byDir[d.name] || (byDir[d.name] = {});
    for (const f of files) {
      const fp = path.join(dir, f);
      let st: fs.Stats;
      try {
        st = fs.statSync(fp);
      } catch {
        continue;
      }
      let entry = usageCache.get(fp);
      if (!entry || entry.mtimeMs !== st.mtimeMs) {
        entry = { mtimeMs: st.mtimeMs, hits: extractHits(fp) };
        usageCache.set(fp, entry);
      }
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

/* Claude Code のトランスクリプトディレクトリ名と同じ規則でプロジェクトパスをエンコード */
export function encodeProjectPath(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}
