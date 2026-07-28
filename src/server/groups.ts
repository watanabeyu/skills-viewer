/*
 * AI グルーピング: 環境内の全アイテム(name + description)を 1 回の haiku 呼び出しに渡し、
 * 「用途グループの集合 + 各アイテムの割当」をまとめて生成する(docs/plans/08 参照)。
 * グループ名はプロダクトに焼き込まず環境ごとに生成し、職種非依存の工程軸は
 * 粒度ガイドとしてだけプロンプトに渡す。frontmatter に category を持つアイテムは
 * 手動指定として AI 分類の対象外(クライアント側で category がそのままグループになる)。
 * キャッシュは summary.ts と同思想だが、環境単位で言語ごとに 1 エントリ
 * (全対象アイテムの name + description の hash)。アイテムの増減・description 変更で
 * stale になるが、自動再生成はせず UI から手動で再分類する。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { AiModel, Lang, Section, SkillGroup } from '../shared/types';
import { runClaude } from './summary';

const GROUPS_FILE = path.join(os.homedir(), '.cache', 'skills-viewer', 'groups.json');

export interface GroupsResult {
  groups: SkillGroup[];
  assign: Record<string, string>;
}

interface GroupsEntry extends GroupsResult {
  hash: string;
  generatedAt: string;
  /* 生成に使ったモデル(記録のみ。stale 判定には使わない) */
  model?: AiModel;
}

/* 言語ごとに独立キャッシュ(label は表示言語で生成されるため) */
type GroupsStore = Partial<Record<Lang, GroupsEntry>>;

