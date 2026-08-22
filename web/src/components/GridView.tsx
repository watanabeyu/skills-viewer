import { useState } from 'react';
import type { MemorySection, SkillsData } from '../api';
import { generateGroups, itemKey } from '../api';
import {
  flatten,
  fmtDate,
  groupByPurpose,
  headingOf,
  invocationLabel,
  invocationOf,
  invocationTitle,
  isUnused,
  kindMatches,
  matches,
  relDaysLabel,
  sortItems,
  usageLine,
  usageMatches,
  KIND_LABEL,
  SRC_COLOR,
  type KindFilter,
  type PurposeGroup,
  type SortKey,
  type UseFilter,
  type ViewMode,
} from '../util';
import { lintLabel, memoryTypeLabel, t } from '../i18n';
import type { Section, SkillItem, Source } from '../api';

export function KindBadge({ it }: { it: SkillItem }) {
  const label = KIND_LABEL[it.kind];
  return label ? <span className="kbadge">{label}</span> : null;
}

/* memory の frontmatter type。スコープと誤読されないよう内容分類として意訳したラベルを出す */
export function MemoryTypeBadge({ it }: { it: SkillItem }) {
  if (!it.memoryType) return null;
  return <span className={'mtype mtype-' + it.memoryType}>{memoryTypeLabel(it.memoryType)}</span>;
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
  extra,
}: {
  section: Section;
  count: number;
  small?: boolean;
  /* セクション全体(フィルタ前)の注入トークン概算。省略時は非表示 */
  tokens?: number;
  /* tokens と同じ位置に差し込む追加表示。memory は文言・tooltip が異なるため自前で描く */
  extra?: React.ReactNode;
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
      {extra}
      <span className="ln" />
    </div>
  );
}

export function GroupHeading({
  g,
  count,
  small,
  sub,
}: {
  g: PurposeGroup;
  count: number;
  small?: boolean;
  /* セクション見出しの配下に出す小見出し(sticky 無し・インデント付き) */
  sub?: boolean;
}) {
  return (
    <div className={'sec-h' + (small ? ' sm' : '') + (sub ? ' sub' : '')}>
      <span className="g-emoji">{g.emoji || (g.manual ? '📌' : '📁')}</span>
      <span className="lbl">{g.label}</span>
      {g.manual && (
        <span className="g-manual" title={t('group.manualTitle')}>
          {t('group.manual')}
        </span>
      )}
      <span className="n">{count}</span>
      <span className="ln" />
    </div>
  );
}

/*
 * 用途グループの生成/再生成ボタン。環境全体で 1 回の haiku 呼び出しなので
 * job ポーリングは持たず、完了までボタンを busy 表示にして reload で反映する。
 */
