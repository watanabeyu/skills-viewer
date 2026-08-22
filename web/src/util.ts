import type { Section, SkillGroup, SkillItem, Source } from './api';
import { itemKey } from './api';
import { t } from './i18n';

export const SRC_COLOR: Record<Source, string> = {
  'built-in': '#2a6fdb',
  user: '#1f8a5b',
  project: '#c07a1f',
  plugin: '#7b5bd6',
};
export const SRC_TINT: Record<Source, string> = {
  'built-in': 'rgba(42,111,219,.10)',
  user: 'rgba(31,138,91,.10)',
  project: 'rgba(192,122,31,.13)',
  plugin: 'rgba(123,91,214,.10)',
};

export type SortKey = 'name' | 'uses' | 'recent' | 'updated' | 'tokens';

/* 一覧の表示軸: ソース別(置き場所)/ 用途別(AI グルーピング)/ フラット */
export type ViewMode = 'source' | 'group' | 'flat';

export interface FlatItem extends SkillItem {
  key: string;
  secId: string;
  source: Source;
  scopeLabel: string;
  manage: boolean;
  hasMd: boolean;
}

/* セクション見出し(サーバーは構造化データのみ返し、表示文字列はここで組み立てる) */
export function headingOf(s: Section): string {
  return s.source === 'project'
    ? 'project — ' + (s.projectName || '') + (s.isCurrent ? ' (current)' : '')
    : s.source;
}

/* 短い所属ラベル(project は プロジェクト名のみ) */
export function scopeLabelOf(s: Section): string {
  return s.source === 'project' ? s.projectName || '' : s.source;
}

export function flatten(sections: Section[]): FlatItem[] {
  return sections.flatMap((s) =>
    s.items.map((it) => ({
      ...it,
      key: itemKey(it),
      secId: s.id,
      source: s.source,
      scopeLabel: scopeLabelOf(s),
      manage: !!s.manage && it.kind !== 'hook', // hook は設定エントリなのでコピー/削除不可
      hasMd: it.path.endsWith('.md'),
    })),
  );
}

/* 呼び出し例。agent は @メンション、hook / memory は起動形が無いので空 */
export const usageLine = (it: SkillItem) => {
  if (it.kind === 'hook' || it.kind === 'memory') return '';
  if (it.kind === 'agent') return '@' + it.name;
  return '/' + it.name + (it.argumentHint ? ' ' + it.argumentHint : '');
};

export const KIND_LABEL: Partial<Record<SkillItem['kind'], string>> = {
  command: 'command',
  agent: 'agent',
  hook: 'hook',
};

export type KindFilter = 'all' | SkillItem['kind'];

export const kindMatches = (it: SkillItem, kind: KindFilter) => kind === 'all' || it.kind === kind;

/*
 * 未使用判定。トランスクリプトが1件も無い環境では全件未使用になり無意味なので
 * usageAvailable が前提。hook は起動記録の対象外なので常に false。
 */
export const isUnused = (it: SkillItem, usageAvailable: boolean) =>
  usageAvailable && it.kind !== 'hook' && !it.useCount;

/* 使用実績フィルタ。used / unused とも起動記録の対象外である hook は含めない */
export type UseFilter = 'all' | 'used' | 'unused';

export const usageMatches = (it: SkillItem, f: UseFilter, usageAvailable: boolean) => {
  if (f === 'used') return it.kind !== 'hook' && !!it.useCount;
  if (f === 'unused') return isUnused(it, usageAvailable);
  return true;
};

/* 用途別表示の1グループ(手動 category 由来 or AI 生成 or その他) */
export interface PurposeGroup {
  id: string;
  label: string;
  emoji?: string;
  manual?: boolean;
  items: FlatItem[];
}

/*
 * 用途グループ別に集約する。表示順は 手動 category(名前順)→ AI グループ(サーバー順)→ その他。
 * 割当が無い/未知グループを指す/hook のアイテムは「その他」に落とす(隠さない)。
 * items の並び順は保持する(呼び出し側で sortItems 済みの前提)。
 */
