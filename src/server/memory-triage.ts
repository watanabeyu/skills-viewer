/*
 * AI 棚卸し診断: 自動メモリ 1 件ずつの「行き先」の仮説(verdict + 理由 + 根拠 + 指示文)を
 * 生成する。呼び出しは groups.ts 型の一括(重複・別プロジェクト混入は全件を同時に見せないと
 * 判定できない)、キャッシュは diagnose.ts 型の件単位(本文 hash + lang)というハイブリッド。
 * 再診断は未キャッシュ(= 内容が変わった)件だけを集めて 1 call にまとめる。
 *
 * skills-viewer は memory に一切書き込まない。削減の実体は MEMORY.md の索引行削除だが、
 * そこは Claude Code の管理領域なので「貼れる指示文」を作って本人にやらせる。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  AiModel,
  Lang,
  MemorySection,
  MemoryTriage,
  MemoryVerdict,
  SkillItem,
} from '../shared/types';
import { parseFrontmatter } from './scan';
import { contentHash, runClaude } from './summary';

const TRIAGE_FILE = path.join(os.homedir(), '.cache', 'skills-viewer', 'memory-triage.json');

const VERDICTS: readonly MemoryVerdict[] = [
  'keep',
  'shrink',
  'to-claude-md',
  'to-docs',
  'delete',
  'wrong-project',
];

interface TriageEntry extends MemoryTriage {
  hash: string | null;
  lang: Lang;
  generatedAt: string;
  /* 生成に使ったモデル(記録のみ。stale 判定には使わない) */
  model?: AiModel;
}
export type TriageStore = Record<string, TriageEntry>;