function loadStore(): GroupsStore {
  try {
    return JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveStore(store: GroupsStore): void {
  fs.mkdirSync(path.dirname(GROUPS_FILE), { recursive: true });
  fs.writeFileSync(GROUPS_FILE, JSON.stringify(store, null, 1));
}

export interface GroupTarget {
  name: string;
  description: string;
}

/*
 * 分類対象 = hook 以外の全アイテム(built-in 含む)を name で重複排除したもの。
 * 同名アイテム(user と project の code-review 等)は同じグループに落とす。
 * category 持ちは手動指定なので対象外。description は 200 字で切る(分類には十分)。
 */
export function groupTargets(sections: Section[]): GroupTarget[] {
  const seen = new Map<string, GroupTarget>();
  for (const s of sections) {
    for (const it of s.items) {
      if (it.kind === 'hook' || it.category || seen.has(it.name)) continue;
      seen.set(it.name, { name: it.name, description: it.description.slice(0, 200) });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function groupsHash(targets: GroupTarget[]): string {
  const src = targets.map((t) => t.name + '\t' + t.description).join('\n');
  return crypto.createHash('sha256').update(src).digest('hex').slice(0, 16);
}

/* 職種非依存の工程軸(粒度ガイド)。グループ名の直接指定ではない */
const AXIS_JA =
  '企画・要件 / 制作・実装 / レビュー・検証 / リリース・共有 / 調査・分析 / 記録・運用';
const AXIS_EN =
  'planning & requirements / building & creating / review & verification / release & sharing / research & analysis / records & operations';

function buildPrompt(targets: GroupTarget[], lang: Lang): string {
  const list = targets.map((t) => t.name + ': ' + t.description).join('\n');
  if (lang === 'ja') {
    return (
      '以下は Claude Code にインストールされた skill / command / agent の一覧です(1行 = 「name: description」)。\n' +
      'これらを「いつ・何をするときに使うか」の観点でグループ分けし、次の JSON だけを出力してください(前置き・コードフェンス不要):\n' +
      '{"groups": [{"id": "英小文字とハイフンのスラッグ(言語非依存)", "label": "グループ名(日本語で10字程度)", "emoji": "グループを表す絵文字1つ"}],\n' +
      ' "assign": {"<name>": "<groupId>"}}\n\n' +
      '制約:\n' +
      '- グループ数は 4〜8。粒度の目安は職種を問わない工程軸「' +
      AXIS_JA +
      '」。ただしグループ名はこの一覧の実態に合わせること(例に無い分野があればそのグループを作ってよい)\n' +
      '- assign には一覧の全 name を必ず 1 回ずつ含める。迷う場合も最も近いグループに割り当てる\n' +
      '- assign の値は groups で定義した id のみ使用する\n\n' +
      '# 一覧\n' +
      list
    );
  }
  return (
    'Below is a list of skills / commands / agents installed for Claude Code (one per line, "name: description").\n' +
    'Group them by WHEN and FOR WHAT they are used, and output ONLY this JSON (no preamble, no code fences):\n' +
    '{"groups": [{"id": "lowercase-hyphen slug (language-neutral)", "label": "group name in English (2-4 words)", "emoji": "one emoji for the group"}],\n' +
    ' "assign": {"<name>": "<groupId>"}}\n\n' +
    'Constraints:\n' +
    '- 4 to 8 groups. Use this role-agnostic workflow axis as a granularity guide: ' +
    AXIS_EN +
    '. Name the groups after what is actually in the list (create different groups if the list calls for them).\n' +
    '- assign MUST contain every name from the list exactly once; when unsure, pick the closest group.\n' +
    '- assign values must be ids defined in groups.\n\n' +
    '# List\n' +
    list
  );
}

/* id を言語非依存スラッグに正規化(空になったら null) */
function slugify(v: unknown): string | null {
  const s = String(v ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || null;
}

/*
 * haiku の出力を検証つきでパース。
 * - groups: id をスラッグ正規化・重複排除し、最大 12 件
 * - assign: 一覧に無い name(幻覚)と未定義グループへの割当は捨てる(→「その他」扱い)
 * groups が 1 件も取れない出力はエラー(UI にエラー表示)
 */
export function parseGroups(text: string, names: string[]): GroupsResult {
  const stripped = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const j = JSON.parse(stripped);
  const groups: SkillGroup[] = [];
  const ids = new Set<string>();
  for (const g of Array.isArray(j.groups) ? j.groups : []) {
    const id = slugify(g?.id);
    const label = String(g?.label || '').trim();
    if (!id || !label || ids.has(id)) continue;
    ids.add(id);
    const emoji = String(g?.emoji || '').trim();
    groups.push({ id, label: label.slice(0, 40), ...(emoji ? { emoji: emoji.slice(0, 8) } : {}) });
    if (groups.length >= 12) break;
  }
  if (!groups.length) throw new Error('no groups in output');
  const nameSet = new Set(names);
  const assign: Record<string, string> = {};
  for (const [name, gid] of Object.entries(j.assign || {})) {
    const id = slugify(gid);
    if (nameSet.has(name) && id && ids.has(id)) assign[name] = id;
  }
  return { groups, assign };
}

/*
 * 環境全体を 1 回の claude 呼び出しで分類してキャッシュに保存する。
 * 入力が大きく(全アイテム一覧)haiku でも 2 分近くかかるため、タイムアウトは
 * 単体要約(120s)より長い 10 分にする(sonnet / opus はさらに遅い)
 */
export async function generateGroups(
  sections: Section[],
  lang: Lang,
  model: AiModel = 'haiku',
): Promise<GroupsResult> {
  const targets = groupTargets(sections);
  const result = parseGroups(
    await runClaude(buildPrompt(targets, lang), model, 600000),
    targets.map((t) => t.name),
  );
  const store = loadStore();
  store[lang] = {
    ...result,
    hash: groupsHash(targets),
    model,
    generatedAt: new Date().toISOString(),
  };
  saveStore(store);
  return result;
}

/*
 * スキャン結果にキャッシュ済みの割当を付与する。
 * stale(生成後に構成が変わった)でも古い割当は表示価値があるので付与し、
 * stale フラグで UI に再分類を促す。新規アイテムは割当なし(「その他」に落ちる)。
 */
export function attachGroups(
  sections: Section[],
  lang: Lang,
): { groups?: SkillGroup[]; stale: boolean } {
  const entry = loadStore()[lang];
  if (!entry) return { stale: false };
  for (const s of sections) {
    for (const it of s.items) {
      if (it.kind === 'hook' || it.category) continue;
      const gid = entry.assign[it.name];
      if (gid) it.aiGroup = gid;
    }
  }
  return { groups: entry.groups, stale: entry.hash !== groupsHash(groupTargets(sections)) };
}