function GroupGenButton({
  label,
  title,
  reload,
}: {
  label: string;
  title: string;
  reload: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await generateGroups();
      await reload();
    } catch (e) {
      alert(t('alert.groupFailed', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="chip" disabled={busy} onClick={run} title={title}>
      {busy ? t('group.generating') : label}
    </button>
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

/* skill / command / agent / hook の一覧本体(表示軸・フィルタの対象) */
function SkillGrid({
  data,
  q,
  sort,
  view,
  kind,
  use,
  onOpen,
  reload,
}: {
  data: SkillsData;
  q: string;
  sort: SortKey;
  view: ViewMode;
  kind: KindFilter;
  use: UseFilter;
  onOpen: (key: string) => void;
  reload: () => Promise<void>;
}) {
  const pass = (it: SkillItem) =>
    kindMatches(it, kind) && matches(it, q) && usageMatches(it, use, data.usageAvailable);
  if (view === 'group') {
    // 未生成なら生成導線だけを出す(claude CLI が無い環境ではボタンがエラーを表示する)
    if (!data.groups?.length) {
      return (
        <div className="grid-pad">
          <div className="grp-panel">
            <p>{t('group.empty')}</p>
            <GroupGenButton
              label={t('group.generate')}
              title={t('group.generateTitle')}
              reload={reload}
            />
          </div>
        </div>
      );
    }
    // リポジトリ(ソースセクション)ごとに、その中を用途グループで小分けする
    const sections = data.sections
      .map((s) => ({
        section: s,
        groups: groupByPurpose(sortItems(flatten([s]).filter(pass), sort), data.groups),
      }))
      .filter((s) => s.groups.length > 0);
    return (
      <div className="grid-pad">
        {data.groupsStale && (
          <div className="grp-bar">
            <span className="stale-note">
              ⚠ {t('group.stale')} — {t('group.staleAction')}
            </span>
          </div>
        )}
        {sections.length ? (
          sections.map(({ section, groups }) => (
            <div key={section.id}>
              <SectionHeading
                section={section}
                count={groups.reduce((n, g) => n + g.items.length, 0)}
              />
              {groups.map((g) => (
                <div key={g.id} className="sub-grp">
                  <GroupHeading g={g} count={g.items.length} small sub />
                  <div className="grid">
                    {g.items.map((it) => (
                      <SkillCard
                        key={it.key}
                        it={it}
                        onOpen={onOpen}
                        usageAvailable={data.usageAvailable}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))
        ) : (
          <div className="empty">{t('list.empty')}</div>
        )}
      </div>
    );
  }
  if (view === 'source') {
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

/*
 * SectionHeading は Section 型(source 必須。headingOf / SRC_COLOR が依存)を前提にしているので、
 * MemorySection を Section 互換オブジェクトに変換して見出しだけ流用する。
 */
function memoryAsSection(sec: MemorySection): Section {
  return {
    id: 'mem-' + sec.id,
    source: 'project',
    projectName: sec.projectName,
    ...(sec.isCurrent ? { isCurrent: true } : {}),
    note: sec.note,
    items: sec.items,
  };
}

/*
 * 索引 tok(常時コスト)と本文 tok(Read されたときの従量コスト)は性質が違うので必ず並べて出す。
 * Read / W-E はトランスクリプトが 1 件も無いプロジェクトでは無意味なので列ごと出さない。
 */
function MemoryRow({
  it,
  usageAvailable,
  onOpen,
}: {
  it: SkillItem;
  usageAvailable: boolean;
  onOpen: (path: string) => void;
}) {
  return (
    <button className="mem-row" onClick={() => onOpen(it.path)}>
      <span className="r1">
        <span className="nm">{it.name}</span>
        <MemoryTypeBadge it={it} />
        <span className="age">{relDaysLabel(it.updatedAt)}</span>
      </span>
      <span className="d-row">
        <span className="d1">{it.description}</span>
        <span className="mem-meta">
          <span title={t('memory.indexTokTitle')}>
            {t('memory.indexTok', { n: (it.indexTokens || 0).toLocaleString() })}
          </span>
          <span title={t('memory.bodyTokTitle')}>
            {t('memory.bodyTok', { n: (it.bodyTokens || 0).toLocaleString() })}
          </span>
          {usageAvailable && (
            <>
              <span title={t('memory.readsTitle')}>
                {t('memory.reads', { n: it.useCount || 0 })}
              </span>
              <span title={t('memory.writesTitle')}>
                {t('memory.writes', { n: it.writeCount || 0 })}
              </span>
            </>
          )}
        </span>
      </span>
    </button>
  );
}

/*
 * 自動メモリの一覧。memory は「呼び出す」ものではないので、表示軸・種類フィルタ・
 * 使用実績フィルタの影響を受けず、常に skill セクション群の下にまとめて出す(検索だけ効く)。
 */
export function MemoryList({
  sections,
  q,
  onOpen,
}: {
  sections: MemorySection[];
  q: string;
  onOpen: (path: string) => void;
}) {
  const shown = sections
    .map((sec) => ({ sec, items: sec.items.filter((it) => matches(it, q)) }))
    .filter((s) => s.items.length > 0);
  if (!shown.length) return null;
  const total = shown.reduce((n, s) => n + s.items.length, 0);
  return (
    <div className="mem-pad">
      <div className="sec-h mem-top" title={t('memory.headingTitle')}>
        <span className="lbl">{t('memory.heading')}</span>
        <span className="n">{total}</span>
        <span className="ln" />
      </div>
      {shown.map(({ sec, items }) => (
        <div key={sec.id}>
          <div className="mem-sec-h">
            <SectionHeading
              section={memoryAsSection(sec)}
              count={items.length}
              small
              /* 索引はフィルタと無関係に全件が毎セッション注入されるので sec.indexTokens をそのまま出す */
              extra={
                !!sec.indexTokens && (
                  <span className="sec-tok" title={t('memory.secTokensTitle')}>
                    {t('memory.secTokens', { n: sec.indexTokens.toLocaleString() })}
                  </span>
                )
              }
            />
            {sec.orphan && (
              <span className="orphan-badge" title={t('memory.orphanTitle')}>
                {t('memory.orphan')}
              </span>
            )}
          </div>
          <div className="mem-list">
            {items.map((it) => (
              <MemoryRow
                key={it.path}
                it={it}
                usageAvailable={sec.usageAvailable}
                onOpen={onOpen}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* 一覧ページ全体。skill セクション群の下に、独立した Memory セクションを並べる */
export function GridView({
  data,
  q,
  sort,
  view,
  kind,
  use,
  onOpen,
  onOpenMemory,
  reload,
}: {
  data: SkillsData;
  q: string;
  sort: SortKey;
  view: ViewMode;
  kind: KindFilter;
  use: UseFilter;
  onOpen: (key: string) => void;
  onOpenMemory: (path: string) => void;
  reload: () => Promise<void>;
}) {
  return (
    <>
      <SkillGrid
        data={data}
        q={q}
        sort={sort}
        view={view}
        kind={kind}
        use={use}
        onOpen={onOpen}
        reload={reload}
      />
      {!!data.memory?.length && <MemoryList sections={data.memory} q={q} onOpen={onOpenMemory} />}
    </>
  );
}
