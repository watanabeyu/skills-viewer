/*
 * AI 要約 + 起動分類: claude CLI headless (haiku) で SKILL.md を分析し、
 * 内容ハッシュをキーに ~/.cache/skills-viewer/summaries.json へキャッシュ。
 * ハッシュが一致する限り再生成しない(mtime でなくハッシュなので同期や clone に強い)。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import type {
  Invocation,
  Lang,
  RelationType,
  Section,
  SkillAnalysis,
  SummaryJob,
} from '../shared/types';
import { srvMsg } from './locale';

const CACHE_DIR = path.join(os.homedir(), '.cache', 'skills-viewer');
const SUMMARY_FILE = path.join(CACHE_DIR, 'summaries.json');

// 旧パッケージ名時代のキャッシュがあれば一度だけ引き継ぐ
for (const legacy of ['claude-code-my-skills', 'claude-skills-browser']) {
  const legacyDir = path.join(os.homedir(), '.cache', legacy);
  if (!fs.existsSync(CACHE_DIR) && fs.existsSync(legacyDir)) {
    try {
      fs.renameSync(legacyDir, CACHE_DIR);
    } catch {
      /* 失敗しても新規生成される */
    }
  }
}

interface CacheEntry extends Partial<SkillAnalysis> {
  hash: string | null;
  name: string;
  summary: string;
  generatedAt: string;
  lang?: Lang;
}

type SummaryStore = Record<string, CacheEntry>;

/* relation type の正規化: 新キー以外(多言語対応前の日本語値・幻覚)は references に落とす */
const REL_TYPES: readonly RelationType[] = ['invokes', 'delegates', 'called-by', 'references'];
const LEGACY_REL: Record<string, RelationType> = {
  起動: 'invokes',
  委譲: 'delegates',
  呼ばれる側: 'called-by',
  参照: 'references',
};
function normalizeRelType(t: unknown): RelationType {
  if (REL_TYPES.includes(t as RelationType)) return t as RelationType;
  return LEGACY_REL[String(t)] || 'references';
}

export function loadSummaries(): SummaryStore {
  try {
    const store: SummaryStore = JSON.parse(fs.readFileSync(SUMMARY_FILE, 'utf8'));
    // 多言語対応前のキャッシュは日本語生成・日本語 relation type なので読み込み時に正規化する
    for (const e of Object.values(store)) {
      if (!e.lang) e.lang = 'ja';
      for (const r of e.relations || []) r.type = normalizeRelType(r.type);
    }
    return store;
  } catch {
    return {};
  }
}
function saveSummaries(s: SummaryStore): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(s, null, 1));
}
export function contentHash(fp: string): string | null {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

interface SummarizeTarget {
  path: string;
  name: string;
  refs?: string[];
}

/* 分析プロンプト。relation type は言語非依存のキーで出力させ、表示はクライアント側で解決 */
function buildPrompt(it: SummarizeTarget, refs: string[], content: string, lang: Lang): string {
  if (lang === 'ja') {
    return (
      '以下は Claude Code の skill 定義ファイルです。読んで、次の JSON だけを出力してください(前置き・コードフェンス不要):\n' +
      '{"summary": "何をする skill か・いつ使うかが伝わる日本語の要約(最大2文。手順の羅列でなく用途と価値)",\n' +
      ' "invocation": "human" | "agent" | "both",\n' +
      ' "invocationReason": "判定理由(日本語で15字程度)",\n' +
      ' "relations": [{"name": "skill名", "type": "invokes" | "delegates" | "called-by" | "references", "note": "関係の説明(日本語で15字程度)"}]}\n\n' +
      'invocation は「人間が意図してコマンドとして打つ起点(human)」「他の skill やエージェントから部品・後続として呼ばれる想定(agent)」「両方(both)」のどれか。\n' +
      'relations の type は「相手を起動する(invokes)」「相手に処理を委ねる(delegates)」「相手から呼ばれる(called-by)」「言及・参照のみ(references)」のどれか。\n' +
      (refs.length
        ? 'relations の name は次の候補のみ使用し、実質的な関係が読み取れるものだけ含める: ' +
          refs.join(', ') +
          '\n'
        : 'この skill に他 skill への言及は見つかっていないため relations は [] とすること。\n') +
      '\n# skill: ' +
      it.name +
      '\n\n' +
      content
    );
  }
  return (
    'Below is a Claude Code skill definition file. Read it and output ONLY the following JSON (no preamble, no code fences):\n' +
    '{"summary": "English summary conveying what the skill does and when to use it (max 2 sentences; purpose and value, not a list of steps)",\n' +
    ' "invocation": "human" | "agent" | "both",\n' +
    ' "invocationReason": "reason for the verdict (about 8 words)",\n' +
    ' "relations": [{"name": "skill name", "type": "invokes" | "delegates" | "called-by" | "references", "note": "short note on the relation (about 8 words)"}]}\n\n' +
    'invocation: "human" = a human deliberately types it as a command, "agent" = meant to be called by other skills/agents as a building block, "both" = both.\n' +
    'relation type: "invokes" = this skill launches the other, "delegates" = hands work off to it, "called-by" = is called by it, "references" = merely mentions it.\n' +
    (refs.length
      ? 'Use ONLY these candidates as relation names, and include only relations that are substantively present: ' +
        refs.join(', ') +
        '\n'
      : 'No mentions of other skills were found, so relations MUST be [].\n') +
    '\n# skill: ' +
    it.name +
    '\n\n' +
    content
  );
}

/*
 * 1 skill を haiku で分析し {summary, invocation, invocationReason, relations} を返す。
 * relations の候補(refs)は静的解析で抽出済みの既知 skill 名のみに制限し、幻覚を防ぐ。
 */
export function summarizeOne(it: SummarizeTarget, lang: Lang): Promise<SkillAnalysis> {
  return new Promise((resolve, reject) => {
    let content: string;
    try {
      content = fs.readFileSync(it.path, 'utf8').slice(0, 12000);
    } catch (e) {
      return reject(e);
    }
    const refs = it.refs || [];
    const prompt = buildPrompt(it, refs, content, lang);
    // --tools '' で全ツールを無効化: SKILL.md は clone したリポジトリ由来もあり得るため、
    // 本文に指示が仕込まれていても純粋なテキスト生成の外に出られないようにする
    const child = spawn('claude', ['-p', '--model', 'haiku', '--tools', ''], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '',
      errOut = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('timeout (120s)'));
    }, 120000);
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      errOut += d;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = out.trim();
      if (code !== 0 || !text)
        return reject(new Error(errOut.trim().slice(0, 200) || 'claude exited ' + code));
      resolve(parseAnalysis(text, refs));
    });
    child.stdin.end(prompt);
  });
}

