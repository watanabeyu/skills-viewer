/*
 * memory 一覧・詳細(計画 15 Phase F / README 6.2)の純粋ロジック。描画は components/{MemoryGrid,MemoryDetail,MemoryBits}.tsx。
 * 「この記憶は残すべきか」に 1 行で答えるための値(鮮度・4 語の診断・索引との一致・コストの合計)を
 * ここで決め、テスト(tests/memory-view.test.ts)で固定する。AI 無しでも成立する値(鮮度の機械判定・シグナル)と
 * AI 由来の値(行き先・理由)を分け、AI は「追加」であって見た目の骨格を変えない(design-system 0.2)。
 */

import type {
  MemorySection,
  MemorySignal,
  MemorySignalKind,
  MemoryState,
  MemoryTriage,
  MemoryType,
  SkillItem,
  SkillsData,
} from './api';
import { matches, refMatches, sortMemory, type MemorySortKey, type RefFilter } from './util';

/* ---- 診断列の 4 語(design-system 0.4b)。移動先は詳細の「行き先」で示し、一覧には出さない ---- */

export type VerdictWord = 'keep' | 'shrink' | 'move' | 'delete' | 'error';
export type Tone = 'sub' | 'text' | 'danger' | 'warn' | 'good';

/*
 * verdict → 4 語。shrink と update はどちらも「本文を書き換える(索引 ±0)」なので「縮める」に寄せ、
 * 書き直しか短縮かは詳細の行き先(memoryVerdictLabel)で言い分ける。to-* / wrong-project は移動先を問わず「移動」。
 * 出力不正は行き先が無いので 5 つ目の状態(再診断を促す)として返す。未診断は null(一覧は「—」)。
 */
export function verdictWord(tri?: MemoryTriage): VerdictWord | null {
  if (!tri) return null;
  if (tri.error) return 'error';
  switch (tri.verdict) {
    case 'keep':
      return 'keep';
    case 'shrink':
    case 'update':
      return 'shrink';
    case 'delete':
      return 'delete';
    default:
      return 'move';
  }
}

/* 太さは揃え、色だけで分ける(残す = 副文色、縮める・移動 = 本文色、削除 = 危険色、出力不正 = 警告色) */
export const VERDICT_TONE: Record<VerdictWord, Tone> = {
  keep: 'sub',
  shrink: 'text',
  move: 'text',
  delete: 'danger',
  error: 'warn',
};

/* ---- 鮮度(state)。棚卸し済みなら AI の判定、未実行なら機械シグナルだけから決める ---- */

/*
 * 機械層で「古さ」を示すシグナル。date(日付があるだけ)や feedback の構造シグナルは古さの根拠にならないので含めない。
 * MemorySignalKind に増えた kind をここへ足し忘れても typecheck では落ちないので、コメントで運用を明記する。
 */
export const STALE_SIGNALS: readonly MemorySignalKind[] = [
  'path-missing',
  'done-words',
  'branch-merged',
  'branch-missing',
];

/* スキャン時(SkillItem.signals)と診断時(MemoryTriage.signals)のシグナルを 1 列に */
export const allSignals = (it: SkillItem): MemorySignal[] => [
  ...(it.signals || []),
  ...(it.aiTriage?.signals || []),
];

export interface Freshness {
  state: MemoryState;
  /* ai = 棚卸しの判定(根拠つき)、machine = 古さのシグナルの有無だけ(current は「古い根拠が無い」の意味) */
  basis: 'ai' | 'machine';
}

export function freshnessOf(it: SkillItem): Freshness {
  const state = it.aiTriage?.state;
  if (state && !it.aiTriage?.error) return { state, basis: 'ai' };
  const stale = allSignals(it).some((s) => STALE_SIGNALS.includes(s.kind));
  return { state: stale ? 'outdated' : 'current', basis: 'machine' };
}

export const STATE_TONE: Record<MemoryState, Tone> = {
  current: 'good',
  outdated: 'warn',
  historical: 'sub',
  obsolete: 'danger',
};

/* ---- 索引行と本文の一致(詳細の「索引行」の右端) ---- */

export type IndexMatch = 'match' | 'mismatch' | 'unknown' | 'none' | 'beyond';

