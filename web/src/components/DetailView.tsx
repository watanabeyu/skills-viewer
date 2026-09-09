import { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  diagnoseSkill,
  fetchFile,
  fromId,
  openSkill,
  summarizeSkill,
  toId,
  type Section,
  type SkillsData,
} from '../api';
import {
  diagnosisInstruction,
  flatten,
  fmtDate,
  groupByPurpose,
  isUnused,
  kindMatches,
  matches,
  sameNameOthers,
  sortItems,
  usageLine,
  usageMatches,
  SRC_COLOR,
  SRC_TINT,
  type FlatItem,
  type KindFilter,
  type PurposeGroup,
  type SortKey,
  type UseFilter,
  type ViewMode,
} from '../util';
import { editorUrl, loadEditorSetting } from '../settings';
import { diffLines, type DiffLine } from '../diff';
import { mdRender, splitFrontmatter } from '../md';
import { lintLabel, relTypeLabel, t } from '../i18n';
import {
  GroupHeading,
  InvocationBadge,
  KindBadge,
  SectionHeading,
  UnusedBadge,
  WarnBadge,
} from './GridView';
import { CopyButton, InlineError, InlineNote } from './Inline';
import { FlowSection } from './FlowDiagram';

export function DetailView({
  data,
  all,
  q,
  sort,
  view,
  kind,
  use,
  onOpen,
  reload,
}: {
  data: SkillsData;
  all: FlatItem[];
  q: string;
  sort: SortKey;
  view: ViewMode;
  kind: KindFilter;
  use: UseFilter;
  onOpen: (key: string) => void;
  reload: () => Promise<void>;
}) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const key = fromId(id || '');
  const it = all.find((x) => x.key === key);

  const tabParam = params.get('tab');
  const tab = (tabParam === 'md' || tabParam === 'flow') && it?.hasMd ? tabParam : 'overview';
  const [summarizing, setSummarizing] = useState(false);
  // 操作起点の失敗はボタンの脇に 1 行で出す(alert は使わない)
  const [openError, setOpenError] = useState('');
  const [summaryError, setSummaryError] = useState('');

  if (!it) return <Navigate to={{ pathname: '/', search: params.toString() }} replace />;

  // 所属する用途グループ(手動 category が最優先、無ければ AI 割当を解決)
  const aiGroupDef = it.aiGroup ? data.groups?.find((g) => g.id === it.aiGroup) : undefined;

  const setTab = (tabName: string) => {
    const next = new URLSearchParams(params);
    if (tabName === 'md' || tabName === 'flow') next.set('tab', tabName);
    else next.delete('tab');
    navigate({ pathname: '/skills/' + toId(it.key), search: next.toString() }, { replace: true });
  };
  const backToGrid = () => {
    const next = new URLSearchParams(params);
    next.delete('tab');
    navigate({ pathname: '/', search: next.toString() });
  };

  const onOpenEditor = async () => {
    // 設定(⚙)の URL スキームで開く。OS デフォルト設定時のみサーバー側で開く
    setOpenError('');
    const url = editorUrl(loadEditorSetting(), it.path);
    if (url) {
      window.location.href = url;
      return;
    }
    try {
      await openSkill(it.path);
    } catch (e) {
      setOpenError(t('alert.openFailed', { msg: e instanceof Error ? e.message : String(e) }));
    }
  };
  const onSummarize = async () => {
    setSummarizing(true);
    setSummaryError('');
    try {
      await summarizeSkill(it.path, it.name);
      await reload();
    } catch (e) {
      setSummaryError(
        t('alert.summarizeFailed', { msg: e instanceof Error ? e.message : String(e) }),
      );
    } finally {
      setSummarizing(false);
    }
  };

  return (
    <div className="md-wrap">
      <LeftColumn
        data={data}
        q={q}
        sort={sort}
        view={view}
        kind={kind}
        use={use}
        selected={it.key}
        onOpen={onOpen}
      />
      <div className="pane">
        <button className="back" onClick={backToGrid}>
          {t('detail.back')}
        </button>
        <div className="meta-row">
          <span
            className="badge"
            style={{ color: SRC_COLOR[it.source], background: SRC_TINT[it.source] }}
          >
            {it.source}
          </span>
          <InvocationBadge it={it} />
          {(it.category || aiGroupDef) && (
            <span
              className="badge grp-badge"
              title={it.category ? t('group.manualTitle') : t('view.group')}
            >
              {it.category
                ? `📌 ${it.category} · ${t('group.manual')}`
                : `${aiGroupDef!.emoji || '📁'} ${aiGroupDef!.label}`}
            </span>
          )}
          <UnusedBadge show={isUnused(it, data.usageAvailable)} />
          <WarnBadge it={it} />
          {it.version && <span className="m-ver">v{it.version}</span>}
          <span className="m-upd">
            {it.updatedAt ? t('detail.lastUpdated', { date: fmtDate(it.updatedAt) }) : ''}
          </span>
          {/* 書き込み系(コピー・削除・編集)は v0.9.0 で廃止。残るのは読む導線だけ */}
          {!!it.path && (
            <button className="pbtn" onClick={onOpenEditor}>
              {t('detail.openEditor')}
            </button>
          )}
          <InlineError msg={openError} />
          {it.hasMd && (
            <button
              className="pbtn"
              disabled={summarizing || !data.aiAvailable}
              onClick={onSummarize}
            >
              {summarizing ? t('detail.summarizing') : t('detail.resummarize')}
            </button>
          )}
          <InlineError msg={summaryError} />
          {it.hasMd && !data.aiAvailable && <InlineNote msg={t('ai.unavailable')} />}
        </div>
        <h2 className="d-name">
          {it.name}
          <KindBadge it={it} />
        </h2>
        <div className="tabs">
          <button
            className={'tab' + (tab === 'overview' ? ' on' : '')}
            onClick={() => setTab('overview')}
          >
            {t('tab.overview')}
          </button>
          {it.hasMd && (
            <button
              className={'tab' + (tab === 'flow' ? ' on' : '')}
              onClick={() => setTab('flow')}
            >
              {/* 生成済みなら ✦ で「図がある」ことを示す */}
              {(it.aiFlow ? '✦ ' : '') + t('detail.flow')}
            </button>
          )}
          {it.hasMd && (
            <button className={'tab' + (tab === 'md' ? ' on' : '')} onClick={() => setTab('md')}>
              SKILL.md
            </button>
          )}
        </div>
        {tab === 'overview' ? (
          <OverviewTab
            it={it}
            all={all}
            dir={data.sections.find((s) => s.id === it.secId)?.note || ''}
            aiAvailable={data.aiAvailable}
            onOpen={onOpen}
            reload={reload}
          />
        ) : tab === 'flow' ? (
          <FlowTab
            it={it}
            all={all}
            aiAvailable={data.aiAvailable}
            onOpen={onOpen}
            reload={reload}
          />
        ) : (
          <MdTab it={it} />
        )}
      </div>
    </div>
  );
}

