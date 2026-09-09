import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  fetchSkills,
  fetchSummaryStatus,
  fromId,
  generateGroups,
  initToken,
  summarizeAll,
  toId,
  type SkillsData,
} from './api';
import {
  asViewMode,
  flatten,
  migrateLegacyParams,
  resolveProject,
  type FlatItem,
  type KindFilter,
  type MemorySortKey,
  type RefFilter,
  type SortKey,
  type UseFilter,
} from './util';
import { GridView } from './components/GridView';
import { Home } from './components/Home';
import { MemoryGrid } from './components/MemoryGrid';
import { DetailView, clearMdCache } from './components/DetailView';
import { MemoryDetail } from './components/MemoryDetail';
import { MemoryTriageView } from './components/MemoryTriageView';
import { ProjectSwitcher } from './components/ProjectSwitcher';
import { SettingsModal } from './components/SettingsModal';
import { AiMenu } from './components/AiMenu';
import { InlineError, InlineNote } from './components/Inline';
import { getLang, setLang, t, type Lang, type MsgKey } from './i18n';

/* ラベルは言語切替に追従させるため、キーだけ持ってレンダー時に t() で引く */
const SORT_KEYS: SortKey[] = ['name', 'uses', 'recent', 'updated', 'tokens'];

/*
 * memory 軸の並び順。URL パラメータは skill 軸の sort と分けて msort に置く
 * (updated は skill = 新しい順 / memory = 古い順で意味が逆、値の集合も違うため)。
 */
const MEM_SORT_KEYS: [MemorySortKey, MsgKey][] = [
  ['index', 'sort.memIndex'],
  ['body', 'sort.memBody'],
  ['updated', 'sort.memStale'],
  ['name', 'sort.name'],
];

