/*
 * 「すべてのプロジェクト」(README 6.2 の全プロジェクトビュー)。ホームと同じ骨格で、
 * ② が無く、③ が「置かれているもの」(全プロジェクトの在庫。出所別 / 用途別 / 1 列)になる。
 * v0.8 までの「ソース別 / 用途別 / フラット」の表示軸はここの並びに格下げした(README 6.4)。
 * 寸法は docs/design/0.9.0/{Ledger,Console}All.dc.html の実測(style.css のトークン)。
 */

import { useState } from 'react';
import type { Section, SkillsData, Source } from '../api';
import { generateGroups } from '../api';
import {
  KIND_FILTERS,
  changeMarkOf,
  duplicateNames,
  flatten,
  groupByPurpose,
  kindMatches,
  matches,
  scopeLabelOf,
  sectionTokens,
  sortItems,
  usageMatches,
  VIEW_MODES,
  type FlatItem,
  type KindFilter,
  type SortKey,
  type UseFilter,
  type ViewMode,
} from '../util';
import { t, type MsgKey } from '../i18n';
import { InlineError, InlineNote } from './Inline';
import { ChangesBlock } from './ChangesBlock';
import { GroupHeading, ItemRow, GroupHead, TableHead, useNarrow } from './Rows';

const SORT_KEYS: [SortKey, MsgKey][] = [
  ['name', 'sort.name'],
  ['uses', 'sort.uses'],
  ['recent', 'sort.recent'],
  ['updated', 'sort.updated'],
  ['tokens', 'sort.tokens'],
];
const VIEW_LABEL: Record<ViewMode, MsgKey> = {
  source: 'view.source',
  group: 'view.group',
  flat: 'view.flat',
};
/* 出所ごとに最初に見せる行数。残りは「他 n 件を表示」で開く(モックの見た目) */
const SHOW_MAX = 5;

/*
 * 用途グループの生成/再生成ボタン。環境全体で 1 回の haiku 呼び出しなので
 * job ポーリングは持たず、完了までボタンを busy 表示にして reload で反映する。
 * v0.8 のヘッダー「✦ AI」メニューにあった再分類はここ(用途別の並びの中)に寄せた(計画 15 Phase F)。
 * claude CLI 不在時はボタンを無効にし、理由を脇に出す。
 */