export function indexMatchOf(it: SkillItem): IndexMatch {
  if (!it.indexLine) return 'none';
  if (it.indexBeyondLimit) return 'beyond';
  const m = it.aiTriage?.indexMatchesBody;
  if (it.aiTriage?.error || m === undefined) return 'unknown';
  return m ? 'match' : 'mismatch';
}

/* ---- 一覧の絞り込み(検索 / 参照 / 種類)と並び。旧クエリ msort / ref はそのまま残す ---- */

export type TypeFilter = 'all' | MemoryType;
export const TYPE_FILTERS: readonly TypeFilter[] = [
  'all',
  'user',
  'feedback',
  'project',
  'reference',
];

export const asTypeFilter = (v: string | null): TypeFilter =>
  TYPE_FILTERS.includes(v as TypeFilter) ? (v as TypeFilter) : 'all';

export const typeMatches = (it: SkillItem, f: TypeFilter) => f === 'all' || it.memoryType === f;

export interface ListFilter {
  q: string;
  sort: MemorySortKey;
  ref: RefFilter;
  type: TypeFilter;
}

export function memoryRows(sec: MemorySection, f: ListFilter): SkillItem[] {
  return sortMemory(
    sec.items.filter(
      (it) =>
        matches(it, f.q) && refMatches(it, f.ref, sec.usageAvailable) && typeMatches(it, f.type),
    ),
    f.sort,
  );
}

/*
 * 一覧に出すセクション。プロジェクト単位(README 6.2)なので、ヘッダーの切替(?project=)に従う:
 *   all = true   全セクション(プロジェクト不明・共有ストアもここでだけ見える)
 *   all = false  サーバーが「選んだプロジェクトのもの」と印を付けたセクション(isCurrent)
 *
 * 引数を boolean にしてあるのは、ここで使うのが「すべてのプロジェクトかどうか」だけだから
 * (どのプロジェクトかは web が決め直さない。計画 16 判断 3)。
 * 述語は ②(サーバーの session context)と同じ isCurrent 1 本にする(計画 16 レビュー 2 周目)。
 * サーバーは選んだプロジェクトを起点に置き場を走査する(memorySections(selectedPath))ので、
 * isCurrent は「cwd」ではなく「選んだプロジェクト(+ その本体)」の印であり、
 * user scope の autoMemoryDirectory(projectPath なし)にも付く。
 * ここで selected.path / mainPath から組み直すと、逆引きに失敗した worktree などで
 * ② には出るのに一覧だけが空になる ── 判定の出所を 1 つに保つ。
 */
export function sectionsFor(data: SkillsData, all: boolean): MemorySection[] {
  const memory = data.memory || [];
  return all ? memory : memory.filter((m) => m.isCurrent);
}

/* ---- 上部のコスト(索引 = 毎回、本文 = 読まれたときだけ) ---- */

export interface CostSummary {
  /* 上限内の索引行の合計(毎セッション注入される分) */
  indexTok: number;
  /* 索引に載っている行数(上限外を含む。サーバーの context.memoryIndex.lines と同じ数え方 = 件数) */
  lines: number;
  /* 読み込み上限の外にある索引行の件数 */
  beyond: number;
  bodyTok: number;
}

export function costOf(sec: MemorySection): CostSummary {
  return {
    indexTok: sec.indexTokens,
    lines: sec.items.length,
    beyond: sec.indexBeyondCount || 0,
    bodyTok: sec.items.reduce((n, it) => n + (it.bodyTokens || 0), 0),
  };
}

/* 索引の行数 / 上限(0..1、超過は 1 超)。上限 0 は無効値なので 0 */
export const indexRatio = (lines: number, limitLines: number) =>
  limitLines > 0 ? lines / limitLines : 0;

/* 診断見出しの「いつ・どのモデルが」。無ければ空(旧形式のキャッシュ) */
export function triageMeta(tri: MemoryTriage | undefined, fmt: (ms: number) => string): string {
  if (!tri) return '';
  const when = tri.generatedAt ? Date.parse(tri.generatedAt) : NaN;
  return [Number.isFinite(when) ? fmt(when) : '', tri.model || ''].filter(Boolean).join(' · ');
}
