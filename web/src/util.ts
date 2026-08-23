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

/* 一覧の表示軸: ソース別(置き場所)/ 用途別(AI グルーピング)/ メモリ(自動メモリのみ)/ フラット */
export type ViewMode = 'source' | 'group' | 'memory' | 'flat';

/* memory セクションのアクセント色(skill の SRC_COLOR に相当。AI マークと同系色) */
export const MEM_COLOR = '#b0836a';

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
  memory: 'memory',
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
 * 経過日ラベル(memory の「どれだけ更新されていないか」用)。日付そのものより鮮度が重要なので相対表記。
 */
export function relDaysLabel(ms?: number): string {
  if (!ms) return '';
  const days = Math.floor((Date.now() - ms) / 86400000);
  return days <= 0 ? t('memory.today') : t('memory.stale', { n: days });
}

/* M/D 表記(カードの「最終 8/14」用。年は鮮度判断に不要なので省く) */
export const fmtMD = (ms?: number) => {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

/* memory 軸の並び順。既定は索引トークン(常時コスト)が多い順 = 減らす価値が高い順 */
export type MemorySortKey = 'index' | 'body' | 'updated' | 'name';

export function sortMemory<T extends SkillItem>(items: T[], sort: MemorySortKey): T[] {
  const arr = [...items];
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  if (sort === 'index')
    arr.sort((a, b) => (b.indexTokens || 0) - (a.indexTokens || 0) || byName(a, b));
  else if (sort === 'body')
    arr.sort((a, b) => (b.bodyTokens || 0) - (a.bodyTokens || 0) || byName(a, b));
  // 更新が古い順(棚卸し候補が先頭に来る)。更新日不明は末尾。
  // サーバーは stat 失敗時に updatedAt: 0 を載せるので、?? ではなく falsy で不明扱いにする
  else if (sort === 'updated')
    arr.sort((a, b) => (a.updatedAt || Infinity) - (b.updatedAt || Infinity) || byName(a, b));
  else arr.sort(byName);
  return arr;
}

/*
 * 参照フィルタ(本文が Read されたか)。トランスクリプトが無いプロジェクトは「未参照」ではなく
 * 判定不能なので、read / unread のどちらにも含めない(all だけが通す)。
 */
export type RefFilter = 'all' | 'read' | 'unread';

export const refMatches = (it: SkillItem, f: RefFilter, usageAvailable: boolean) => {
  if (f === 'read') return usageAvailable && !!it.useCount;
  if (f === 'unread') return usageAvailable && !it.useCount;
  return true;
};

/* 被リンク: 同プロジェクトの他 memory の [[x]] がこの memory を name かファイル名で指しているもの */
export function backlinksOf<T extends SkillItem>(it: T, items: T[]): T[] {
  const base = fileBase(it.path);
  return items.filter(
    (o) => o.path !== it.path && (o.links || []).some((n) => n === it.name || n === base),
  );
}

/* リンク切れ数: 発リンクのうち同プロジェクト内で解決できないもの(解決規則は memoryResolver と同一) */
export function brokenLinkCount(it: SkillItem, items: SkillItem[]): number {
  const resolve = memoryResolver(items);
  return (it.links || []).filter((n) => !resolve(n)).length;
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
 * keep(変更なし)・shrink(本文を縮める)・update(本文を書き直す)は索引 ±0 なので数値を出さず null。
 */
export function triageEstimate(it: SkillItem): { index: number; always: number } | null {
  const v = it.aiTriage?.verdict;
  const index = it.indexTokens || 0;
  // to-skill は SKILL.md 側(元から常時注入されている description ではなく本文)へ移すので、
  // memory 側は索引が消えるだけ = to-docs と同じ試算になる
  if (v === 'delete' || v === 'to-docs' || v === 'wrong-project' || v === 'to-skill')
    return { index: -index, always: 0 };
  // CLAUDE.md 行きは索引 1 行が消える代わりに本文全体が毎セッション注入になる(多くの場合は増加)
  if (v === 'to-claude-md') return { index: -index, always: it.bodyTokens || 0 };
  return null;
}

/* 提案(指示文)のある memory だけ。サマリ・まとめコピーが同じ母集団を見るよう 1 箇所に置く */
export const instructionsOf = (items: SkillItem[]) =>
  items.filter((it) => it.aiTriage && it.aiTriage.instruction);

/*
 * コピーする指示文には「まず確認してから実行」の前置きを付ける。貼り先の Claude Code に
 * dry run(読み取り → 作業内容の提示 → 承認)を求めるためで、毎回手で書き足さなくて済むようにする。
 */
export const withPreamble = (body: string) => t('memory.triage.copyPreamble') + '\n\n' + body;

/* 提案のある行だけを `## name` 見出し付きで連結(まとめてコピー用)。前置きは先頭に 1 回だけ */
export const joinInstructions = (items: SkillItem[]) =>
  withPreamble(
    instructionsOf(items)
      .map((it) => '## ' + it.name + '\n\n' + it.aiTriage!.instruction)
      .join('\n\n'),
  );

/* memory 一覧(view=memory)へ戻る URL。詳細のタブ状態は持ち越さない(次のカードが本文タブで開くのを防ぐ) */
export function memoryListSearch(params: URLSearchParams): string {
  const next = new URLSearchParams(params);
  next.set('view', 'memory');
  next.delete('tab');
  return next.toString();
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
