import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  fetchSkills,
  fetchSummaryStatus,
  fromId,
  initToken,
  summarizeAll,
  toId,
  type SkillsData,
} from './api';
import {
  asViewMode,
  currentSection,
  fileName,
  flatten,
  migrateLegacyParams,
  resolveProject,
  type FlatItem,
  asKindFilter,
  asUseFilter,
  type MemorySortKey,
  type RefFilter,
  type SortKey,
} from './util';
import { asTypeFilter } from './memory';
import { GridView } from './components/GridView';
import { Home } from './components/Home';
import { MEM_SORT_KEYS, MemoryList } from './components/MemoryGrid';
import { DetailView, clearMdCache } from './components/DetailView';
import { ClaudeMdView } from './components/ClaudeMdView';
import { MemoryDetail } from './components/MemoryDetail';
import { ProjectSwitcher } from './components/ProjectSwitcher';
import { SettingsModal } from './components/SettingsModal';
import { getLang, setLang, t, type Lang } from './i18n';
import { defaultFile } from './claudemd';

/* ラベルは言語切替に追従させるため、キーだけ持ってレンダー時に t() で引く */
const SORT_KEYS: SortKey[] = ['name', 'uses', 'recent', 'updated', 'tokens'];

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
  /* memory 一覧の種類(frontmatter type)の絞り込み。未知の値は all */
  const memType = asTypeFilter(params.get('mtype'));
  const kind = asKindFilter(params.get('kind'));
  const use = asUseFilter(params.get('use'));
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
  /* CLAUDE.md 画面(E2)もパンくず(cwd のプロジェクト / CLAUDE.md)。② はサーバーが cwd で計算した値なので常に cwd */
  const claudeMdRoute = location.pathname.startsWith('/claude-md');
  const project = useMemo(
    () => (data ? resolveProject(projectParam, data.sections) : null),
    [data, projectParam],
  );
  /*
   * memory 一覧・詳細(Phase F)のパンくず: プロジェクト / memory(一覧へ) / 名前。
   * 一覧はヘッダーの切替(?project=)に従うプロジェクト単位、詳細はその memory が帰属するプロジェクト
   */
  const memoryRoute = location.pathname === '/memory' || location.pathname.startsWith('/memory/');
  const memoryId = location.pathname.match(/^\/memory\/([^/]+)/)?.[1];
  const memoryItem = memoryId
    ? (data?.memory || [])
        .flatMap((s) => s.items.map((it) => ({ sec: s, it })))
        .find((x) => x.it.path === fromId(memoryId))
    : undefined;
  const crumb = detailItem
    ? { project: detailItem.scopeLabel, name: detailItem.name }
    : claudeMdRoute && data
      ? {
          project: currentSection(data.sections)?.projectName || fileName(data.cwd),
          name: t('cmd.crumb'),
        }
      : memoryRoute && data
        ? {
            project: memoryItem
              ? memoryItem.sec.projectName
              : project === 'all'
                ? t('proj.all')
                : project?.projectName || fileName(data.cwd),
            /* 詳細では「memory」を一覧へのリンクにし、名前を末尾に置く(「← 一覧」の代わり) */
            name: memoryItem ? memoryItem.it.name : t('crumb.memory'),
            list: memoryItem ? t('crumb.memory') : '',
          }
        : null;
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
  /*
   * CLAUDE.md 画面(E2)。:id は toId(パス)。パスを渡せばその段(ホーム ① の変化行から)、
   * 省略すれば読まれる順で最初に存在する段。1 枚も無ければ /claude-md のまま
   */
  const openClaudeMd = (path?: string) => {
    const fp = path || (data ? defaultFile(data.claudeMd)?.path : undefined);
    navigate({ pathname: '/claude-md' + (fp ? '/' + toId(fp) : ''), search: params.toString() });
  };

  /* ---- AI summarize-all(ボタンはホーム ③ の見出し行。ジョブの状態はここで持つ) ---- */
  const [aiLabel, setAiLabel] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  /* 失敗はボタンの脇に 1 行で出す(alert は使わない) */
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

  const summary = {
    label: aiBusy ? aiLabel || t('ai.button') : idleAiLabel,
    busy: aiBusy,
    error: aiError,
    onRun: onAiClick,
  };

  if (error)
    return (
      <div className="wrap">
        <div className="empty">{t('app.loadFailed', { msg: error })}</div>
      </div>
    );

  return (
    <div className="app">
      {/* ヘッダーは「Skills Viewer / プロジェクト切替 / 設定」だけ(design-system 1.1) */}
      <header className="appbar">
        <h1>
          <Link to={{ pathname: '/', search: params.toString() }}>Skills Viewer</Link>
        </h1>
        {data && crumb ? (
          <span className="crumb">
            <Link className="crumb-p" to={{ pathname: '/', search: params.toString() }}>
              {crumb.project}
            </Link>
            <span className="meta">/</span>
            {crumb.list && (
              <>
                <Link className="crumb-p" to={{ pathname: '/memory', search: params.toString() }}>
                  {crumb.list}
                </Link>
                <span className="meta">/</span>
              </>
            )}
            <span className="crumb-cur">{crumb.name}</span>
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
        {data && !crumb && project === 'all' && (
          <span className="meta">
            {t('proj.allSub', {
              n: data.sections.filter((s) => s.source === 'project').length,
            })}
          </span>
        )}
        <span className="appbar-r">
          {/* AI 操作はヘッダーに置かない: 全件要約はホーム ③、再分類は用途別、棚卸しは memory 一覧(Phase F) */}
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
                    onOpenClaudeMd={openClaudeMd}
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
                    onOpenClaudeMd={openClaudeMd}
                    summary={summary}
                    setParam={setParam}
                    reload={reload}
                  />
                )
              }
            />
            {/* CLAUDE.md 画面(E2)。:id 無しは既定の段へ、1 枚も無ければ 7 段の「なし」だけ */}
            <Route path="/claude-md" element={<ClaudeMdView data={data} />} />
            <Route path="/claude-md/:id" element={<ClaudeMdView data={data} />} />
            <Route
              path="/skills/:id"
              element={<DetailView data={data} all={all} onOpen={openSkill} reload={reload} />}
            />
            {/* memory 一覧(Phase F。v0.8 の view=memory と独立した棚卸し画面の後継) */}
            <Route
              path="/memory"
              element={
                <MemoryList
                  data={data}
                  project={project}
                  q={q}
                  sort={memSort}
                  refFilter={refFilter}
                  type={memType}
                  setParam={setParam}
                  onOpen={openMemory}
                  reload={reload}
                />
              }
            />
            <Route path="/memory/:id" element={<MemoryDetail data={data} reload={reload} />} />
          </Routes>
        </main>
      )}
    </div>
  );
}
