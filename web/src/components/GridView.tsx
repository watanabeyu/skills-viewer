import type { SkillsData } from '../api';
import { itemKey } from '../api';
import {
  flatten,
  fmtDate,
  headingOf,
  invocationLabel,
  invocationOf,
  invocationTitle,
  isUnused,
  kindMatches,
  matches,
  sortItems,
  usageLine,
  KIND_LABEL,
  SRC_COLOR,
  type KindFilter,
  type SortKey,
} from '../util';
import { lintLabel, t } from '../i18n';
import type { Section, SkillItem, Source } from '../api';

export function KindBadge({ it }: { it: SkillItem }) {
  const label = KIND_LABEL[it.kind];
  return label ? <span className="kbadge">{label}</span> : null;
}

export function UnusedBadge({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span className="unused-badge" title={t('badge.unusedTitle')}>
      {t('badge.unused')}
    </span>
  );
}

/* hover で警告内容を CSS tooltip 表示(native title より視認性が高い) */
export function WarnBadge({ it }: { it: SkillItem }) {
  if (!it.lint?.length) return null;
  return (
    <span className="warn-badge">
      ⚠ {it.lint.length}
      <span className="tip">
        <span className="tip-t">{t('badge.warnTitle')}</span>
        {it.lint.map((code) => (
          <span key={code} className="tip-line">
            {lintLabel(code)}
          </span>
        ))}
      </span>
    </span>
  );
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
  tokens,
}: {
  section: Section;
  count: number;
  small?: boolean;
  /* セクション全体(フィルタ前)の注入トークン概算。省略時は非表示 */
  tokens?: number;
}) {
  return (
    <div className={'sec-h' + (small ? ' sm' : '')}>
      <span className="sq" style={{ background: SRC_COLOR[section.source] }} />
      <span className="lbl">{headingOf(section)}</span>
      <span className="n">{count}</span>
      {!!tokens && (
        <span className="sec-tok" title={t('app.tokensTitle')}>
          {t('sec.tokens', { n: tokens.toLocaleString() })}
        </span>
      )}
      <span className="ln" />
    </div>
  );
}

function SkillCard({
  it,
  onOpen,
  scope,
  usageAvailable,
}: {
  it: SkillItem;
  onOpen: (key: string) => void;
  scope?: { label: string; source: Source };
  usageAvailable: boolean;
}) {
  return (
    <button className="card" onClick={() => onOpen(itemKey(it))}>
      {scope && (
        <span className="scope-mini">
          <span className="dot5" style={{ background: SRC_COLOR[scope.source] }} />
          {scope.label}
        </span>
      )}
      {/* 1行目は名前 + 右上の注意点(⚠)のみ。チップ類は名前が長いと読みづらいので2行目へ */}
      <div className="top">
        <span className="nm">{it.name}</span>
        <span className="top-r">
          {it.version && <span className="ver">v{it.version}</span>}
          <WarnBadge it={it} />
        </span>
      </div>
      {(KIND_LABEL[it.kind] || invocationOf(it) || isUnused(it, usageAvailable)) && (
        <div className="chips">
          <KindBadge it={it} />
          <InvocationBadge it={it} />
          <UnusedBadge show={isUnused(it, usageAvailable)} />
        </div>
      )}
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
          {!!it.tokens && (
            <span className="tok">{t('card.tokens', { n: it.tokens.toLocaleString() })}</span>
          )}
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
  unused,
  onOpen,
}: {
  data: SkillsData;
  q: string;
  sort: SortKey;
  grouped: boolean;
  kind: KindFilter;
  unused: boolean;
  onOpen: (key: string) => void;
}) {
  const pass = (it: SkillItem) =>
    kindMatches(it, kind) && matches(it, q) && (!unused || isUnused(it, data.usageAvailable));
  if (grouped) {
    const sections = data.sections
      .map((s) => ({
        section: s,
        items: sortItems(s.items.filter(pass), sort),
        // セクションの注入コストはフィルタと無関係なので全 items で計算する
        tokens: s.items.reduce((sum, it) => sum + (it.tokens || 0), 0),
      }))
      .filter((s) => s.items.length > 0);
    if (!sections.length)
      return (
        <div className="grid-pad">
          <div className="empty">{t('list.empty')}</div>
        </div>
      );
    return (
      <div className="grid-pad">
        {sections.map(({ section, items, tokens }) => (
          <div key={section.id}>
            <SectionHeading section={section} count={items.length} tokens={tokens} />
            <div className="grid">
              {items.map((it) => (
                <SkillCard
                  key={itemKey(it)}
                  it={it}
                  onOpen={onOpen}
                  usageAvailable={data.usageAvailable}
                />
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
              usageAvailable={data.usageAvailable}
            />
          ))}
        </div>
      ) : (
        <div className="empty">{t('list.empty')}</div>
      )}
    </div>
  );
}