/* haiku の出力を検証つきでパース。壊れていたら全文を summary として扱う */
export function parseAnalysis(text: string, refs: string[]): SkillAnalysis {
  const stripped = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try {
    const j = JSON.parse(stripped);
    const invocation: Invocation | null = ['human', 'agent', 'both'].includes(j.invocation)
      ? j.invocation
      : null;
    const refSet = new Set(refs);
    const relations = Array.isArray(j.relations)
      ? j.relations
          .filter((r: any) => r && typeof r.name === 'string' && refSet.has(r.name))
          .map((r: any) => ({
            name: r.name as string,
            type: normalizeRelType(r.type),
            note: String(r.note || '').slice(0, 40),
          }))
      : [];
    return {
      summary: String(j.summary || '').trim() || stripped,
      invocation,
      invocationReason: String(j.invocationReason || '').slice(0, 40),
      relations,
    };
  } catch {
    return { summary: stripped, invocation: null, invocationReason: '', relations: [] };
  }
}

export function saveSummary(
  realPath: string,
  name: string,
  analysis: SkillAnalysis,
  lang: Lang,
): void {
  const summaries = loadSummaries();
  summaries[realPath] = {
    hash: contentHash(realPath),
    name,
    summary: analysis.summary,
    invocation: analysis.invocation ?? undefined,
    invocationReason: analysis.invocationReason,
    relations: analysis.relations,
    generatedAt: new Date().toISOString(),
    lang,
  };
  saveSummaries(summaries);
}

/* 要約対象 = 実ファイルを持つ skill/command/agent(hook は設定エントリなので除外) */
function summarizableItems(sections: Section[]): SummarizeTarget[] {
  const out: SummarizeTarget[] = [];
  for (const sec of sections) {
    for (const it of sec.items) {
      if (it.kind === 'hook') continue;
      if (!fs.existsSync(it.path)) continue; // built-in
      out.push({ path: it.path, name: it.name, refs: it.refs || [] });
    }
  }
  return out;
}

/* 未生成・内容変更に加え、要約の生成言語が表示言語と違うものも「未生成」扱いにする */
export function staleItems(sections: Section[], lang: Lang): SummarizeTarget[] {
  const summaries = loadSummaries();
  return summarizableItems(sections).filter((it) => {
    const cached = summaries[it.path];
    return (
      !cached ||
      cached.hash !== contentHash(it.path) ||
      cached.invocation === undefined ||
      cached.lang !== lang
    );
  });
}

let summaryJob: SummaryJob | null = null;

export function startSummarizeAll(sections: Section[], force: boolean, lang: Lang): SummaryJob {
  if (summaryJob && !summaryJob.finished) return summaryJob;
  const items = force ? summarizableItems(sections) : staleItems(sections, lang);
  summaryJob = {
    total: items.length,
    done: 0,
    current: '',
    errors: [],
    finished: items.length === 0,
  };
  if (summaryJob.finished) return summaryJob;
  const job = summaryJob;
  (async () => {
    let idx = 0;
    const worker = async () => {
      while (idx < items.length) {
        const it = items[idx++];
        job.current = it.name;
        try {
          const analysis = await summarizeOne(it, lang);
          saveSummary(it.path, it.name, analysis, lang);
        } catch (e) {
          job.errors.push(it.name + ': ' + (e instanceof Error ? e.message : String(e)));
        }
        job.done++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, items.length) }, worker));
    job.finished = true;
    console.log(
      srvMsg(
        `summarize: ${job.done}件完了, エラー ${job.errors.length}件`,
        `summarize: ${job.done} done, ${job.errors.length} error(s)`,
      ),
    );
  })();
  return summaryJob;
}

export function summaryStatus(): SummaryJob {
  return summaryJob || { finished: true, total: 0, done: 0, errors: [] };
}
