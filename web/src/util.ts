import type { Section, SkillItem, Source } from './api';
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

/* 呼び出し例。agent は @メンション、hook は起動形が無いので空 */
export const usageLine = (it: SkillItem) => {
  if (it.kind === 'hook') return '';
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
