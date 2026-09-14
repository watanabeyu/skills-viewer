import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  flatten,
  latestGate,
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
import { InlineError } from './components/Inline';
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
  /* トークン取得の失敗(取得エラーとは別。ensureToken の注記を参照。表示はヘッダーの 1 行) */
  const [tokenError, setTokenError] = useState('');
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

  /*
   * 取得の世代(util の latestGate)。切替を連続で押すと応答が前後し得るので、直近の要求でない
   * 応答は捨てる。要求した id と応答の selected.id の比較にはしない ── 未知の id をサーバーが
   * cwd に落とした正当な応答まで「不一致」で捨ててしまう(計画 16 Phase B)。
   * 失敗も同じ世代で見る: A → B と切り替えて A だけ失敗したとき、B の正しいデータが入っているのに
   * エラー画面へ固定されないように(成功したら前のエラーは消す)。
   * 保持は useRef で行う ── useMemo はキャッシュの破棄が許され、作り直されると世代が 0 に戻る。
   */
  const gate = useRef(latestGate()).current;

  /*
   * トークンの取得(mutation にしか要らない。GET /api/skills には不要)。
   * 失敗は取得エラーとは別に持つ: 同じ state に入れると /api/skills 成功時の setError('') が
   * 消してしまい、以後の mutation が 403 で落ちても理由が画面のどこにも残らない。
   * 一過性の失敗から抜ける道も要る ── 全画面には落とさず(閲覧は読み取りだけで成り立つ)、
   * 取得が成功するたびに黙って取り直す(レビュー 3 周目)。
   * 取り直しの要否は state ではなく ref で見る: tokenError を load の依存に入れると、
   * 失敗のたびに load の identity が変わって取得の effect が再走し、/api/skills を取り直す。
   */
  const tokenMissing = useRef(true);
  const ensureToken = useCallback(async () => {
    if (!tokenMissing.current) return;
    try {
      await initToken();
      tokenMissing.current = false;
      setTokenError('');
    } catch (e) {
      setTokenError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  /*
   * silent = 失敗を全画面のエラーにしない再取得。エラー画面はヘッダーも切替も持たないので、
   * poll や操作(要約・棚卸しの後の取り直し)の失敗までそこへ固定すると、ブラウザの再読み込み
   * 以外に戻る道が無くなる。全画面へ落としてよいのは初回取得と切替だけ(レビュー 2 周目)。
   * 成功はどちらでも前のエラーを消す(次の取得で復帰できるように)。
   * silent は代わりに呼び出し側へ再 throw する ── 握りつぶすと「操作は成功・再取得だけ失敗」の
   * とき、既読・棚卸し・要約の catch(局所表示)が発火せず、画面が古いまま何も言わない
   * ことになる(レビュー 3 周目)。捨てるのは直近の要求でなくなった失敗だけで、
   * それは後の取得が画面を持っているので局所表示にも出さない。
   */
  const load = useCallback(
    async (silent: boolean) => {
      clearMdCache();
      const isLatest = gate();
      try {
        const next = await fetchSkills(projectParam);
        if (!isLatest()) return;
        setData(next);
        setError('');
        /* サーバーと話せたので、残っているトークン取得の失敗はここで取り直す */
        void ensureToken();
      } catch (e) {
        if (!isLatest()) return;
        if (silent) throw e;
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [ensureToken, gate, projectParam],
  );
  /*
   * 子(ホーム・一覧・詳細)へ渡す再取得は操作起点なので silent。全画面には落とさないが、
   * 返す Promise は reject しうる ── 失敗はその場の局所表示(呼び出し側の catch)に任せる
   */
  const reload = useCallback(() => load(true), [load]);

  /*
   * poll(要約ジョブ)から呼ぶ再取得。reload そのものを依存にすると ?project= を変えるたびに
   * ポーリングが張り直され、しかもジョブ実行中の切替では古い poll が旧 projectParam を
   * 閉じ込めた reload を後から実行して画面が前のプロジェクトへ戻る。identity を切り離す。
   */
  const reloadRef = useRef(reload);
  /*
   * 代入は layout effect で行う: passive effect の flush 前にポーリングの timeout が発火すると、
   * ref がまだ前の reload(= 前の projectParam)のままになる
   */
  useLayoutEffect(() => {
    reloadRef.current = reload;
  }, [reload]);

  /* 言語切替: 全体が再レンダーされ、builtin 説明・AI要約の言語も変わるので再取得する */
  const changeLang = (l: Lang) => {
    if (l === lang) return;
    setLang(l);
    setLangState(l);
    /*
     * reload は失敗を投げる(局所表示のため)。言語切替には受け皿となる表示が無いので
     * ここで握る ── 表示言語は既に切り替わっており、次の操作・再読み込みで取り直せる
     */
    void reload().catch(() => {});
  };

  /* トークンは初回に取る(以後は取得の成功時に、失敗が残っていれば取り直す) */
  useEffect(() => {
    void ensureToken();
  }, [ensureToken]);

  /*
   * 取得は ?project= が変わるたびにやり直す(切替 = /api/skills を取り直す。計画 16 Phase B)。
   * ② だけ返す別エンドポイントは作らない: payload の形を 1 つに保ち、2 つの応答を
   * 突き合わせずに済ませる。前例は言語切替(changeLang → reload)
   */
  useEffect(() => {
    void load(false);
  }, [load]);

  const all: FlatItem[] = useMemo(() => (data ? flatten(data.sections) : []), [data]);
  /* 理解画面ではプロジェクト切替の位置がパンくず(プロジェクト / 名前)になる(design-system 1.1) */
  const detailId = location.pathname.match(/^\/skills\/([^/]+)/)?.[1];
  const detailItem = detailId ? all.find((x) => x.key === fromId(detailId)) : undefined;
  /* CLAUDE.md 画面(E2)もパンくず(プロジェクト / CLAUDE.md)。段はサーバーが選んだプロジェクトで計算する */
  const claudeMdRoute = location.pathname.startsWith('/claude-md');
  /*
   * 選択はサーバーが計算した対象(data.selected)に従う。未知の id はサーバーが cwd に落とすが、
   * URL は書き換えない ── 共有 URL をこちらで壊さず、表示だけ応答に合わせる(計画 16 判断 3)
   */
  const project = useMemo(
    () => (data ? resolveProject(projectParam, data) : null),
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
          /* 選んだプロジェクト(サーバーが計算した対象)の名前。0 件で Section が無くても付く */
          project: data.selected.name,
          name: t('cmd.crumb'),
        }
      : memoryRoute && data
        ? {
            project: memoryItem
              ? memoryItem.sec.projectName
              : project === 'all'
                ? t('proj.all')
                : data.selected.name,
            /* 詳細では「memory」を一覧へのリンクにし、名前を末尾に置く(「← 一覧」の代わり) */
            name: memoryItem ? memoryItem.it.name : t('crumb.memory'),
            list: memoryItem ? t('crumb.memory') : '',
          }
        : null;
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

  /*
   * ポーリングの世代。チェーンは 1 本だけ生かす: cleanup 後や再開後に戻ってきた古い応答が
   * timeout を張り直す(= 止まらないチェーンが増える)のを止める。取得の世代とは別に持つ。
   */
  const pollGate = useRef(latestGate()).current;
  const poll = useCallback(async () => {
    const isLatest = pollGate();
    try {
      const st = await fetchSummaryStatus();
      if (!isLatest()) return;
      if (!st.finished) {
        setAiBusy(true);
        setAiLabel(t('ai.progress', { done: st.done, total: st.total }));
        // 予約済みの 1 回にも世代を効かせる(cleanup 後や再開後に発火してもチェーンを継がない)
        pollTimer.current = window.setTimeout(() => {
          if (isLatest()) void poll();
        }, 1500);
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
        /* 再取得は常に最新の ?project= で行う(ジョブ中に切り替えても前のプロジェクトへ戻さない) */
        await reloadRef.current();
      }
    } catch {
      /*
       * サーバー停止など。次の操作で復帰。再取得(reloadRef)の失敗もここで握る ──
       * ポーリングは操作起点ではないので、表示を出す場所が無い
       */
    }
    if (!isLatest()) return;
    setAiBusy(false);
  }, [pollGate]);

  useEffect(() => {
    void poll();
    return () => {
      window.clearTimeout(pollTimer.current);
      // 進行中のチェーンを世代ごと無効化する(戻ってきても timeout を張らない)
      pollGate();
    };
  }, [poll, pollGate]);

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
      void poll();
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

  /*
   * ?project= の切替。ヘッダーの切替(本体)とホーム上部の worktree の select が同じ経路を通る
   * ── 選択の書き込み方(null = cwd は URL に書かない・'all' 以外は by を落とす)を 2 か所に
   * 書かないため(計画 16 Phase C の改訂)。
   */
  const selectProject = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id === null) next.delete('project');
    else next.set('project', id);
    if (id !== 'all') next.delete('by');
    navigate({ pathname: '/', search: next.toString() });
  };

  /*
   * 全画面に落とすのは初回取得・切替の失敗だけ。トークン取得の失敗は含めない ── 読み取りには
   * 要らないので、閲覧まで止めてブラウザの再読み込みしか復帰手段が無い状態にしない
   * (ヘッダーの 1 行で知らせる。レビュー 3 周目)
   */
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
          data && <ProjectSwitcher data={data} project={project} onSelect={selectProject} />
        )}
        {data && !crumb && project === 'all' && (
          <span className="meta">
            {t('proj.allSub', {
              n: data.sections.filter((s) => s.source === 'project').length,
            })}
          </span>
        )}
        <span className="appbar-r">
          {/*
            トークン取得の失敗は閲覧を止めないので、設定の隣に 1 行だけ添える
            (取得が成功すれば取り直して消える。全画面には落とさない)
          */}
          <InlineError msg={tokenError ? t('app.tokenFailed', { msg: tokenError }) : ''} />
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
                    onSelectProject={selectProject}
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
