import type { SkillsData } from '../api';
import { itemKey } from '../api';
import {
  flatten,
  fmtDate,
  headingOf,
  invocationLabel,
  invocationOf,
  invocationTitle,
  kindMatches,
  matches,
  sortItems,
  usageLine,
  KIND_LABEL,
  SRC_COLOR,
  type KindFilter,
  type SortKey,
} from '../util';
import { t } from '../i18n';
import type { Section, SkillItem, Source } from '../api';

export function KindBadge({ it }: { it: SkillItem }) {
  const label = KIND_LABEL[it.kind];
  return label ? <span className="kbadge">{label}</span> : null;
}

export function InvocationBadge({ it }: { it: SkillItem }) {
  const inv = invocationOf(it);
  if (!inv) return null;
  return (
    <span
      className={'inv-badge inv-' + inv.kind + (inv.basis === 'ai' ? ' inv-ai' : '')}
      title={invocationTitle(it)}
    >
      {invocationLabel(inv.kind)}
      {inv.basis === 'ai' ? ' ✦' : ''}
    </span>
  );
}

export function SectionHeading({
  section,
  count,
  small,
}: {
  section: Section;
  count: number;
  small?: boolean;
}) {
  return (
    <div className={'sec-h' + (small ? ' sm' : '')}>
      <span className="sq" style={{ background: SRC_COLOR[section.source] }} />
      <span className="lbl">{headingOf(section)}</span>
      <span className="n">{count}</span>
      <span className="ln" />
    </div>
  );
}

function SkillCard({
  it,
  onOpen,
  scope,
}: {
  it: SkillItem;
  onOpen: (key: string) => void;
  scope?: { label: string; source: Source };
}) {
  return (
    <button className="card" onClick={() => onOpen(itemKey(it))}>
      {scope && (
        <span className="scope-mini">
          <span className="dot5" style={{ background: SRC_COLOR[scope.source] }} />
          {scope.label}
        </span>
      )}
      <div className="top">
        <span className="nm">{it.name}</span>
        <KindBadge it={it} />
        <InvocationBadge it={it} />
        {it.version && <span className="ver">v{it.version}</span>}
      </div>
      <p className="desc">
        {it.aiSummary && <span className="ai-mark">✦ </span>}
        {it.aiSummary || it.description}
      </p>
      {usageLine(it) && <div className="usage">{usageLine(it)}</div>}
      <div className="meta">
        <span>
          {it.useCount
            ? t('card.uses', { n: it.useCount, date: fmtDate(it.lastUsed) })
            : t('card.noUses')}
        </span>
        <span className="meta-r">
          {it.updatedAt ? <span>{t('card.updated', { date: fmtDate(it.updatedAt) })}</span> : null}
        </span>
      </div>
    </button>
  );
}

export function GridView({
  data,
  q,
  sort,
  grouped,
  kind,
  onOpen,
}: {
  data: SkillsData;
  q: string;
  sort: SortKey;
  grouped: boolean;
  kind: KindFilter;
  onOpen: (key: string) => void;
}) {
  const pass = (it: SkillItem) => kindMatches(it, kind) && matches(it, q);
  if (grouped) {
    const sections = data.sections
      .map((s) => ({ section: s, items: sortItems(s.items.filter(pass), sort) }))
      .filter((s) => s.items.length > 0);
    if (!sections.length)
      return (
        <div className="grid-pad">
          <div className="empty">{t('list.empty')}</div>
        </div>
      );
    return (
      <div className="grid-pad">
        {sections.map(({ section, items }) => (
          <div key={section.id}>
            <SectionHeading section={section} count={items.length} />
            <div className="grid">
              {items.map((it) => (
                <SkillCard key={itemKey(it)} it={it} onOpen={onOpen} />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }
  // グループ化オフのときは所属が見えないので、カード内に所属ラベルを出す
  const items = sortItems(flatten(data.sections).filter(pass), sort);
  return (
    <div className="grid-pad">
      <div style={{ height: 18 }} />
      {items.length ? (
        <div className="grid">
          {items.map((it) => (
            <SkillCard
              key={it.key}
              it={it}
              onOpen={onOpen}
              scope={{ label: it.scopeLabel, source: it.source }}
            />
          ))}
        </div>
      ) : (
        <div className="empty">{t('list.empty')}</div>
      )}
    </div>
  );
}
