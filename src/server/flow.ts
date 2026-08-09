/*
 * AI フロー図解: SKILL.md からオーケストレーションの処理フローを抽出する
 * (docs/plans/09 参照)。diagnose.ts と同じオンデマンド + content hash + lang キャッシュ。
 * スキーマは LLM が壊しにくい「直列 steps + 分岐注記」に制約し、任意の DAG は扱わない。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AiModel, Lang, Section, SkillFlow, SkillFlowStep } from '../shared/types';
import { contentHash, runClaude } from './summary';

const FLOW_FILE = path.join(os.homedir(), '.cache', 'skills-viewer', 'flows.json');

/*
 * 抽出スキーマの世代。branches.to(ループ/スキップ)追加で 2。
 * 旧世代キャッシュも表示には使い続ける(フローチャート描画は to 無しでも成立し、
 * ループ矢印だけ出ない)が、再抽出時は stale 扱いして新スキーマで作り直す。
 */
const FLOW_SCHEMA_V = 2;

interface FlowEntry extends SkillFlow {
  hash: string | null;
  lang: Lang;
  generatedAt: string;
  /* 生成に使ったモデル(記録のみ。stale 判定には使わない) */
  model?: AiModel;
  /* 生成時の FLOW_SCHEMA_V(v2 より前のエントリは undefined) */
  v?: number;
}
type FlowStore = Record<string, FlowEntry>;

export function loadFlows(): FlowStore {
  try {
    return JSON.parse(fs.readFileSync(FLOW_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveFlows(store: FlowStore): void {
  fs.mkdirSync(path.dirname(FLOW_FILE), { recursive: true });
  fs.writeFileSync(FLOW_FILE, JSON.stringify(store, null, 1));
}

function buildPrompt(name: string, content: string, lang: Lang): string {
  if (lang === 'ja') {
    return (
      '以下は Claude Code の skill 定義です。この skill が実行する処理フローを図解用に抽出し、次の JSON だけを出力してください(前置き・コードフェンス不要):\n' +
      '{"steps": [{"title": "ステップ名(10字程度)", "detail": "何をするか(25字程度)",\n' +
      ' "calls": ["このステップで起動/委譲する他の skill・コマンド名"],\n' +
      ' "gate": "human" | "auto" | null,\n' +
      ' "branches": [{"when": "分岐条件(15字程度)", "then": "その場合の挙動(20字程度)", "to": 行き先ステップ番号}]}]}\n\n' +
      '制約:\n' +
      '- steps は実行順に 4〜8 個(単純な skill なら少なくてよい)\n' +
      '- gate は人間の確認/承認を待つステップだけ "human"(自動で進むなら "auto"、該当なしは null)\n' +
      '- calls は本文に実際に登場する名前のみ(幻覚禁止)\n' +
      '- branches は中断・フォールバック等の分岐だけ(無ければ省略)。when は「テスト失敗」のような判定できる条件文にする\n' +
      '- to は分岐が別ステップへ移るときだけ 1 始まりの番号で(リトライ/ループで前へ戻る場合が典型)。単なる中断・終了なら省略\n\n' +
      '# skill: ' +
      name +
      '\n\n' +
      content
    );
  }
  return (
    'Below is a Claude Code skill definition. Extract the processing flow this skill executes, for a diagram, and output ONLY this JSON (no preamble, no code fences):\n' +
    '{"steps": [{"title": "step name (2-4 words)", "detail": "what it does (about 10 words)",\n' +
    ' "calls": ["other skill/command names this step invokes or delegates to"],\n' +
    ' "gate": "human" | "auto" | null,\n' +
    ' "branches": [{"when": "branch condition (about 5 words)", "then": "behavior in that case (about 7 words)", "to": target step number}]}]}\n\n' +
    'Constraints:\n' +
    '- 4 to 8 steps in execution order (fewer is fine for simple skills)\n' +
    '- gate is "human" ONLY for steps that wait for human confirmation/approval ("auto" if it proceeds automatically, null otherwise)\n' +
    '- calls may contain only names that actually appear in the body (no hallucination)\n' +
    '- branches only for aborts / fallbacks / real forks (omit when none); "when" must be a checkable condition like "tests fail"\n' +
    '- to is the 1-based step number ONLY when the branch jumps to another step (typically looping back for a retry); omit for plain aborts/exits\n\n' +
    '# skill: ' +
    name +
    '\n\n' +
    content
  );
}

/* haiku/sonnet の出力を検証つきでパース(壊れた出力は throw して UI にエラー表示) */
export function parseFlow(text: string): SkillFlow {
  const stripped = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const j = JSON.parse(stripped);
  const steps: SkillFlowStep[] = [];
  for (const s of Array.isArray(j.steps) ? j.steps : []) {
    const title = String(s?.title || '').trim();
    if (!title) continue;
    steps.push({
      title: title.slice(0, 60),
      detail: String(s?.detail || '').slice(0, 120),
      calls: (Array.isArray(s?.calls) ? s.calls : [])
        .filter((c: unknown) => typeof c === 'string' && c)
        .map((c: string) => c.slice(0, 60))
        .slice(0, 6),
      gate: s?.gate === 'human' || s?.gate === 'auto' ? s.gate : null,
      branches: (Array.isArray(s?.branches) ? s.branches : [])
        .filter((b: unknown) => b && typeof (b as any).when === 'string')
        .map((b: any) => ({
          when: String(b.when).slice(0, 60),
          then: String(b.then || '').slice(0, 80),
          ...(Number.isInteger(b.to) && b.to >= 1 ? { to: b.to as number } : {}),
        }))
        .slice(0, 4),
    });
    if (steps.length >= 12) break;
  }
  if (!steps.length) throw new Error('no steps in output');
  // to の上限検証は全 step が出揃ってから(範囲外は to だけ捨てて分岐テキストは残す)
  for (const st of steps)
    for (const b of st.branches) if (b.to !== undefined && b.to > steps.length) delete b.to;
  return { steps };
}

export async function flowOne(
  realPath: string,
  name: string,
  lang: Lang,
  model: AiModel = 'haiku',
): Promise<SkillFlow> {
  const hash = contentHash(realPath);
  const store = loadFlows();
  const cached = store[realPath];
  if (cached && cached.hash === hash && cached.lang === lang && cached.v === FLOW_SCHEMA_V) {
    return { steps: cached.steps };
  }
  const content = fs.readFileSync(realPath, 'utf8').slice(0, 12000);
  const result = parseFlow(await runClaude(buildPrompt(name, content, lang), model));
  store[realPath] = {
    ...result,
    hash,
    lang,
    model,
    v: FLOW_SCHEMA_V,
    generatedAt: new Date().toISOString(),
  };
  saveFlows(store);
  return result;
}

/* スキャン結果にキャッシュ済みフローを付与(内容が変わっていれば付けない) */
export function attachFlows(sections: Section[], lang: Lang): void {
  const store = loadFlows();
  for (const s of sections) {
    for (const it of s.items) {
      const cached = store[it.path];
      if (
        cached &&
        cached.lang === lang &&
        it.path &&
        fs.existsSync(it.path) &&
        cached.hash === contentHash(it.path)
      ) {
        it.aiFlow = { steps: cached.steps };
      }
    }
  }
}
