/*
 * ホーム(計画 15 Phase D / README 6.2)。利用者の 3 つの問いに上から順に答える 3 ブロック:
 *   ① 増えた・変わった(ChangesBlock)
 *   ② セッションの文脈: 合計 + 3 内訳(CLAUDE.md 群 / MEMORY.md 索引 / skill の description)
 *   ③ 効いているもの: このプロジェクト + user + plugin + built-in。このプロジェクトだけ開く
 * 寸法は docs/design/0.9.0/{Ledger,Console}Home.dc.html の実測(style.css のトークン)。
 *
 * ② はサーバーが cwd で計算した値(SkillsData.context)なので、切替で別プロジェクトを選んだときは
 * 出さない(その値はそのプロジェクトのセッションの文脈ではない)。「すべてのプロジェクト」も同様。
 */

import { useState } from 'react';
import type { Section, SkillsData, Source } from '../api';
import {
  changeMarkOf,
  claudeMdCounts,
  contextRows,
  contextTotal,
  fileName,
  flatten,
  KIND_FILTERS,
  kindMatches,
  matches,
  scopeLabelOf,
  sectionTokens,
  sessionSections,
  sortItems,
  usageMatches,
  type KindFilter,
  type SortKey,
  type UseFilter,
} from '../util';
import { t } from '../i18n';
import { ChangesBlock } from './ChangesBlock';
import { InlineError, InlineNote } from './Inline';
import { SearchBox, Seg, SortSelect, UseSelect } from './ListTools';
import { Bar, GroupHead, ItemRow, TableHead, useNarrow } from './Rows';

/*
 * 全件要約(summarize-all)の操作。v0.8 のヘッダー「✦ AI」メニューにあったものを ③ の見出し行へ移した
 * (計画 15 Phase F)。ジョブの状態(ラベル・実行中・失敗)は App が持ち、ここは表示と起動だけ。
 */
export interface SummaryAction {
  label: string;
  busy: boolean;
  error: string;
  onRun: () => void;
}

/* ---- ② セッションの文脈 ---- */