function GroupGenButton({
  label,
  title,
  aiAvailable,
  reload,
}: {
  label: string;
  title: string;
  aiAvailable: boolean;
  reload: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    setBusy(true);
    setError('');
    try {
      await generateGroups();
      await reload();
    } catch (e) {
      setError(t('alert.groupFailed', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button className="btn" disabled={busy || !aiAvailable} onClick={run} title={title}>
        {busy ? t('group.generating') : label}
      </button>
      <InlineError msg={error} />
      {!aiAvailable && <InlineNote msg={t('ai.unavailable')} />}
    </>
  );
}

/* 出所 1 つ分(見出し + 先頭 SHOW_MAX 行 + 「他 n 件」)。見出しを畳めば行は出ない */
function SourceGroup({
  s,
  items,
  open,
  onToggle,
  usage,
  changes,
  onOpen,
}: {
  s: Section;
  items: FlatItem[];
  open: boolean;
  onToggle: () => void;
  usage: boolean;
  changes: SkillsData['changes'];
  onOpen: (key: string) => void;
}) {
  const [more, setMore] = useState(false);
  const shown = more ? items : items.slice(0, SHOW_MAX);
  const n = t('act.count', { n: s.items.length });
  const meta =
    s.source === 'project'
      ? (s.isCurrent ? t('all.here') + ' · ' : '') + n
      : s.source === 'user'
        ? `~/.claude · ${n}`
        : n;
  return (
    <div className="grp">
      <GroupHead
        open={open}
        onToggle={onToggle}
        source={s.source}
        name={s.source === 'project' ? s.projectName || '' : s.source}
        meta={meta}
        tok={sectionTokens(s)}
      />
      {open &&
        (items.length ? (
          <>
            <TableHead usage={usage} />
            {shown.map((it) => (
              <ItemRow
                key={it.key}
                it={it}
                source={s.source as Source}
                scopeLabel={scopeLabelOf(s)}
                mark={changeMarkOf(it, changes)}
                usage={usage}
                onOpen={onOpen}
              />
            ))}
            {items.length > shown.length && (
              <button className="more meta" onClick={() => setMore(true)}>
                {t('all.more', { n: items.length - shown.length })}
              </button>
            )}
          </>
        ) : (
          <div className="trow-empty meta">{t('act.empty')}</div>
        ))}
    </div>
  );
}

export function GridView({
  data,
  q,
  sort,
  by,
  kind,
  use,
  onOpen,
  onOpenMemory,
  onOpenClaudeMd,
  setParam,
  reload,
}: {
  data: SkillsData;
  q: string;
  sort: SortKey;
  by: ViewMode;
  kind: KindFilter;
  use: UseFilter;
  onOpen: (key: string) => void;
  onOpenMemory: (path: string) => void;
  onOpenClaudeMd: (path?: string) => void;
  setParam: (key: string, value: string | null) => void;
  reload: () => Promise<void>;
}) {
  const narrow = useNarrow();
  const usage = data.usageAvailable;
  const pass = (it: FlatItem) =>
    kindMatches(it, kind) && matches(it, q) && usageMatches(it, use, usage);
  const all = flatten(data.sections);
  const filtered = sortItems(all.filter(pass), sort);
  const countOf = (src: Source) =>
    data.sections.filter((s) => s.source === src).reduce((n, s) => n + s.items.length, 0);
  const projects = data.sections.filter((s) => s.source === 'project');
  const dups = duplicateNames(all);
  // プロジェクトと user は開き、plugin / built-in は畳む(モックの初期状態)
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const isOpen = (s: Section) => open[s.id] ?? (s.source === 'project' || s.source === 'user');

  let body;
  if (by === 'group') {
    if (!data.groups?.length) {
      body = (
        <div className="grp-panel">
          <p>{t('group.empty')}</p>
          <GroupGenButton
            label={t('group.generate')}
            title={t('group.generateTitle')}
            aiAvailable={data.aiAvailable}
            reload={reload}
          />
        </div>
      );
    } else {
      const groups = groupByPurpose(filtered, data.groups);
      body = (
        <>
          {/* 再分類は用途別の並びの中に置く(ヘッダーの AI メニューは廃止)。構成が変わっていれば注記を添える */}
          <div className="grp-bar">
            {data.groupsStale && <span className="stale-note">⚠ {t('group.stale')}</span>}
            <span className="hd-r">
              <GroupGenButton
                label={t('group.regen')}
                title={t('group.generateTitle')}
                aiAvailable={data.aiAvailable}
                reload={reload}
              />
            </span>
          </div>
          {groups.length ? (
            groups.map((g) => (
              <div key={g.id} className="grp">
                <GroupHeading g={g} count={g.items.length} small />
                <TableHead usage={usage} />
                {g.items.map((it) => (
                  <ItemRow
                    key={it.key}
                    it={it}
                    source={it.source}
                    scopeLabel={it.scopeLabel}
                    mark={changeMarkOf(it, data.changes)}
                    usage={usage}
                    onOpen={onOpen}
                  />
                ))}
              </div>
            ))
          ) : (
            <div className="trow-empty meta">{t('act.empty')}</div>
          )}
        </>
      );
    }
  } else if (by === 'flat') {
    body = filtered.length ? (
      <>
        <TableHead usage={usage} />
        {filtered.map((it) => (
          <ItemRow
            key={it.key}
            it={it}
            source={it.source}
            scopeLabel={it.scopeLabel}
            mark={changeMarkOf(it, data.changes)}
            usage={usage}
            onOpen={onOpen}
          />
        ))}
      </>
    ) : (
      <div className="trow-empty meta">{t('act.empty')}</div>
    );
  } else {
    body = data.sections.map((s) => (
      <SourceGroup
        key={s.id}
        s={s}
        items={sortItems(flatten([s]).filter(pass), sort)}
        open={isOpen(s)}
        onToggle={() => setOpen((o) => ({ ...o, [s.id]: !isOpen(s) }))}
        usage={usage}
        changes={data.changes}
        onOpen={onOpen}
      />
    ));
  }

  return (
    <div className="home">
      <ChangesBlock
        data={data}
        project="all"
        onOpen={onOpen}
        onOpenMemory={onOpenMemory}
        onOpenClaudeMd={onOpenClaudeMd}
        reload={reload}
      />
      <section className="blk">
        <div className="blk-hd">
          <h2>{t('all.title')}</h2>
          <span className="pill">{t('act.count', { n: all.length })}</span>
          <span className="meta">
            {t('all.sub', {
              p: projects.length,
              u: countOf('user'),
              pl: countOf('plugin'),
              b: countOf('built-in'),
            })}
            {dups.length > 0 &&
              ' · ' +
                t('all.dup', {
                  n: dups.length,
                  list: dups
                    .slice(0, 3)
                    .map((d) => `${d.name}: ${d.scopes.join(' / ')}`)
                    .join('、'),
                })}
          </span>
          <span className="hd-r">
            <select
              className={'sel' + (kind !== 'all' ? ' on' : '')}
              value={kind}
              onChange={(e) => setParam('kind', e.target.value === 'all' ? null : e.target.value)}
            >
              {KIND_FILTERS.map((key) => (
                <option key={key} value={key}>
                  {t('filter.kindPrefix', { v: key === 'all' ? t('kind.all') : key })}
                </option>
              ))}
            </select>
            {usage && (
              <select
                className={'sel' + (use !== 'all' ? ' on' : '')}
                value={use}
                title={t('filter.unusedTitle')}
                onChange={(e) => setParam('use', e.target.value === 'all' ? null : e.target.value)}
              >
                {(
                  [
                    ['all', t('kind.all')],
                    ['used', t('filter.used')],
                    ['unused', t('filter.unused')],
                  ] as [UseFilter, string][]
                ).map(([key, label]) => (
                  <option key={key} value={key}>
                    {t('filter.usePrefix', { v: label })}
                  </option>
                ))}
              </select>
            )}
            <select
              className="sel"
              value={sort}
              onChange={(e) => setParam('sort', e.target.value === 'name' ? null : e.target.value)}
              title={t('sort.title')}
            >
              {SORT_KEYS.map(([key, msgKey]) => (
                <option key={key} value={key}>
                  {t('sort.prefix', { v: t(msgKey) })}
                </option>
              ))}
            </select>
          </span>
        </div>
        <div className="blk-tools">
          <label className="search">
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5L14 14" />
            </svg>
            <input
              placeholder={t(narrow ? 'act.searchShort' : 'act.search')}
              value={q}
              onChange={(e) => setParam('q', e.target.value || null)}
            />
          </label>
          <span className="seg" title={t('view.title')}>
            {VIEW_MODES.map((v) => (
              <button
                key={v}
                className={by === v ? 'on' : ''}
                onClick={() => setParam('by', v === 'source' ? null : v)}
              >
                {t(VIEW_LABEL[v])}
              </button>
            ))}
          </span>
        </div>
        <div className="blk-body list">{body}</div>
      </section>
    </div>
  );
}