export function groupByPurpose(
  items: FlatItem[],
  groups: SkillGroup[] | undefined,
): PurposeGroup[] {
  const manual = new Map<string, FlatItem[]>();
  const ai = new Map<string, FlatItem[]>();
  const other: FlatItem[] = [];
  const known = new Set((groups || []).map((g) => g.id));
  for (const it of items) {
    if (it.category) {
      if (!manual.has(it.category)) manual.set(it.category, []);
      manual.get(it.category)!.push(it);
    } else if (it.aiGroup && known.has(it.aiGroup)) {
      if (!ai.has(it.aiGroup)) ai.set(it.aiGroup, []);
      ai.get(it.aiGroup)!.push(it);
    } else {
      other.push(it);
    }
  }
  const out: PurposeGroup[] = [...manual.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((cat) => ({ id: 'cat:' + cat, label: cat, manual: true, items: manual.get(cat)! }));
  for (const g of groups || []) {
    if (ai.has(g.id)) out.push({ ...g, items: ai.get(g.id)! });
  }
  if (other.length) out.push({ id: '__other', label: t('group.other'), items: other });
  return out;
}

/* 同名の別定義(diff 比較の対象)。short name で突き合わせ、hook は対象外 */
export function sameNameOthers<T extends SkillItem & { key: string }>(it: T, all: T[]): T[] {
  const short = it.name.split(':').pop();
  return all.filter(
    (x) =>
      x.key !== it.key &&
      x.kind !== 'hook' &&
      it.kind !== 'hook' &&
      x.name.split(':').pop() === short,
  );
}

export const fmtDate = (ms?: number) => {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/*
 * 経過日ラベル(memory の「いつ書かれたか」用)。日付そのものより鮮度が重要なので相対表記。
 */
export function relDaysLabel(ms?: number): string {
  if (!ms) return '';
  const days = Math.floor((Date.now() - ms) / 86400000);
  return days <= 0 ? t('memory.today') : t('memory.daysAgo', { n: days });
}

/* memory の実パスからファイル名を取る(API の files 指定・[[link]] 解決で使う) */
export const fileName = (p: string) => p.split(/[\\/]/).pop() || '';
/* 拡張子なしのファイル名。[[x]] は frontmatter name とファイル名の両方で書かれ得る */
export const fileBase = (p: string) => fileName(p).replace(/\.md$/, '');

/*
 * [[x]] の解決器。本文レンダリング・リンク切れ数えの両方が同じ規則で解決するよう 1 箇所に置く
 * (name 一致とファイル名一致のどちらでも解決する)。
 */
export const memoryResolver =
  (items: SkillItem[]) =>
  (name: string): SkillItem | undefined =>
    items.find((m) => m.name === name || fileBase(m.path) === name);

/*
 * 棚卸し診断の削減試算(機械層で算出。AI には数値を出させない)。
 * index = 常時コスト(MEMORY.md の索引行)の増減、always = 毎セッション注入に変わる分。
 * keep(変更なし)と shrink(本文を縮めるだけで索引は ±0)は数値を出さないので null。
 */
export function triageEstimate(it: SkillItem): { index: number; always: number } | null {
  const v = it.aiTriage?.verdict;
  const index = it.indexTokens || 0;
  if (v === 'delete' || v === 'to-docs' || v === 'wrong-project')
    return { index: -index, always: 0 };
  // CLAUDE.md 行きは索引 1 行が消える代わりに本文全体が毎セッション注入になる(多くの場合は増加)
  if (v === 'to-claude-md') return { index: -index, always: it.bodyTokens || 0 };
  return null;
}

/* クリップボードコピー(指示文の貼り付け用。失敗はボタン側で握り潰さず呼び出し元へ) */
export const copyText = (text: string): Promise<void> => navigator.clipboard.writeText(text);

export const matches = (it: SkillItem, q: string) =>
  !q ||
  (it.name + ' ' + it.description + ' ' + usageLine(it) + ' ' + (it.aiSummary || ''))
    .toLowerCase()
    .includes(q);

/*
 * 起動経路の判定。実測(トランスクリプト)を最優先し、実測が無いものは AI 分類にフォールバック。
 * human = 人間が意図して /x と打つ起点、agent = 他 skill・エージェントから呼ばれる部品。
 */
export type Invocation = 'human' | 'agent' | 'both';

export function invocationOf(it: SkillItem): { kind: Invocation; basis: 'measured' | 'ai' } | null {
  const typed = it.typedCount || 0;
  const auto = it.autoCount || 0;
  if (typed > 0 && auto > 0) return { kind: 'both', basis: 'measured' };
  if (typed > 0) return { kind: 'human', basis: 'measured' };
  if (auto > 0) return { kind: 'agent', basis: 'measured' };
  if (it.aiInvocation) return { kind: it.aiInvocation, basis: 'ai' };
  return null;
}

/* 言語切替に追従するよう、定数マップでなく都度 t() を引く */
export const invocationLabel = (kind: Invocation): string => t(`invocation.${kind}`);

export function invocationTitle(it: SkillItem): string {
  const parts: string[] = [];
  if ((it.typedCount || 0) + (it.autoCount || 0) > 0) {
    parts.push(t('invocation.measured', { typed: it.typedCount || 0, auto: it.autoCount || 0 }));
  }
  if (it.aiInvocation) {
    parts.push(
      t('invocation.ai', { label: invocationLabel(it.aiInvocation) }) +
        (it.aiInvocationReason ? `(${it.aiInvocationReason})` : ''),
    );
  }
  return parts.join(' · ');
}

export function sortItems<T extends SkillItem>(items: T[], sort: SortKey): T[] {
  const arr = [...items];
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  if (sort === 'uses') arr.sort((a, b) => (b.useCount || 0) - (a.useCount || 0) || byName(a, b));
  else if (sort === 'recent')
    arr.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0) || byName(a, b));
  else if (sort === 'updated')
    arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || byName(a, b));
  else if (sort === 'tokens') arr.sort((a, b) => (b.tokens || 0) - (a.tokens || 0) || byName(a, b));
  else arr.sort(byName);
  return arr;
}
