/*
 * memory 一覧(/memory。計画 15 Phase F / README 6.2「索引が何を毎回持ち込んでいるか」)。
 * v0.8 の独立した棚卸し画面(プロジェクト単位の別ルート)を廃止し、AI 診断をこの一覧と詳細に統合した。
 * プロジェクト単位: 名前と要約 → 索引コスト(310 tok / 3 行 / 200 行・25KB のバー)と本文合計 →
 * 見出し 2 段(1 段目 = 名前・件数・置き場・棚卸しボタン・並び / 2 段目 = 検索 + 種類)→ 行。
 * 行 = 名前と索引行 / 種類 / 鮮度 / 読まれた(書き換え)/ 索引 tok(索引に無ければ ⚠)/ 本文 tok / 診断(4 語)/ 更新。
 * 寸法は docs/design/0.9.0/{Ledger,Console}MemoryList.dc.html の実測(style.css の --mem-* トークン)。
 * 棚卸し前は診断列が「—」で、鮮度とシグナルだけが出る(AI 無しでも成立)。
 */

import { useState } from 'react';
import type { MemorySection, Section, SkillItem, SkillsData } from '../api';
import {
  changeMarkOf,
  relTimeLabel,
  skewedVerdict,
  type MemorySortKey,
  type RefFilter,
} from '../util';
import {
  TYPE_FILTERS,
  costOf,
  indexRatio,
  memoryRows,
  sectionsFor,
  type TypeFilter,
} from '../memory';
import { memoryVerdictLabel, t, type MsgKey } from '../i18n';
import { Bar, KindPill, Mark, SourcePill, useNarrow } from './Rows';
import { InlineError, InlineNote } from './Inline';
import { EditorButton, useOpenEditor } from './EditorButton';
import { MemoryTypePill, StateDot, VerdictWordCell, runTriage, usageTitle } from './MemoryBits';

/*
 * memory 軸の並び順。URL パラメータは skill 軸の sort と分けて msort に置く
 * (updated は skill = 新しい順 / memory = 古い順で意味が逆、値の集合も違うため)。
 */
export const MEM_SORT_KEYS: [MemorySortKey, MsgKey][] = [
  ['index', 'sort.memIndex'],
  ['body', 'sort.memBody'],
  ['updated', 'sort.memStale'],
  ['name', 'sort.name'],
];

export interface MemoryListProps {
  data: SkillsData;
  /* ヘッダーの切替(?project=)。一覧はプロジェクト単位なので、これに従ってセクションを選ぶ */
  project: Section | 'all' | null;
  q: string;
  sort: MemorySortKey;
  refFilter: RefFilter;
  type: TypeFilter;
  setParam: (key: string, value: string | null) => void;
  onOpen: (path: string) => void;
  reload: () => Promise<void>;
}

export function MemoryList({
  data,
  project,
  q,
  sort,
  refFilter,
  type,
  setParam,
  onOpen,
  reload,
}: MemoryListProps) {
  const all = data.memory || [];
  const sections = sectionsFor(all, project);
  const single = sections.length === 1 ? sections[0] : null;
  return (
    <div className="dv">
      <TitleBlock data={data} project={project} sec={single} />
      {sections.length === 0 && (
        <div className="dblk">
          <div className="dv-empty">
            {/* 環境に memory が無い(公式仕様を案内)か、このプロジェクトに無いだけかを言い分ける */}
            {t(
              all.some((s) => s.items.length > 0) ? 'memory.list.emptyProject' : 'memory.emptyEnv',
            )}
          </div>
        </div>
      )}
      {sections.map((sec) => (
        <MemoryProject
          key={sec.id}
          sec={sec}
          data={data}
          q={q}
          sort={sort}
          refFilter={refFilter}
          type={type}
          setParam={setParam}
          onOpen={onOpen}
          reload={reload}
        />
      ))}
    </div>
  );
}

/* 名前とチップ、右端に「エディタで開く」(単一プロジェクトのとき MEMORY.md を開く)。下に要約文 */
function TitleBlock({
  data,
  project,
  sec,
}: {
  data: SkillsData;
  project: Section | 'all' | null;
  sec: MemorySection | null;
}) {
  const isAll = project === 'all';
  /* 選んでいるのがどのプロジェクトかはサーバーの応答(selected)が正。0 件のプロジェクトでも名前が出る */
  const name = isAll ? '' : sec?.projectName || data.selected.name;
  const indexPath = sec ? sec.note.replace(/[\\/]+$/, '') + '/MEMORY.md' : '';
  const { openError, onOpenEditor } = useOpenEditor(indexPath);
  return (
    <div className="dv-title">
      <div className="dv-title-row">
        <h1>{isAll ? t('memory.list.titleAll') : t('memory.list.title', { name })}</h1>
        <KindPill kind="memory" />
        {!isAll && name && <SourcePill source="project" label={name} />}
        {sec?.orphan && (
          <span className="pill" title={t('memory.orphanTitle')}>
            {t('memory.orphan')}
          </span>
        )}
        {sec?.sharedStore && (
          <span className="pill" title={t('memory.sharedStoreTitle')}>
            {t('memory.sharedStore')}
          </span>
        )}
        <span className="dv-title-r">
          <InlineError msg={openError} />
          {indexPath && <EditorButton onClick={onOpenEditor} />}
        </span>
      </div>
      <p className="dv-desc">{t(isAll ? 'memory.list.leadAll' : 'memory.list.lead')}</p>
    </div>
  );
}

