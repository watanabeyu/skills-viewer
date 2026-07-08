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

interface Hit {
  name: string;
  ts: number;
  via: 'typed' | 'auto';
}
export interface UsageAgg {
  typed: number;
  auto: number;
  last: number;
}

const usageCache = new Map<string, { mtimeMs: number; hits: Hit[] }>();

export function extractHits(fp: string): Hit[] {
  const hits: Hit[] = [];
  let raw: string;
  try {
    raw = fs.readFileSync(fp, 'utf8');
  } catch {
    return hits;
  }
  for (const line of raw.split('\n')) {
    const isCmd = line.includes('<command-name>');
    const isSkill = line.includes('"name":"Skill"');
    const isAgent = line.includes('"subagent_type"');
    if (!isCmd && !isSkill && !isAgent) continue;
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
        const a = agg[h.name] || (agg[h.name] = { typed: 0, auto: 0, last: 0 });
        a[h.via === 'typed' ? 'typed' : 'auto']++;
        if (h.ts > a.last) a.last = h.ts;
      }
    }
  }
  return byDir;
}

/* Claude Code のトランスクリプトディレクトリ名と同じ規則でプロジェクトパスをエンコード */
export function encodeProjectPath(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}