function LeftColumn({
  data,
  q,
  sort,
  view,
  kind,
  use,
  selected,
  onOpen,
}: {
  data: SkillsData;
  q: string;
  sort: SortKey;
  view: ViewMode;
  kind: KindFilter;
  use: UseFilter;
  selected: string;
  onOpen: (key: string) => void;
}) {
  interface ColGroup {
    key: string;
    /* この塊の先頭に出すソース見出し(用途別ではセクションの最初の塊のみ) */
    section: Section | null;
    /* section 見出しに出す件数(用途別ではセクション全体の件数) */
    sectionCount?: number;
    purpose: PurposeGroup | null;
    /* true ならカードに source ドット、false なら所属ラベル(フラット時) */
    dotted: boolean;
    items: FlatItem[];
  }

  const groups = useMemo<ColGroup[]>(() => {
    const pass = (it: FlatItem) =>
      kindMatches(it, kind) && matches(it, q) && usageMatches(it, use, data.usageAvailable);
    if (view === 'source') {
      return data.sections
        .map((s) => ({
          key: s.id,
          section: s,
          purpose: null,
          dotted: true,
          items: sortItems(flatten([s]).filter(pass), sort),
        }))
        .filter((g) => g.items.length > 0);
    }
    // 用途別: リポジトリ(セクション)→ 用途グループの入れ子(グループ未生成ならフラットに縮退)
    if (view === 'group' && data.groups?.length) {
      return data.sections.flatMap((s) => {
        const pgs = groupByPurpose(sortItems(flatten([s]).filter(pass), sort), data.groups);
        const total = pgs.reduce((n, g) => n + g.items.length, 0);
        return pgs.map((g, i) => ({
          key: s.id + ':' + g.id,
          section: i === 0 ? s : null,
          sectionCount: total,
          purpose: g,
          dotted: true,
          items: g.items,
        }));
      });
    }
    return [
      {
        key: 'flat',
        section: null,
        purpose: null,
        dotted: false,
        items: sortItems(flatten(data.sections).filter(pass), sort),
      },
    ];
  }, [data, q, sort, view, kind, use]);

  return (
    <div className="left-col">
      {groups.map((g) => (
        <div key={g.key}>
          {g.section && (
            <SectionHeading section={g.section} count={g.sectionCount ?? g.items.length} small />
          )}
          {g.purpose ? (
            <GroupHeading g={g.purpose} count={g.items.length} small sub />
          ) : (
            !g.section && <div style={{ height: 18 }} />
          )}
          {g.items.map((it) => (
            <button
              key={it.key}
              className={'ccard' + (it.key === selected ? ' sel' : '')}
              onClick={() => onOpen(it.key)}
            >
              {/* フラット時は所属が見えないので所属ラベルを出す(グリッドのカードと同じ体裁) */}
              {!g.dotted && (
                <span className="scope-mini">
                  <span className="dot5" style={{ background: SRC_COLOR[it.source] }} />
                  {it.scopeLabel}
                </span>
              )}
              <div className="r1">
                {g.dotted && <span className="dot7" style={{ background: SRC_COLOR[it.source] }} />}
                <span className="nm">{it.name}</span>
                {it.version && <span className="ver">v{it.version}</span>}
              </div>
              <div className="d1">{it.aiSummary || it.description}</div>
            </button>
          ))}
        </div>
      ))}
      {!groups.length && <div className="empty">{t('list.empty')}</div>}
    </div>
  );
}

