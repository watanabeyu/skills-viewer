import { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  copySkill,
  deleteSkill,
  fetchFile,
  fromId,
  openSkill,
  summarizeSkill,
  toId,
  type SkillsData,
} from '../api';
import {
  flatten,
  fmtDate,
  kindMatches,
  matches,
  sameNameOthers,
  sortItems,
  usageLine,
  SRC_COLOR,
  SRC_TINT,
  type FlatItem,
  type KindFilter,
  type SortKey,
} from '../util';
import { editorUrl, loadEditorSetting } from '../settings';
import { diffLines, type DiffLine } from '../diff';
import { mdRender, splitFrontmatter } from '../md';
import { relTypeLabel, t } from '../i18n';
import { InvocationBadge, KindBadge, SectionHeading } from './GridView';
import { CopyMenu } from './CopyMenu';
import { DeleteModal } from './DeleteModal';

export function DetailView({
  data,
  all,
  q,
  sort,
  grouped,
  kind,
  onOpen,
  reload,
}: {
  data: SkillsData;
  all: FlatItem[];
  q: string;
  sort: SortKey;
  grouped: boolean;
  kind: KindFilter;
  onOpen: (key: string) => void;
  reload: () => Promise<void>;
}) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const key = fromId(id || '');
  const it = all.find((x) => x.key === key);

  const tab = params.get('tab') === 'md' && it?.hasMd ? 'md' : 'overview';
  const [copyOpen, setCopyOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [summarizing, setSummarizing] = useState(false);

  if (!it) return <Navigate to={{ pathname: '/', search: params.toString() }} replace />;

  const setTab = (tabName: string) => {
    const next = new URLSearchParams(params);
    if (tabName === 'md') next.set('tab', 'md');
    else next.delete('tab');
    navigate({ pathname: '/skills/' + toId(it.key), search: next.toString() }, { replace: true });
  };
  const backToGrid = () => {
    const next = new URLSearchParams(params);
    next.delete('tab');
    navigate({ pathname: '/', search: next.toString() });
  };

  const onCopy = async (target: string) => {
    setCopyOpen(false);
    try {
      const r = await copySkill(it.path, target);
      await reload();
      onOpen(r.destMd + '#' + r.destName); // コピー先の詳細を表示(design 仕様)
    } catch (e) {
      alert(t('alert.copyFailed', { msg: e instanceof Error ? e.message : String(e) }));
    }
  };
  const onDelete = async () => {
    try {
      const r = await deleteSkill(it.path);
      setConfirmDelete(false);
      await reload();
      backToGrid();
      alert(t('alert.trashed', { path: r.trashedTo }));
    } catch (e) {
      alert(t('alert.deleteFailed', { msg: e instanceof Error ? e.message : String(e) }));
    }
  };
  const onOpenEditor = async () => {
    // 設定(⚙)の URL スキームで開く。OS デフォルト設定時のみサーバー側で開く
    const url = editorUrl(loadEditorSetting(), it.path);
    if (url) {
      window.location.href = url;
      return;
    }
    try {
      await openSkill(it.path);
    } catch (e) {
      alert(t('alert.openFailed', { msg: e instanceof Error ? e.message : String(e) }));
    }
  };
  const onSummarize = async () => {
    setSummarizing(true);
    try {
      await summarizeSkill(it.path, it.name);
      await reload();
    } catch (e) {
      alert(t('alert.summarizeFailed', { msg: e instanceof Error ? e.message : String(e) }));
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
        grouped={grouped}
        kind={kind}
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
          {it.version && <span className="m-ver">v{it.version}</span>}
          <span className="m-upd">
            {it.updatedAt ? t('detail.lastUpdated', { date: fmtDate(it.updatedAt) }) : ''}
          </span>
          {!!it.path && (
            <button className="pbtn" onClick={onOpenEditor}>
              {t('detail.openEditor')}
            </button>
          )}
          {it.manage && (
            <>
              <span style={{ position: 'relative' }}>
                <button className="pbtn" onClick={() => setCopyOpen((v) => !v)}>
                  {t('detail.copy')}
                </button>
                {copyOpen && (
                  <CopyMenu
                    targets={data.targets}
                    onPick={onCopy}
                    onClose={() => setCopyOpen(false)}
                  />
                )}
              </span>
              <button className="pbtn" disabled={summarizing} onClick={onSummarize}>
                {summarizing ? t('detail.summarizing') : t('detail.resummarize')}
              </button>
              <button className="pbtn danger" onClick={() => setConfirmDelete(true)}>
                {t('detail.delete')}
              </button>
            </>
          )}
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
            <button className={'tab' + (tab === 'md' ? ' on' : '')} onClick={() => setTab('md')}>
              SKILL.md
            </button>
          )}
        </div>
        {tab === 'overview' ? (
          <OverviewTab it={it} all={all} onOpen={onOpen} />
        ) : (
          <MdTab path={it.path} />
        )}
      </div>
      {confirmDelete && (
        <DeleteModal name={it.name} onCancel={() => setConfirmDelete(false)} onDelete={onDelete} />
      )}
    </div>
  );
}

