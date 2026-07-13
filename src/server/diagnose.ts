/*
 * AI 発動診断: description が「モデルの自動発動判断」に足るかを haiku で診断し、
 * 指摘と改善版 description を返す。summary.ts と同じく content hash + lang で
 * ~/.cache/skills-viewer/diagnoses.json にキャッシュし、内容が変わらない限り再生成しない。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Lang, Section, SkillDiagnosis } from '../shared/types';
import { contentHash, runHaiku } from './summary';

const DIAG_FILE = path.join(os.homedir(), '.cache', 'skills-viewer', 'diagnoses.json');

interface DiagEntry extends SkillDiagnosis {
  hash: string | null;
  lang: Lang;
  generatedAt: string;
}
type DiagStore = Record<string, DiagEntry>;

export function loadDiagnoses(): DiagStore {
  try {
    return JSON.parse(fs.readFileSync(DIAG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveDiagnoses(store: DiagStore): void {
  fs.mkdirSync(path.dirname(DIAG_FILE), { recursive: true });
  fs.writeFileSync(DIAG_FILE, JSON.stringify(store, null, 1));
}

function buildPrompt(name: string, content: string, lang: Lang): string {
  if (lang === 'ja') {
    return (
      '以下は Claude Code の skill 定義ファイルです。モデルは frontmatter の name と description **だけ**を見て、' +
      'このスキルを自動発動するか判断します(本文は発動後にしか読まれません)。\n' +
      'description の「発動性」を診断し、次の JSON だけを出力してください(前置き・コードフェンス不要):\n' +
      '{"verdict": "good" | "weak",\n' +
      ' "issues": ["問題点(日本語で各25字程度、最大4件。無ければ空配列)"],\n' +
      ' "improved": "改善版 description(日本語)。本文から読み取れる発動条件(〜するとき、〜と頼まれたとき等)を必ず含め、200字以内"}\n\n' +
      'verdict は、description だけでモデルが適切な場面で発動を判断できるなら good、曖昧・条件不足なら weak。\n' +
      'improved は verdict が good でも、より良くできるなら改善版を出すこと(現状のままで良ければ元の文をそのまま)。\n\n' +
      '# skill: ' +
      name +
      '\n\n' +
      content
    );
  }
  return (
    'Below is a Claude Code skill definition file. The model decides whether to auto-invoke this skill ' +
    'based **only** on the frontmatter name and description (the body is read only after invocation).\n' +
    'Diagnose how well the description triggers invocation, and output ONLY this JSON (no preamble, no code fences):\n' +
    '{"verdict": "good" | "weak",\n' +
    ' "issues": ["problem (about 10 words each, max 4; empty array if none)"],\n' +
    ' "improved": "improved description in English; MUST include trigger conditions readable from the body (\\"use when …\\"), max 400 chars"}\n\n' +
    'verdict: good if the description alone lets the model invoke at the right moments; weak if vague or missing conditions.\n' +
    'improved: even when verdict is good, propose a better version if possible (return the original text if it is already ideal).\n\n' +
    '# skill: ' +
    name +
    '\n\n' +
    content
  );
}

/* haiku の出力を検証つきでパース(壊れた出力は reject して UI にエラー表示) */
export function parseDiagnosis(text: string): SkillDiagnosis {
  const stripped = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const j = JSON.parse(stripped);
  const verdict = j.verdict === 'good' ? 'good' : 'weak';
  const issues = Array.isArray(j.issues)
    ? j.issues.filter((x: unknown) => typeof x === 'string').map((s: string) => s.slice(0, 80))
    : [];
  const improved = String(j.improved || '').trim();
  if (!improved) throw new Error('empty improved description');
  return { verdict, issues: issues.slice(0, 4), improved };
}

export async function diagnoseOne(
  realPath: string,
  name: string,
  lang: Lang,
): Promise<SkillDiagnosis> {
  const hash = contentHash(realPath);
  const store = loadDiagnoses();
  const cached = store[realPath];
  if (cached && cached.hash === hash && cached.lang === lang) {
    return { verdict: cached.verdict, issues: cached.issues, improved: cached.improved };
  }
  const content = fs.readFileSync(realPath, 'utf8').slice(0, 12000);
  const result = parseDiagnosis(await runHaiku(buildPrompt(name, content, lang)));
  store[realPath] = { ...result, hash, lang, generatedAt: new Date().toISOString() };
  saveDiagnoses(store);
  return result;
}

/* スキャン結果にキャッシュ済み診断を付与(内容が変わっていれば付けない) */
export function attachDiagnoses(sections: Section[], lang: Lang): void {
  const store = loadDiagnoses();
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
        it.aiDiagnosis = {
          verdict: cached.verdict,
          issues: cached.issues,
          improved: cached.improved,
        };
      }
    }
  }
}