/* skill 名を既知アイテムに解決: 同一プロジェクト → user/plugin/built-in の順(他プロジェクトの同名は対象外) */
function makeResolve(it: FlatItem, all: FlatItem[]): (name: string) => FlatItem | undefined {
  return (name: string) => {
    const hit = (pred: (x: FlatItem) => boolean) =>
      all.find((x) => pred(x) && (x.name === name || x.name.split(':').pop() === name));
    return hit((x) => x.secId === it.secId) || hit((x) => x.source !== 'project');
  };
}

/* フロータブ: AI 抽出した処理フローの図解(生成ボタン込み。FlowSection に委譲) */
function FlowTab({
  it,
  all,
  aiAvailable,
  onOpen,
  reload,
}: {
  it: FlatItem;
  all: FlatItem[];
  aiAvailable: boolean;
  onOpen: (key: string) => void;
  reload: () => Promise<void>;
}) {
  return (
    <FlowSection
      it={it}
      resolve={makeResolve(it, all)}
      aiAvailable={aiAvailable}
      onOpen={onOpen}
      reload={reload}
    />
  );
}

function OverviewTab({
  it,
  all,
  dir,
  aiAvailable,
  onOpen,
  reload,
}: {
  it: FlatItem;
  all: FlatItem[];
  /* 指示文の事実ヘッダに出す置き場の実体パス(Section.note) */
  dir: string;
  aiAvailable: boolean;
  onOpen: (key: string) => void;
  reload: () => Promise<void>;
}) {
  // AI 分類(関係タイプ付き)があればそれを、無ければ静的解析の参照候補を表示
  const relations = it.aiRelations?.length
    ? it.aiRelations
    : (it.refs || []).map((name) => ({ name, type: 'references' as const, note: '' }));
  const resolve = makeResolve(it, all);

  return (
    <div>
      {it.aiSummary && (
        <>
          <div className="sec-t">{t('detail.aiSummary')}</div>
          <p className="full-desc">
            <span className="ai-mark">✦ </span>
            {it.aiSummary}
          </p>
        </>
      )}
      <div className="sec-t">{t('detail.description')}</div>
      <p className="full-desc">{it.description}</p>
      {usageLine(it) && (
        <>
          <div className="sec-t">{t('detail.usage')}</div>
          <div className="ex-block">{usageLine(it)}</div>
        </>
      )}
      {(!!it.tokens || !!it.lint?.length || it.hasMd) && (
        <>
          <div className="sec-t">{t('detail.diagnostics')}</div>
          {!!it.tokens && (
            <p className="full-desc">{t('detail.tokenCost', { n: it.tokens.toLocaleString() })}</p>
          )}
          {(it.lint || []).map((code) => (
            <div className="lint-row" key={code}>
              <span className="lint-mark">⚠</span>
              <span>{lintLabel(code)}</span>
            </div>
          ))}
          {it.hasMd && (
            <DiagnosisBlock it={it} dir={dir} aiAvailable={aiAvailable} reload={reload} />
          )}
        </>
      )}
      <SameNameSection it={it} all={all} onOpen={onOpen} />
      {it.typedCount || it.autoCount ? (
        <>
          <div className="sec-t">{t('detail.usageStats')}</div>
          <p className="full-desc">
            {t('detail.usageDetail', { typed: it.typedCount || 0, auto: it.autoCount || 0 })}
            {it.lastUsed ? t('detail.usageLast', { date: fmtDate(it.lastUsed) }) : ''}
          </p>
          {it.dailyUse && <Sparkline daily={it.dailyUse} />}
        </>
      ) : null}
      {relations.length > 0 && (
        <>
          <div className="sec-t">{t('detail.relations')}</div>
          <div className="rel-chips">
            {relations.map((rel) => {
              const target = resolve(rel.name);
              return target ? (
                <button
                  key={rel.name}
                  className="rel-chip"
                  title={rel.note}
                  onClick={() => onOpen(target.key)}
                >
                  <span className="rt">{relTypeLabel(rel.type)}</span>
                  <span className="rn">/{rel.name}</span>
                </button>
              ) : (
                <span key={rel.name} className="rel-chip missing" title={rel.note}>
                  <span className="rt">{relTypeLabel(rel.type)}</span>
                  <span className="rn">/{rel.name}</span>
                  <span className="rm">{t('detail.notInstalled')}</span>
                </span>
              );
            })}
          </div>
        </>
      )}
      {it.files.length > 0 && (
        <>
          <div className="sec-t">{t('detail.files')}</div>
          {it.files.map((f) => (
            <div className="f-row" key={f}>
              <span className="sq6" />
              <span className="p">{f}</span>
            </div>
          ))}
        </>
      )}
      <div className="sec-t">{it.hasMd ? t('detail.path') : t('detail.location')}</div>
      <div className="f-row">
        <span className="sq6" />
        <span className="p">{it.path || t('detail.builtinLocation')}</span>
      </div>
    </div>
  );
}