function LeftColumn({
  data,
  q,
  sort,
  grouped,
  kind,
  selected,
  onOpen,
}: {
  data: SkillsData;
  q: string;
  sort: SortKey;
  grouped: boolean;
  kind: KindFilter;
  selected: string;
  onOpen: (key: string) => void;
}) {
  const groups = useMemo(() => {
    const pass = (it: FlatItem) => kindMatches(it, kind) && matches(it, q);
    if (grouped) {
      return data.sections
        .map((s) => ({ section: s, items: sortItems(flatten([s]).filter(pass), sort) }))
        .filter((g) => g.items.length > 0);
    }
    return [
      {
        section: null,
        items: sortItems(flatten(data.sections).filter(pass), sort),
      },
    ];
  }, [data, q, sort, grouped, kind]);

  return (
    <div className="left-col">
      {groups.map((g, gi) => (
        <div key={g.section?.id ?? gi}>
          {g.section ? (
            <SectionHeading section={g.section} count={g.items.length} small />
          ) : (
            <div style={{ height: 18 }} />
          )}
          {g.items.map((it) => (
            <button
              key={it.key}
              className={'ccard' + (it.key === selected ? ' sel' : '')}
              onClick={() => onOpen(it.key)}
            >
              {/* グループ化オフのときは所属ラベルを出す(グリッドのカードと同じ体裁) */}
              {!g.section && (
                <span className="scope-mini">
                  <span className="dot5" style={{ background: SRC_COLOR[it.source] }} />
                  {it.scopeLabel}
                </span>
              )}
              <div className="r1">
                {g.section && (
                  <span className="dot7" style={{ background: SRC_COLOR[it.source] }} />
                )}
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

function OverviewTab({
  it,
  all,
  onOpen,
}: {
  it: FlatItem;
  all: FlatItem[];
  onOpen: (key: string) => void;
}) {
  // AI 分類(関係タイプ付き)があればそれを、無ければ静的解析の参照候補を表示
  const relations = it.aiRelations?.length
    ? it.aiRelations
    : (it.refs || []).map((name) => ({ name, type: 'references' as const, note: '' }));
  // 同一プロジェクト → user/plugin/built-in の順で解決(他プロジェクトの同名 skill は対象外)
  const resolve = (name: string) => {
    const hit = (pred: (x: FlatItem) => boolean) =>
      all.find((x) => pred(x) && (x.name === name || x.name.split(':').pop() === name));
    return hit((x) => x.secId === it.secId) || hit((x) => x.source !== 'project');
  };

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
      <SameNameSection it={it} all={all} onOpen={onOpen} />
      {it.typedCount || it.autoCount ? (
        <>
          <div className="sec-t">{t('detail.usageStats')}</div>
          <p className="full-desc">
            {t('detail.usageDetail', { typed: it.typedCount || 0, auto: it.autoCount || 0 })}
            {it.lastUsed ? t('detail.usageLast', { date: fmtDate(it.lastUsed) }) : ''}
          </p>
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

function MdTab({ path }: { path: string }) {
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