export function loadTriage(): TriageStore {
  try {
    return JSON.parse(fs.readFileSync(TRIAGE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveTriage(store: TriageStore): void {
  fs.mkdirSync(path.dirname(TRIAGE_FILE), { recursive: true });
  fs.writeFileSync(TRIAGE_FILE, JSON.stringify(store, null, 1));
}

/* MEMORY.md(索引)の全文。差分 call でも重複・別プロジェクト判定の文脈として常に渡す */
function readIndexText(memDir: string): string {
  try {
    return fs.readFileSync(path.join(memDir, 'MEMORY.md'), 'utf8').slice(0, 12000);
  } catch {
    return '';
  }
}

function daysAgo(ms?: number): number | null {
  if (!ms) return null;
  return Math.max(0, Math.floor((Date.now() - ms) / 86400000));
}

export interface TriageContext {
  projectName: string;
  /* MEMORY.md の全文(無ければ空文字) */
  index: string;
  /* false = そのプロジェクトの transcript が無い = Read / W-E は計測不能 */
  usageAvailable: boolean;
}

/* 1 件分の事実 + 本文。本文は diagnose.ts と同じく 12,000 字で切る */
function itemBlock(it: SkillItem, usageAvailable: boolean, lang: Lang): string {
  let body = '';
  try {
    body = parseFrontmatter(fs.readFileSync(it.path, 'utf8')).body.trim().slice(0, 12000);
  } catch {
    /* 読めないファイルは事実だけで判定させる */
  }
  const d = daysAgo(it.updatedAt);
  if (lang === 'ja') {
    return [
      '## file: ' + path.basename(it.path),
      'name: ' + it.name,
      'type: ' + (it.memoryType || 'unknown'),
      'description: ' + it.description,
      '最終更新: ' + (d === null ? '不明' : d + '日前'),
      '索引: ' + (it.indexTokens || 0) + ' tok / 本文: ' + (it.bodyTokens || 0) + ' tok',
      usageAvailable
        ? 'Read: ' + (it.useCount || 0) + '回 / Write・Edit: ' + (it.writeCount || 0) + '回'
        : '参照実績: 計測不能(transcript なし)',
      '本文:',
      body,
    ].join('\n');
  }
  return [
    '## file: ' + path.basename(it.path),
    'name: ' + it.name,
    'type: ' + (it.memoryType || 'unknown'),
    'description: ' + it.description,
    'last updated: ' + (d === null ? 'unknown' : d + ' days ago'),
    'index: ' + (it.indexTokens || 0) + ' tok / body: ' + (it.bodyTokens || 0) + ' tok',
    usageAvailable
      ? 'Read: ' + (it.useCount || 0) + ' / Write-Edit: ' + (it.writeCount || 0)
      : 'usage: not measurable (no transcripts)',
    'body:',
    body,
  ].join('\n');
}

/*
 * 対象件の本文 + 事実 + 索引全文をまとめて 1 プロンプトにする。
 * 判定指針は「機械が断定できないこと」だけを渡し、Read 0 を異常扱いさせない注意を必ず添える
 * (feedback 型は索引 1 行で機能するので、本文が読まれないのが正常)。
 */
export function buildPrompt(targets: SkillItem[], ctx: TriageContext, lang: Lang): string {
  const blocks = targets.map((it) => itemBlock(it, ctx.usageAvailable, lang)).join('\n\n');
  const files = targets.map((it) => path.basename(it.path)).join(', ');
  if (lang === 'ja') {
    return (
      'あなたは Claude Code の自動メモリ(~/.claude/projects/<project>/memory/)の棚卸しをします。\n' +
      '自動メモリは二層構造です: MEMORY.md の索引行は全件が毎セッション注入され(常時コスト)、' +
      '各メモリの本文は Read されたときだけ読まれます(従量コスト)。\n' +
      '各メモリの「行き先」を判定し、Claude Code にそのまま貼れる指示文まで作ってください。\n\n' +
      '# 判定指針\n' +
      '| 状態 | 行き先 |\n' +
      '|---|---|\n' +
      '| project 型で完了済み / 設計文書 | docs/ へ(to-docs) |\n' +
      '| project 型で作業中の状態メモ | issue / PR へ移し完了時に削除(to-docs) |\n' +
      '| feedback 型 | 索引 1 行で機能している。本文は縮める(shrink)。強制力が要るなら CLAUDE.md(to-claude-md) |\n' +
      '| reference 型で Read 実績あり | そのまま。触らない(keep) |\n' +
      '| reference 型で長期 Read 0 | 削除(delete)か docs/ へ(to-docs) |\n' +
      '| 別プロジェクトの話 | 移動または削除(wrong-project) |\n\n' +
      '# 注意\n' +
      '- Read 0 は異常ではありません。feedback 型は索引の 1 行だけでエージェントの行動を変えるため、本文が読まれないのが正常です。Read 0 だけを根拠に削除を勧めないこと。\n' +
      '- 「参照実績: 計測不能」の件は、参照回数を根拠に使わないこと。\n' +
      '- 索引行を消さない限り常時コストは 1 tok も減りません。指示文では必ず MEMORY.md の索引行の削除に触れること。\n' +
      '- CLAUDE.md 行きは索引 1 行が全文注入に変わるため、多くの場合コストは増えます。\n\n' +
      '# 出力\n' +
      '次の JSON 配列だけを出力してください(前置き・コードフェンス不要):\n' +
      '[{"file": "対象のファイル名(入力の file をそのまま)",\n' +
      '  "verdict": "keep" | "shrink" | "to-claude-md" | "to-docs" | "delete" | "wrong-project",\n' +
      '  "reason": "そう判断した理由(1〜2文)",\n' +
      '  "issues": ["判断の根拠になった事実(各30字程度、最大4件。無ければ空配列)"],\n' +
      '  "instruction": "Claude Code に貼る指示文(keep のときは空文字)"}]\n\n' +
      '制約:\n' +
      '- 対象ファイル(' +
      files +
      ')それぞれについて 1 要素ずつ、過不足なく出すこと\n' +
      '- verdict は上記 6 値のみ。それ以外の値は使わない\n' +
      '- instruction は 3〜6 行。貼る先はこのプロジェクトで動いている Claude Code 本人なので、' +
      'フルパスや手順の詳細は書かず、意図と見落としやすい要点だけを書く\n' +
      '- instruction に必ず含めること: MEMORY.md の該当索引行の削除 / 他メモリからの [[link]] の張り替え / ' +
      'shrink なら何を残し何を本文から出すかの分割線 / to-claude-md なら「全文が毎セッション注入になり +(本文 tok) tok」というコスト警告\n' +
      '- 6 行に収まらない提案は複雑すぎるサインです。より単純な行き先を選ぶこと\n' +
      '- 出力の文章はすべて日本語で書くこと\n\n' +
      '# プロジェクト: ' +
      ctx.projectName +
      '\n\n# MEMORY.md(索引全文)\n' +
      (ctx.index || '(索引なし)') +
      '\n\n# 対象メモリ\n\n' +
      blocks
    );
  }
  return (
    'You are triaging Claude Code auto memory (~/.claude/projects/<project>/memory/).\n' +
    'Auto memory has two layers: every line of the MEMORY.md index is injected into every session ' +
    '(always-on cost), while each memory body is read only when it is Read (pay-per-use cost).\n' +
    'Decide where each memory should go, and write an instruction the user can paste into Claude Code.\n\n' +
    '# Guidance\n' +
    '| state | destination |\n' +
    '|---|---|\n' +
    '| type project, work already finished / design document | move to docs/ (to-docs) |\n' +
    '| type project, notes on work in progress | move to an issue / PR, delete when done (to-docs) |\n' +
    '| type feedback | already works from the one index line; shrink the body (shrink), or CLAUDE.md if it must be binding (to-claude-md) |\n' +
    '| type reference with Read activity | leave it alone (keep) |\n' +
    '| type reference with no Read for a long time | delete, or move to docs/ (to-docs) |\n' +
    '| belongs to a different project | move or delete (wrong-project) |\n\n' +
    '# Notes\n' +
    '- Read 0 is NOT an anomaly. A feedback memory changes the agent behaviour from its single index ' +
    'line alone, so its body is never read in normal operation. Never recommend deletion on Read 0 alone.\n' +
    '- When usage is "not measurable", do not use read counts as evidence.\n' +
    '- Nothing is saved from the always-on cost unless the index line is removed. Every instruction ' +
    'MUST mention removing the line from MEMORY.md.\n' +
    '- Moving to CLAUDE.md turns one index line into a full-body injection, so it usually costs MORE.\n\n' +
    '# Output\n' +
    'Output ONLY this JSON array (no preamble, no code fences):\n' +
    '[{"file": "the target file name, exactly as given",\n' +
    '  "verdict": "keep" | "shrink" | "to-claude-md" | "to-docs" | "delete" | "wrong-project",\n' +
    '  "reason": "why (1-2 sentences)",\n' +
    '  "issues": ["facts behind the call (about 10 words each, max 4; empty array if none)"],\n' +
    '  "instruction": "instruction to paste into Claude Code (empty string when verdict is keep)"}]\n\n' +
    'Constraints:\n' +
    '- Emit exactly one element for each target file (' +
    files +
    '), no more, no less.\n' +
    '- verdict must be one of the six values above; never invent another value.\n' +
    '- instruction is 3 to 6 lines. It is pasted into the Claude Code session running in THIS project, ' +
    'so state intent and the easy-to-miss points only — no full paths, no step-by-step detail.\n' +
    '- instruction MUST cover: removing the matching line from MEMORY.md; re-pointing [[link]] references ' +
    'from other memories; for shrink, where to cut (what stays, what moves out); for to-claude-md, the cost ' +
    'warning that the full body becomes a per-session injection of +(body tok) tokens.\n' +
    '- A proposal that does not fit in 6 lines is too complex; pick a simpler destination.\n' +
    '- Write all prose in English.\n\n' +
    '# Project: ' +
    ctx.projectName +
    '\n\n# MEMORY.md (full index)\n' +
    (ctx.index || '(no index)') +
    '\n\n# Target memories\n\n' +
    blocks
  );
}

/*
 * 出力を検証つきでパース。file 対応が取れない・verdict が 6 値以外の要素は
 * keep に落とさず捨てる(誤った行き先を提示するより出さない方が安全)。
 */
export function parseTriage(text: string, allowedFiles: string[]): Map<string, MemoryTriage> {
  const stripped = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const j = JSON.parse(stripped);
  if (!Array.isArray(j)) throw new Error('triage output is not an array');
  const allowed = new Set(allowedFiles);
  const out = new Map<string, MemoryTriage>();
  for (const e of j) {
    const file = typeof e?.file === 'string' ? e.file.trim() : '';
    if (!allowed.has(file) || out.has(file)) continue; // 対象外・欠落・重複(先勝ち)
    const verdict = e?.verdict as MemoryVerdict;
    if (!VERDICTS.includes(verdict)) continue;
    const issues = (Array.isArray(e?.issues) ? e.issues : [])
      .filter((x: unknown) => typeof x === 'string')
      .map((s: string) => s.slice(0, 80))
      .slice(0, 4);
    const instruction = verdict === 'keep' ? '' : String(e?.instruction || '').trim();
    out.set(file, {
      verdict,
      reason: String(e?.reason || '')
        .trim()
        .slice(0, 400),
      issues,
      instruction: instruction.slice(0, 1200),
    });
  }
  return out;
}

/*
 * 再診断の対象選定。stale 条件は diagnose.ts と同じく本文 hash + lang のみで、
 * 経過日・Read 実績・他メモリの構成変化ではキャッシュを無効化しない(force で全件)。
 */
export function selectStale(
  items: SkillItem[],
  store: TriageStore,
  lang: Lang,
  force: boolean,
): SkillItem[] {
  if (force) return [...items];
  return items.filter((it) => {
    const cached = store[it.path];
    return !cached || cached.lang !== lang || cached.hash !== contentHash(it.path);
  });
}

export interface TriageResult extends MemoryTriage {
  file: string;
  path: string;
}

/*
 * 1 プロジェクト分の棚卸し。未キャッシュの件だけを集めて claude を 1 回だけ呼ぶ。
 * 入力が大きい(全件の本文)ので timeout は groups.ts と同じ 10 分。
 */
export async function triageProject(
  sec: MemorySection,
  lang: Lang,
  model: AiModel = 'haiku',
  opts: { force?: boolean; files?: string[] } = {},
): Promise<TriageResult[]> {
  const wanted = opts.files?.length ? new Set(opts.files.map((f) => path.basename(f))) : null;
  const targets = wanted
    ? sec.items.filter((it) => wanted.has(path.basename(it.path)))
    : [...sec.items];
  if (!targets.length) return [];

  const store = loadTriage();
  const stale = selectStale(targets, store, lang, !!opts.force);
  if (stale.length) {
    const ctx: TriageContext = {
      projectName: sec.projectName,
      index: readIndexText(sec.note),
      usageAvailable: sec.usageAvailable,
    };
    const text = await runClaude(buildPrompt(stale, ctx, lang), model, 600000);
    const parsed = parseTriage(
      text,
      stale.map((it) => path.basename(it.path)),
    );
    const generatedAt = new Date().toISOString();
    for (const it of stale) {
      const r = parsed.get(path.basename(it.path));
      if (!r) continue; // AI が返さなかった件はキャッシュも結果も作らない
      store[it.path] = { ...r, hash: contentHash(it.path), lang, model, generatedAt };
    }
    saveTriage(store);
  }

  const results: TriageResult[] = [];
  for (const it of targets) {
    const e = store[it.path];
    if (!e) continue;
    results.push({
      file: path.basename(it.path),
      path: it.path,
      verdict: e.verdict,
      reason: e.reason,
      issues: e.issues,
      instruction: e.instruction,
    });
  }
  return results;
}

/*
 * スキャン結果にキャッシュ済み診断を付与(内容が変わっていれば付けない)。
 * store は selectStale と同じくテストから差し替えられるよう引数にする。
 */
export function attachMemoryTriage(
  memory: MemorySection[],
  lang: Lang,
  store: TriageStore = loadTriage(),
): void {
  if (!memory.length) return;
  for (const sec of memory) {
    for (const it of sec.items) {
      const cached = store[it.path];
      if (
        cached &&
        cached.lang === lang &&
        fs.existsSync(it.path) &&
        cached.hash === contentHash(it.path)
      ) {
        it.aiTriage = {
          verdict: cached.verdict,
          reason: cached.reason,
          issues: cached.issues,
          instruction: cached.instruction,
        };
      }
    }
  }
}
