import type { Section, SkillItem, Source } from './api';
import { itemKey } from './api';

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

export type SortKey = 'name' | 'uses' | 'recent' | 'updated';

export interface FlatItem extends SkillItem {
  key: string;
  secId: string;
  source: Source;
  scopeLabel: string;
  manage: boolean;
  hasMd: boolean;
}

/* セクション見出しから短い所属ラベルを作る(project — monorepo (current) → monorepo) */
export function scopeLabelOf(s: Section): string {
  return s.source === 'project'
    ? s.heading.replace(/^project — /, '').replace(/ \(current\)$/, '')
    : s.source;
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

export const INVOCATION_LABEL: Record<Invocation, string> = {
  human: '人間起点',
  agent: 'エージェント',
  both: '両方',
};

export function invocationTitle(it: SkillItem): string {
  const parts: string[] = [];
  if ((it.typedCount || 0) + (it.autoCount || 0) > 0) {
    parts.push(`実測: 手動 ${it.typedCount || 0}回 / 自動 ${it.autoCount || 0}回`);
  }
  if (it.aiInvocation) {
    parts.push(
      `AI判定: ${INVOCATION_LABEL[it.aiInvocation]}${it.aiInvocationReason ? `(${it.aiInvocationReason})` : ''}`,
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
  else arr.sort(byName);
  return arr;
}