function ContextBlock({
  data,
  onOpenMemoryList,
  onOpenClaudeMd,
}: {
  data: SkillsData;
  onOpenMemoryList: () => void;
  onOpenClaudeMd: (path?: string) => void;
}) {
  const narrow = useNarrow();
  const rows = contextRows(data);
  const total = contextTotal(rows);
  const c = data.context;
  const md = claudeMdCounts(data.claudeMd);
  const layer = (k: string, n: number) =>
    n ? t('ctx.layer', { k, n }) : t('ctx.layerNone', { k });
  const label: Record<string, { name: string; note: string; limit: string; title?: string }> = {
    claudeMd: {
      name: t('ctx.claudeMd'),
      note: [layer('user', md.user), layer('project', md.project), layer('rules', md.rules)].join(
        ' · ',
      ),
      limit: t('ctx.noLimit'),
      title: t('ctx.claudeMdTitle'),
    },
    memory: {
      name: t('ctx.memory'),
      note: t('ctx.memoryNote', { n: c.memoryIndex.lines }),
      limit: t(narrow ? 'ctx.memoryLimitShort' : 'ctx.memoryLimit', {
        lines: c.memoryIndex.limitLines,
        kb: Math.round(c.memoryIndex.limitBytes / 1024),
      }),
      title: t('ctx.memoryTitle'),
    },
    descriptions: {
      name: t('ctx.desc'),
      note: c.descriptions.hiddenCount
        ? t('ctx.descNote', { n: c.descriptions.count, h: c.descriptions.hiddenCount })
        : t('ctx.descNoteNoHidden', { n: c.descriptions.count }),
      limit: t('ctx.descLimit', { n: c.descriptions.limit.toLocaleString() }),
    },
  };
  return (
    <section className="blk">
      <div className="blk-hd">
        <h2>{t('ctx.title')}</h2>
        <span className="meta">{t('ctx.sub')}</span>
        <span className="meta hd-r">{t('ctx.excl')}</span>
      </div>
      <div className="blk-body ctx">
        <div className="ctx-total">
          <span className="k">{t('ctx.total')}</span>
          <span className="v num">{total.toLocaleString()}</span>
          <span className="u meta num">{t('ctx.unit')}</span>
        </div>
        <div className="ctx-table">
          <div className="ctx-row thead">
            <span>{t('ctx.colSource')}</span>
            <span className="num">{t('ctx.colTok')}</span>
            <span className="num">{t('ctx.colLimit')}</span>
            <span />
          </div>
          {rows.map((r) => {
            const l = label[r.key];
            // memory は一覧、CLAUDE.md は階層と本文の画面(E2)へ。description の未使用・lint 一覧は F 以降
            const open =
              r.key === 'memory'
                ? onOpenMemoryList
                : r.key === 'claudeMd'
                  ? () => onOpenClaudeMd()
                  : undefined;
            const Tag = open ? 'button' : 'div';
            return (
              <Tag
                key={r.key}
                className={'ctx-row' + (r.over ? ' over' : '')}
                onClick={open}
                title={l.title}
              >
                <span className="cell">
                  <span className="nm">
                    {l.name}
                    {r.over && <span className="warn-inline">{t('ctx.over')}</span>}
                  </span>
                  <span className="meta">{l.note}</span>
                </span>
                <span className={'num' + (r.over ? ' warn' : '')}>{r.tok.toLocaleString()}</span>
                <span className="num meta">{l.limit}</span>
                <span className="c-bar">
                  {r.ratio !== null && <Bar ratio={r.ratio} over={r.over} />}
                </span>
              </Tag>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ---- ③ 効いているもの ---- */

export function ActiveBlock({
  data,
  project,
  q,
  sort,
  kind,
  use,
  summary,
  onOpen,
  setParam,
}: {
  data: SkillsData;
  project: Section | null;
  q: string;
  sort: SortKey;
  kind: KindFilter;
  use: UseFilter;
  summary: SummaryAction;
  onOpen: (key: string) => void;
  setParam: (key: string, value: string | null) => void;
}) {
  const narrow = useNarrow();
  const usage = data.usageAvailable;
  const sections = sessionSections(data.sections, project);
  const total = sections.reduce((n, s) => n + s.items.length, 0);
  // このプロジェクトだけ開き、user / plugin / built-in は畳んだ見出し(件数・tok)だけ(1.2)
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const isOpen = (id: string) => open[id] ?? (project ? id === project.id : false);
  const toggle = (id: string) => setOpen((o) => ({ ...o, [id]: !isOpen(id) }));
  const pass = (it: Section['items'][number]) =>
    kindMatches(it, kind) && matches(it, q) && usageMatches(it, use, usage);
  const groupName = (s: Section) => (s.source === 'project' ? t('act.thisProject') : s.source);
  const groupMeta = (s: Section) => {
    const n = t('act.count', { n: s.items.length });
    if (s.source === 'project') return `${s.projectName} · ${n}`;
    if (s.source === 'user') return `~/.claude · ${n} · ${t('act.everyProject')}`;
    return n;
  };
  return (
    <section className="blk">
      <div className="blk-hd">
        <h2>{t('act.title')}</h2>
        <span className="pill">{t('act.count', { n: total })}</span>
        <span className="meta">{t(narrow ? 'act.subShort' : 'act.sub')}</span>
        {!usage && <span className="meta">· {t('act.noUsage')}</span>}
        <span className="hd-r">
          {/* 全件要約(claude CLI)。不在なら押せない理由を脇に出す。失敗も alert でなくここに 1 行 */}
          <InlineError msg={summary.error} />
          {!data.aiAvailable && <InlineNote msg={t('ai.unavailable')} />}
          <button
            className="btn quiet"
            disabled={summary.busy || !data.aiAvailable}
            onClick={summary.onRun}
            title={t('ai.buttonTitle')}
          >
            ✦ {summary.label}
          </button>
          <UseSelect use={use} usage={usage} setParam={setParam} />
          <SortSelect sort={sort} setParam={setParam} />
        </span>
      </div>
      <div className="blk-tools">
        <SearchBox q={q} setParam={setParam} />
        {/* 種類はここでは押し分けの見えるセグメントで出す(絞り込みが 1 つしか無いので select に畳まない) */}
        <Seg
          options={KIND_FILTERS.map((k): [KindFilter, string] => [
            k,
            k === 'all' ? t('kind.all') : k,
          ])}
          value={kind}
          onPick={(k) => setParam('kind', k === 'all' ? null : k)}
        />
      </div>
      <div className="blk-body list">
        {/* cwd のプロジェクトにアイテムが無いときも「このプロジェクト · 0 件」の見出しは残す */}
        {!project && (
          <GroupHead
            open={false}
            onToggle={() => {}}
            source="project"
            name={t('act.thisProject')}
            meta={`${fileName(data.cwd)} · ${t('act.count', { n: 0 })} · ${t('proj.empty')}`}
            tok={0}
          />
        )}
        {sections.map((s) => {
          const items = isOpen(s.id) ? sortItems(flatten([s]).filter(pass), sort) : [];
          return (
            <div key={s.id} className="grp">
              <GroupHead
                open={isOpen(s.id)}
                onToggle={() => toggle(s.id)}
                source={s.source}
                name={groupName(s)}
                meta={groupMeta(s)}
                tok={sectionTokens(s)}
              />
              {isOpen(s.id) &&
                (items.length ? (
                  <>
                    <TableHead usage={usage} />
                    {items.map((it) => (
                      <ItemRow
                        key={it.key}
                        it={it}
                        source={s.source as Source}
                        scopeLabel={scopeLabelOf(s)}
                        mark={changeMarkOf(it, data.changes)}
                        usage={usage}
                        onOpen={onOpen}
                      />
                    ))}
                  </>
                ) : (
                  <div className="trow-empty meta">{t('act.empty')}</div>
                ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function Home({
  data,
  project,
  q,
  sort,
  kind,
  use,
  onOpen,
  onOpenMemory,
  onOpenMemoryList,
  onOpenClaudeMd,
  summary,
  setParam,
  reload,
}: {
  data: SkillsData;
  project: Section | null;
  q: string;
  sort: SortKey;
  kind: KindFilter;
  use: UseFilter;
  onOpen: (key: string) => void;
  onOpenMemory: (path: string) => void;
  onOpenMemoryList: () => void;
  onOpenClaudeMd: (path?: string) => void;
  summary: SummaryAction;
  setParam: (key: string, value: string | null) => void;
  reload: () => Promise<void>;
}) {
  const isCwd = !project || !!project.isCurrent;
  return (
    <div className="home">
      <ChangesBlock
        data={data}
        project={project}
        onOpen={onOpen}
        onOpenMemory={onOpenMemory}
        onOpenClaudeMd={onOpenClaudeMd}
        reload={reload}
      />
      {isCwd && (
        <ContextBlock
          data={data}
          onOpenMemoryList={onOpenMemoryList}
          onOpenClaudeMd={onOpenClaudeMd}
        />
      )}
      <ActiveBlock
        data={data}
        project={project}
        q={q}
        sort={sort}
        kind={kind}
        use={use}
        summary={summary}
        onOpen={onOpen}
        setParam={setParam}
      />
    </div>
  );
}