/* 1 プロジェクト分 = コスト → 見出し 2 段(偏り警告はその下の 1 行)→ 行 → 注記 */
function MemoryProject({
  sec,
  data,
  q,
  sort,
  refFilter,
  type,
  setParam,
  onOpen,
  reload,
}: { sec: MemorySection } & Omit<MemoryListProps, 'project'>) {
  const narrow = useNarrow();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const rows = memoryRows(sec, { q, sort, ref: refFilter, type });
  const cost = costOf(sec);
  const limit = data.context.memoryIndex;
  const ratio = indexRatio(cost.lines, limit.limitLines);
  // 提案が 1 種類に偏っているときは、行き先より先に「プロジェクトの特定」を疑ってもらう(13 の skewedVerdict)
  const skew = skewedVerdict(sec.items);
  const pending = sec.items.some((it) => !it.aiTriage);

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      await runTriage(sec, data.selected.id);
      await reload();
    } catch (e) {
      setError(t('alert.triageFailed', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="mpanel mcost">
        <div className="mcost-l">
          <span className="fk">{t('memory.cost.index')}</span>
          <span className="mcost-v num">
            {cost.indexTok.toLocaleString()} <span className="meta">{t('memory.cost.unit')}</span>
          </span>
          <span className="meta">{t('memory.cost.indexNote')}</span>
        </div>
        <div className="mcost-r">
          <div className="mcost-row">
            <span>
              {t('memory.cost.lines')}{' '}
              <span className="meta">
                {t('memory.cost.linesOf', { n: cost.lines, limit: limit.limitLines })}
              </span>
            </span>
            <span className={'num' + (ratio > 1 ? ' warn' : '')}>{cost.lines}</span>
            <span className="num meta">
              {t(narrow ? 'ctx.memoryLimitShort' : 'ctx.memoryLimit', {
                lines: limit.limitLines,
                kb: Math.round(limit.limitBytes / 1024),
              })}
            </span>
            <Bar ratio={ratio} over={ratio > 1} />
          </div>
          <div className="mcost-row">
            <span>
              {t('memory.cost.bodies')} <span className="meta">{t('memory.cost.bodiesNote')}</span>
            </span>
            <span className="num">{cost.bodyTok.toLocaleString()}</span>
            <span className="num meta">—</span>
            <span />
          </div>
          <div className="meta mnote">
            {t('memory.cost.note', { n: cost.indexTok.toLocaleString() })}
            {cost.beyond > 0 && ' · ' + t('memory.cost.indexBeyond', { n: cost.beyond })}
          </div>
        </div>
      </div>

      <section className="mpanel">
        <div className="mhd">
          <span className="mcap">{t('memory.hd.cap')}</span>
          <span className="pill">{sec.items.length}</span>
          <span className="meta ellip" title={sec.note}>
            {t('memory.hd.meta', { name: sec.projectName, path: sec.note })}
          </span>
          <span className="hd-r">
            <InlineError msg={error} />
            {!data.aiAvailable && <InlineNote msg={t('ai.unavailable')} />}
            {/* 棚卸しはプロジェクト単位(重複・別プロジェクト混入は全件を同時に見ないと判定できない) */}
            <button
              className="btn"
              disabled={busy || !data.aiAvailable || !sec.items.length}
              onClick={run}
              title={t(pending ? 'memory.triage.runTitle' : 'memory.triage.rerunTitle')}
            >
              {busy
                ? t('memory.triage.running')
                : pending
                  ? t('memory.triage.runShort')
                  : t('memory.triage.rerun')}
            </button>
            <select
              className="sel"
              value={sort}
              onChange={(e) =>
                setParam('msort', e.target.value === 'index' ? null : e.target.value)
              }
              title={t('sort.title')}
            >
              {MEM_SORT_KEYS.map(([key, msgKey]) => (
                <option key={key} value={key}>
                  {t('sort.prefix', { v: t(msgKey) })}
                </option>
              ))}
            </select>
            {sec.usageAvailable && (
              <select
                className={'sel' + (refFilter !== 'all' ? ' on' : '')}
                value={refFilter}
                title={t('filter.refTitle')}
                onChange={(e) => setParam('ref', e.target.value === 'all' ? null : e.target.value)}
              >
                {(
                  [
                    ['all', t('kind.all')],
                    ['read', t('filter.refRead')],
                    ['unread', t('filter.refUnread')],
                  ] as [RefFilter, string][]
                ).map(([key, label]) => (
                  <option key={key} value={key}>
                    {t('filter.refPrefix', { v: label })}
                  </option>
                ))}
              </select>
            )}
          </span>
        </div>
        <div className="blk-tools mtools">
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
              placeholder={t(narrow ? 'act.searchShort' : 'memory.searchPlaceholder')}
              value={q}
              onChange={(e) => setParam('q', e.target.value || null)}
            />
          </label>
          <span className="seg">
            {TYPE_FILTERS.map((k) => (
              <button
                key={k}
                className={type === k ? 'on' : ''}
                onClick={() => setParam('mtype', k === 'all' ? null : k)}
              >
                {k === 'all' ? t('kind.all') : k}
              </button>
            ))}
          </span>
        </div>
        {/* 偏り警告。verdict は上書きせず、確認の順序(まずプロジェクトの特定)だけを促す */}
        {skew && !busy && (
          <div className="mskew">
            <span className="warn">⚠ {memoryVerdictLabel(skew)}</span>
            <span className="meta">{t('memory.triage.skew')}</span>
          </div>
        )}
        <div className={'mrow thead' + (sec.usageAvailable ? '' : ' no-uses')}>
          <span />
          <span>{t('memory.col.name')}</span>
          <span>{t('memory.col.type')}</span>
          <span>{t('memory.col.state')}</span>
          {sec.usageAvailable && <span className="num">{t('memory.col.reads')}</span>}
          <span className="num">{t('memory.col.idx')}</span>
          <span className="num c-body">{t('memory.col.body')}</span>
          <span>{t('memory.col.triage')}</span>
          <span>{t('memory.col.updated')}</span>
        </div>
        {rows.length ? (
          rows.map((it) => (
            <MemoryRow
              key={it.path}
              it={it}
              sec={sec}
              mark={changeMarkOf(it, data.changes)}
              busy={busy}
              onOpen={onOpen}
            />
          ))
        ) : (
          <div className="trow-empty meta">{t('list.empty')}</div>
        )}
        <div className="mnote mfoot meta">{t('memory.list.note')}</div>
      </section>
    </>
  );
}

/* 1 行。索引に無い件は索引 tok の代わりに「— ⚠」(注入されていない事実を色だけにしない。0.2) */
function MemoryRow({
  it,
  sec,
  mark,
  busy,
  onOpen,
}: {
  it: SkillItem;
  sec: MemorySection;
  mark: 'add' | 'mod' | null;
  busy: boolean;
  onOpen: (path: string) => void;
}) {
  const usage = sec.usageAvailable;
  const reads = it.useCount || 0;
  const writes = it.writeCount || 0;
  // 上限外の索引行は書いてあっても注入されないので、索引 tok は「無い」側に寄せる
  const noIndex = !it.indexLine || it.indexBeyondLimit;
  return (
    <button
      className={'mrow' + (usage ? '' : ' no-uses') + (busy ? ' busy' : '')}
      onClick={() => onOpen(it.path)}
    >
      <span className="mmark">{mark && <Mark mark={mark} small />}</span>
      <span className="cell mcell">
        <span className="nm">{it.name}</span>
        <span className="desc">{it.description}</span>
      </span>
      <span>
        <MemoryTypePill it={it} />
      </span>
      <span>
        <StateDot it={it} />
      </span>
      {usage && (
        <span className="num sub" title={usageTitle(sec, t('memory.readsTitle'))}>
          {reads || '0'}
          {writes > 0 && <span className="meta">{t('memory.reads.w', { n: writes })}</span>}
        </span>
      )}
      <span
        className={'num' + (noIndex ? ' warn' : '')}
        title={
          noIndex ? t(it.indexLine ? 'memory.index.beyond' : 'memory.idxMissingTitle') : undefined
        }
      >
        {noIndex ? t('memory.idxMissing') : (it.indexTokens || 0).toLocaleString()}
      </span>
      <span className="num sub c-body">{(it.bodyTokens || 0).toLocaleString()}</span>
      <span>
        <VerdictWordCell tri={it.aiTriage} />
      </span>
      <span className="meta nowrap">{relTimeLabel(it.updatedAt)}</span>
    </button>
  );
}