/*
 * AI 発動診断ブロック。viewer は description を書き換えないので(計画 15 判断 1)、
 * 結果は「貼れる指示文」として全文を出す。改善案があれば「description を次に変える」、
 * 無ければ「変える場合に残すもの」を、末尾の確認手順つきで組む(memory 棚卸しと同じ形)。
 */
function DiagnosisBlock({
  it,
  dir,
  aiAvailable,
  reload,
}: {
  it: FlatItem;
  dir: string;
  aiAvailable: boolean;
  reload: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const d = it.aiDiagnosis;
  const instruction = d ? diagnosisInstruction(it, dir) : '';

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      await diagnoseSkill(it.path, it.name);
      await reload();
    } catch (e) {
      setError(t('alert.diagnoseFailed', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="diag-block">
      {d && (
        <div className="diag-box">
          <div className={'diag-verdict ' + d.verdict}>
            {t(d.verdict === 'good' ? 'diag.verdict.good' : 'diag.verdict.weak')}
          </div>
          {d.issues.map((issue) => (
            <div className="lint-row" key={issue}>
              <span className="lint-mark">·</span>
              <span>{issue}</span>
            </div>
          ))}
          {d.improved && d.improved !== it.description && (
            <>
              <div className="diag-imp-t">{t('diag.improved')}</div>
              <p className="diag-improved">
                <span className="ai-mark">✦ </span>
                {d.improved}
              </p>
            </>
          )}
          {/* 指示文は折りたたまず全文を出す(貼るかどうかの判断がここで完結するように) */}
          <div className="instr">
            <div className="instr-h">
              <span className="instr-t">{t('diag.instruction')}</span>
              <CopyButton className="copybtn" text={instruction} />
            </div>
            <div className="instr-body">{instruction}</div>
          </div>
        </div>
      )}
      <button
        className="pbtn sm"
        disabled={busy || !aiAvailable}
        onClick={run}
        title={t('diag.runTitle')}
      >
        {busy ? t('diag.running') : d ? t('diag.rerun') : '✦ ' + t('diag.run')}
      </button>
      <InlineError msg={error} />
      {!aiAvailable && <InlineNote msg={t('ai.unavailable')} />}
    </div>
  );
}

/*
 * 直近30日の日別使用回数を inline SVG の棒グラフで表示。
 * 日付キーはサーバー(usage.ts の dayKey)と同じローカルタイムゾーンの YYYY-MM-DD。
 */
function Sparkline({ daily }: { daily: Record<string, number> }) {
  const DAYS = 30;
  const BAR = 7;
  const GAP = 2;
  const H = 32;
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const days: { key: string; n: number }[] = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    days.push({ key, n: daily[key] || 0 });
  }
  const max = Math.max(...days.map((d) => d.n), 1);
  return (
    <div className="spark-wrap">
      <svg
        className="spark"
        width={DAYS * (BAR + GAP)}
        height={H}
        role="img"
        aria-label={t('detail.spark')}
      >
        {days.map((d, i) => {
          const h = d.n ? Math.max(3, Math.round((d.n / max) * (H - 4))) : 2;
          return (
            <rect
              key={d.key}
              className={d.n ? 'on' : ''}
              x={i * (BAR + GAP)}
              y={H - h}
              width={BAR}
              height={h}
              rx={1.5}
            >
              <title>{`${d.key}: ${d.n}`}</title>
            </rect>
          );
        })}
      </svg>
      <span className="spark-label">{t('detail.spark')}</span>
    </div>
  );
}

/*
 * 同名の別定義。scope 間の重複(例: code-review が user と複数プロジェクトに存在)を
 * 見つけて、開く / SKILL.md の diff 比較ができるようにする。
 */
function SameNameSection({
  it,
  all,
  onOpen,
}: {
  it: FlatItem;
  all: FlatItem[];
  onOpen: (key: string) => void;
}) {
  const [diffWith, setDiffWith] = useState<FlatItem | null>(null);
  const others = sameNameOthers(it, all);
  if (!others.length) return null;
  return (
    <>
      <div className="sec-t">{t('detail.sameName', { n: others.length })}</div>
      {others.map((o) => (
        <div className="f-row" key={o.key}>
          <span className="dot5" style={{ background: SRC_COLOR[o.source] }} />
          <span className="p">{o.scopeLabel}</span>
          <span className="same-actions">
            <button className="pbtn sm" onClick={() => onOpen(o.key)}>
              {t('detail.open')}
            </button>
            {it.hasMd && o.hasMd && (
              <button
                className={'pbtn sm' + (diffWith?.key === o.key ? ' on' : '')}
                onClick={() => setDiffWith(diffWith?.key === o.key ? null : o)}
              >
                {diffWith?.key === o.key ? t('detail.diffClose') : t('detail.diff')}
              </button>
            )}
          </span>
        </div>
      ))}
      {diffWith && <DiffBlock a={it} b={diffWith} />}
    </>
  );
}

function DiffBlock({ a, b }: { a: FlatItem; b: FlatItem }) {
  const [lines, setLines] = useState<DiffLine[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setLines(null);
    setError('');
    Promise.all([fetchFile(a.path), fetchFile(b.path)])
      .then(([ta, tb]) => {
        if (alive) setLines(diffLines(ta, tb));
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [a.path, b.path]);

  if (error) return <div className="empty">{t('diff.failed', { msg: error })}</div>;
  if (!lines) return <div className="empty">{t('common.loading')}</div>;
  const changed = lines.filter((l) => l.type === 'add' || l.type === 'del').length;
  return (
    <div className="diff-wrap">
      <div className="diff-legend">
        <span className="d-del-mark">{t('diff.thisDef', { label: a.scopeLabel })}</span>
        <span className="d-add-mark">+ {b.scopeLabel}</span>
        <span className="d-count">
          {changed === 0 ? t('diff.identical') : t('diff.changed', { n: changed })}
        </span>
      </div>
      {changed > 0 && (
        <div className="diff">
          {lines.map((l, i) =>
            l.type === 'skip' ? (
              <div className="d-skip" key={i}>
                {t('diff.skip', { n: l.count })}
              </div>
            ) : (
              <div className={'d-line d-' + l.type} key={i}>
                {(l.type === 'add' ? '+ ' : l.type === 'del' ? '− ' : '  ') + l.text}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

const mdCache = new Map<string, string>();

/* 「エディタで開く」で編集 → 再スキャン後に古い SKILL.md が残らないよう reload 時に呼ぶ */
export function clearMdCache(): void {
  mdCache.clear();
}

/* 全文表示(読むだけ)。ブラウザ内編集は v0.9.0 で廃止し、書き換えはエディタ側に渡す */
function MdTab({ it }: { it: FlatItem }) {
  const path = it.path;
  const [raw, setRaw] = useState<string | null>(mdCache.get(path) ?? null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    if (mdCache.has(path)) {
      setRaw(mdCache.get(path)!);
      return;
    }
    setRaw(null);
    setError('');
    fetchFile(path)
      .then((content) => {
        mdCache.set(path, content);
        if (alive) setRaw(content);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [path]);

  if (error) return <div className="empty">{t('app.loadFailed', { msg: error })}</div>;
  if (raw === null) return <div className="empty">{t('common.loading')}</div>;

  const { frontmatter, body } = splitFrontmatter(raw);
  return (
    <div>
      {frontmatter && <div className="fm-box">{frontmatter}</div>}
      {/* 自前レンダラ内で全テキストを HTML エスケープ済み */}
      <div className="md-body" dangerouslySetInnerHTML={{ __html: mdRender(body) }} />
    </div>
  );
}