export default function App() {
  const [data, setData] = useState<SkillsData | null>(null);
  const [error, setError] = useState('');
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();

  const q = (params.get('q') || '').toLowerCase();
  // 未知の値(他軸の並び順が混ざった共有 URL 等)は select の空欄を避けるため既定に落とす
  const sortParam = params.get('sort');
  const sort: SortKey = SORT_KEYS.includes(sortParam as SortKey) ? (sortParam as SortKey) : 'name';
  const msortParam = params.get('msort');
  const memSort: MemorySortKey = MEM_SORT_KEYS.some(([k]) => k === msortParam)
    ? (msortParam as MemorySortKey)
    : 'index';
  const refParam = params.get('ref');
  // URL パラメータ名は ref のまま。変数・prop 名だけ React の予約 prop 名を避ける
  const refFilter: RefFilter = refParam === 'read' || refParam === 'unread' ? refParam : 'all';
  const kind = (params.get('kind') || 'all') as KindFilter;
  const use = (params.get('use') || 'all') as UseFilter;
  /* ?project=<Section.id | all>。省略時は cwd のプロジェクト(設計判断 13) */
  const projectParam = params.get('project');
  /* 「すべてのプロジェクト」の並び(出所別 / 用途別 / 1 列)。v0.8 の view の後継 */
  const by = asViewMode(params.get('by'));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [lang, setLangState] = useState<Lang>(getLang());
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  /*
   * v0.8 までの共有 URL(view / grouped / unused)は読み取って新クエリへ写し替え、旧キーは消す。
   * view=memory はホームの軸ではなく /memory の別画面になったので遷移で受ける。
   */
  useEffect(() => {
    const m = migrateLegacyParams(params);
    if (!m) return;
    if (m.memory && location.pathname === '/')
      navigate({ pathname: '/memory', search: m.params.toString() }, { replace: true });
    else setParams(m.params, { replace: true });
  }, [params, setParams, navigate, location.pathname]);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const reload = useCallback(async () => {
    clearMdCache();
    setData(await fetchSkills());
  }, []);

  /* 言語切替: 全体が再レンダーされ、builtin 説明・AI要約の言語も変わるので再取得する */
  const changeLang = (l: Lang) => {
    if (l === lang) return;
    setLang(l);
    setLangState(l);
    reload().catch(() => {});
  };

  useEffect(() => {
    (async () => {
      try {
        await initToken();
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [reload]);

  const all: FlatItem[] = useMemo(() => (data ? flatten(data.sections) : []), [data]);
  /* 理解画面ではプロジェクト切替の位置がパンくず(プロジェクト / 名前)になる(design-system 1.1) */
  const detailId = location.pathname.match(/^\/skills\/([^/]+)/)?.[1];
  const detailItem = detailId ? all.find((x) => x.key === fromId(detailId)) : undefined;
  const project = useMemo(
    () => (data ? resolveProject(projectParam, data.sections) : null),
    [data, projectParam],
  );
  /* 未知の id(登録から消えた・アイテム 0 件になったプロジェクト)は cwd に落とし、URL からも消す */
  useEffect(() => {
    if (!data || !projectParam || projectParam === 'all') return;
    if (project === 'all' || project?.id === projectParam) return;
    setParam('project', null);
    // setParam は params から都度作る関数なので依存に入れない(入れると毎レンダー再登録される)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, projectParam, project]);

  const openSkill = (key: string) => {
    navigate({ pathname: '/skills/' + toId(key), search: params.toString() });
  };
  /* memory は同名の別定義が無いので、識別子はファイルパスだけで足りる */
  const openMemory = (path: string) => {
    navigate({ pathname: '/memory/' + toId(path), search: params.toString() });
  };
  const openMemoryList = () => {
    navigate({ pathname: '/memory', search: params.toString() });
  };
  /* 棚卸し診断はプロジェクト単位(id = MemorySection.id = エンコード済みディレクトリ名) */
  const openTriage = (id: string) => {
    navigate({ pathname: '/memory/triage/' + id, search: params.toString() });
  };

  /* ---- AI summarize-all ---- */
  const [aiLabel, setAiLabel] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  /* AI 操作(要約・グルーピング)の失敗はヘッダーの AI ボタン脇に 1 行で出す(alert は使わない) */
  const [aiError, setAiError] = useState('');
  const pollTimer = useRef<number>(0);

  const poll = useCallback(async () => {
    try {
      const st = await fetchSummaryStatus();
      if (!st.finished) {
        setAiBusy(true);
        setAiLabel(t('ai.progress', { done: st.done, total: st.total }));
        pollTimer.current = window.setTimeout(poll, 1500);
        return;
      }
      if (st.total > 0) {
        if (st.errors.length) {
          setAiError(
            t('ai.finishedErrors', {
              n: st.errors.length,
              list: st.errors.slice(0, 3).join(' / '),
            }),
          );
        }
        await reload();
      }
    } catch {
      /* サーバー停止など。次の操作で復帰 */
    }
    setAiBusy(false);
  }, [reload]);

  useEffect(() => {
    poll();
    return () => window.clearTimeout(pollTimer.current);
  }, [poll]);

  /* 非ポーリング時のラベルはレンダー時に計算する(言語切替にも追従) */
  const idleAiLabel = !data
    ? t('ai.button')
    : data.aiStale > 0
      ? t('ai.stale', { n: data.aiStale })
      : t('ai.done');

  const onAiClick = async () => {
    if (!data || aiBusy) return;
    const force = data.aiStale === 0;
    if (force) {
      const total = all.filter((x) => x.path && x.kind !== 'hook').length;
      if (!confirm(t('ai.confirmForce', { n: total }))) return;
    } else if (!confirm(t('ai.confirmRun', { n: data.aiStale }))) {
      return;
    }
    setAiError('');
    try {
      await summarizeAll(force);
      poll();
    } catch (e) {
      setAiError(t('ai.startFailed', { msg: e instanceof Error ? e.message : String(e) }));
    }
  };

  /* ---- AI menu(要約 + 用途グルーピングの集約) ---- */
  const [aiMenuOpen, setAiMenuOpen] = useState(false);
  const [groupBusy, setGroupBusy] = useState(false);
  const onGroupGen = async () => {
    if (groupBusy) return;
    setGroupBusy(true);
    setAiError('');
    try {
      await generateGroups();
      await reload();
    } catch (e) {
      setAiError(t('alert.groupFailed', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setGroupBusy(false);
    }
  };

  if (error)
    return (
      <div className="wrap">
        <div className="empty">{t('app.loadFailed', { msg: error })}</div>
      </div>
    );

  /* memory 一覧のツールバー(検索 / 並び / 参照)。v0.8 のヘッダーにあったものを /memory へ移した。Phase F で組み替える */
  const memory = data?.memory || [];
  const refAvailable = memory.some((s) => s.usageAvailable);
  const memoryToolbar = (
    <div className="mem-tools">
      <h2>{t('memory.listTitle')}</h2>
      <input
        className="q"
        placeholder={t('memory.searchPlaceholder')}
        value={params.get('q') || ''}
        onChange={(e) => setParam('q', e.target.value || null)}
      />
      <select
        className="sel"
        value={memSort}
        onChange={(e) => setParam('msort', e.target.value === 'index' ? null : e.target.value)}
        title={t('sort.title')}
      >
        {MEM_SORT_KEYS.map(([key, msgKey]) => (
          <option key={key} value={key}>
            {t(msgKey)}
          </option>
        ))}
      </select>
      {refAvailable && (
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
    </div>
  );

  return (
    <div className="app">
      {/* ヘッダーは「Skills Viewer / プロジェクト切替 / 設定」だけ(design-system 1.1) */}
      <header className="appbar">
        <h1>
          <Link to={{ pathname: '/', search: params.toString() }}>Skills Viewer</Link>
        </h1>
        {data && detailItem ? (
          <span className="crumb">
            <Link className="crumb-p" to={{ pathname: '/', search: params.toString() }}>
              {detailItem.scopeLabel}
            </Link>
            <span className="meta">/</span>
            <span className="crumb-cur">{detailItem.name}</span>
          </span>
        ) : (
          data && (
            <ProjectSwitcher
              data={data}
              project={project}
              onSelect={(id) => {
                const next = new URLSearchParams(params);
                if (id === null) next.delete('project');
                else next.set('project', id);
                if (id !== 'all') next.delete('by');
                navigate({ pathname: '/', search: next.toString() });
              }}
            />
          )
        )}
        {data && !detailItem && project === 'all' && (
          <span className="meta">
            {t('proj.allSub', {
              n: data.sections.filter((s) => s.source === 'project').length,
            })}
          </span>
        )}
        <span className="appbar-r">
          {/* claude CLI 不在は起動時に 1 回だけ検出する。押せない理由をボタン脇に出す */}
          {data && !data.aiAvailable && <InlineNote msg={t('ai.unavailable')} />}
          <InlineError msg={aiError} />
          <span style={{ position: 'relative' }}>
            <button
              className="btn"
              disabled={!!data && !data.aiAvailable}
              onClick={() => setAiMenuOpen((v) => !v)}
              title={t('ai.menuTitle')}
            >
              {t('ai.menu')}
              {aiBusy || groupBusy ? ' …' : data && data.aiStale > 0 ? ` (${data.aiStale})` : ''} ▾
            </button>
            {aiMenuOpen && (
              <AiMenu
                summaryLabel={aiBusy ? aiLabel || t('ai.button') : idleAiLabel}
                summaryBusy={aiBusy}
                onSummarize={onAiClick}
                groupLabel={data?.groups?.length ? t('group.menuRegen') : t('group.menuGenerate')}
                groupBusy={groupBusy}
                groupStale={!!data?.groupsStale}
                onGroups={onGroupGen}
                memoryCurrentId={data?.memory?.find((s) => s.isCurrent)?.id}
                onTriage={openTriage}
                onClose={() => setAiMenuOpen(false)}
              />
            )}
          </span>
          <button className="btn quiet" onClick={() => setSettingsOpen(true)}>
            {t('app.settings')}
          </button>
        </span>
      </header>
      {settingsOpen && (
        <SettingsModal
          lang={lang}
          onChangeLang={changeLang}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {data && (
        <main className="wrap">
          <Routes>
            <Route
              path="/"
              element={
                project === 'all' ? (
                  <GridView
                    data={data}
                    q={q}
                    sort={sort}
                    by={by}
                    kind={kind}
                    use={use}
                    onOpen={openSkill}
                    onOpenMemory={openMemory}
                    setParam={setParam}
                    reload={reload}
                  />
                ) : (
                  <Home
                    data={data}
                    project={project}
                    q={q}
                    sort={sort}
                    kind={kind}
                    use={use}
                    onOpen={openSkill}
                    onOpenMemory={openMemory}
                    onOpenMemoryList={openMemoryList}
                    setParam={setParam}
                    reload={reload}
                  />
                )
              }
            />
            <Route
              path="/skills/:id"
              element={<DetailView data={data} all={all} onOpen={openSkill} reload={reload} />}
            />
            {/* memory 一覧(Phase F で組み替える。v0.8 の view=memory の後継) */}
            <Route
              path="/memory"
              element={
                <>
                  {memoryToolbar}
                  <MemoryGrid
                    data={data}
                    q={q}
                    sort={memSort}
                    refFilter={refFilter}
                    onOpen={openMemory}
                    onOpenTriage={openTriage}
                  />
                </>
              }
            />
            {/* 棚卸し診断はプロジェクト単位の独立画面。:id より前に置いて誤マッチを避ける */}
            <Route
              path="/memory/triage/:project"
              element={<MemoryTriageView data={data} reload={reload} />}
            />
            <Route
              path="/memory/:id"
              element={
                <MemoryDetail
                  data={data}
                  q={q}
                  sort={memSort}
                  refFilter={refFilter}
                  reload={reload}
                />
              }
            />
          </Routes>
        </main>
      )}
    </div>
  );
}
