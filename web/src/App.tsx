import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom';
import {
  fetchSkills,
  fetchSummaryStatus,
  generateGroups,
  initToken,
  summarizeAll,
  toId,
  type SkillsData,
} from './api';
import {
  flatten,
  kindMatches,
  matches,
  usageMatches,
  type FlatItem,
  type KindFilter,
  type SortKey,
  type UseFilter,
  type ViewMode,
} from './util';
import { GridView } from './components/GridView';
import { DetailView, clearMdCache } from './components/DetailView';
import { MemoryDetail } from './components/MemoryDetail';
import { MemoryTriageView } from './components/MemoryTriageView';
import { ChangesBanner } from './components/ChangesBanner';
import { SettingsModal } from './components/SettingsModal';
import { AiMenu } from './components/AiMenu';
import { getLang, setLang, t, type Lang, type MsgKey } from './i18n';

/* ラベルは言語切替に追従させるため、キーだけ持ってレンダー時に t() で引く */
const SORT_KEYS: [SortKey, MsgKey][] = [
  ['name', 'sort.name'],
  ['uses', 'sort.uses'],
  ['recent', 'sort.recent'],
  ['updated', 'sort.updated'],
  ['tokens', 'sort.tokens'],
];

const KIND_FILTERS: KindFilter[] = ['all', 'skill', 'command', 'agent', 'hook'];

const VIEW_MODES: [ViewMode, MsgKey][] = [
  ['source', 'view.source'],
  ['group', 'view.group'],
  ['flat', 'view.flat'],
];

export default function App() {
  const [data, setData] = useState<SkillsData | null>(null);
  const [error, setError] = useState('');
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const q = (params.get('q') || '').toLowerCase();
  const sort = (params.get('sort') || 'name') as SortKey;
  // v0.5.0 までの共有 URL(grouped=0)はフラット表示として解釈する
  const view = (params.get('view') ||
    (params.get('grouped') === '0' ? 'flat' : 'source')) as ViewMode;
  const kind = (params.get('kind') || 'all') as KindFilter;
  // v0.3.0 の共有 URL(unused=1)も unused 扱いで解釈する
  const use = (params.get('use') || (params.get('unused') === '1' ? 'unused' : 'all')) as UseFilter;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [width, setWidth] = useState(() => localStorage.getItem('csb-width') || 'full');
  const changeWidth = (w: string) => {
    setWidth(w);
    localStorage.setItem('csb-width', w);
  };
  const [lang, setLangState] = useState<Lang>(getLang());
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

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
  const shownCount = useMemo(
    () =>
      all.filter(
        (it) =>
          kindMatches(it, kind) && matches(it, q) && usageMatches(it, use, !!data?.usageAvailable),
      ).length,
    [all, q, kind, use, data],
  );

  /* 現在プロジェクトでの1セッションに注入される分(built-in + plugin + user + current project) */
  const sessionTokens = useMemo(() => {
    if (!data) return 0;
    return data.sections
      .filter((s) => s.source !== 'project' || s.isCurrent)
      .flatMap((s) => s.items)
      .reduce((sum, it) => sum + (it.tokens || 0), 0);
  }, [data]);

  const openSkill = (key: string) => {
    navigate({ pathname: '/skills/' + toId(key), search: params.toString() });
  };
  /* memory は同名の別定義が無いので、識別子はファイルパスだけで足りる */
  const openMemory = (path: string) => {
    navigate({ pathname: '/memory/' + toId(path), search: params.toString() });
  };
  /* 棚卸し診断はプロジェクト単位(id = MemorySection.id = エンコード済みディレクトリ名) */
  const openTriage = (id: string) => {
    navigate({ pathname: '/memory/triage/' + id, search: params.toString() });
  };

  /* ---- AI summarize-all ---- */
  const [aiLabel, setAiLabel] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
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
          alert(
            t('ai.finishedErrors', { n: st.errors.length }) +
              '\n' +
              st.errors.slice(0, 5).join('\n'),
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
    try {
      await summarizeAll(force);
      poll();
    } catch (e) {
      alert(t('ai.startFailed', { msg: e instanceof Error ? e.message : String(e) }));
    }
  };

  /* ---- AI menu(要約 + 用途グルーピングの集約) ---- */
  const [aiMenuOpen, setAiMenuOpen] = useState(false);
  const [groupBusy, setGroupBusy] = useState(false);
  const onGroupGen = async () => {
    if (groupBusy) return;
    setGroupBusy(true);
    try {
      await generateGroups();
      await reload();
    } catch (e) {
      alert(t('alert.groupFailed', { msg: e instanceof Error ? e.message : String(e) }));
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

  return (
    <div className={'wrap' + (width === 'fixed' ? ' fixed' : '')}>
      <div className="hd">
        <div className="t-row">
          <h1>
            <Link to={{ pathname: '/', search: params.toString() }}>Skills Viewer</Link>
          </h1>
          <span className="sub">{t('app.subtitle')}</span>
          <span className="count">
            {data ? t('app.count', { shown: shownCount, total: all.length }) : '…'}
          </span>
          {sessionTokens > 0 && (
            <span className="count tok-total" title={t('app.tokensTitle')}>
              {t('app.tokens', { n: sessionTokens.toLocaleString() })}
            </span>
          )}
        </div>
        <input
          className="q"
          placeholder={t('app.searchPlaceholder')}
          value={params.get('q') || ''}
          onChange={(e) => setParam('q', e.target.value || null)}
        />
        <div className="controls">
          <span className="seg" title={t('view.title')}>
            {VIEW_MODES.map(([key, msgKey]) => (
              <button
                key={key}
                className={view === key ? 'on' : ''}
                onClick={() => {
                  // 旧パラメータ(grouped=0)は新パラメータ設定時に掃除する
                  const next = new URLSearchParams(params);
                  next.delete('grouped');
                  if (key === 'source') next.delete('view');
                  else next.set('view', key);
                  setParams(next, { replace: true });
                }}
              >
                {t(msgKey)}
              </button>
            ))}
          </span>
          <select
            className="sel"
            value={sort}
            onChange={(e) => setParam('sort', e.target.value === 'name' ? null : e.target.value)}
            title={t('sort.title')}
          >
            {SORT_KEYS.map(([key, msgKey]) => (
              <option key={key} value={key}>
                {t(msgKey)}
              </option>
            ))}
          </select>
          {/* kind / 使用実績はボタン群だと場所を取るので、並び順と同じ select に統一 */}
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
          {data?.usageAvailable && (
            <select
              className={'sel' + (use !== 'all' ? ' on' : '')}
              value={use}
              title={t('filter.unusedTitle')}
              onChange={(e) => {
                // 旧パラメータ(unused=1)は新パラメータ設定時に掃除する
                const next = new URLSearchParams(params);
                next.delete('unused');
                if (e.target.value === 'all') next.delete('use');
                else next.set('use', e.target.value);
                setParams(next, { replace: true });
              }}
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
          <span className="controls-r">
            <span style={{ position: 'relative' }}>
              <button
                className="chip"
                onClick={() => setAiMenuOpen((v) => !v)}
                title={t('ai.menuTitle')}
              >
                {t('ai.menu')}
                {aiBusy || groupBusy
                  ? ' …'
                  : data && data.aiStale > 0
                    ? ` (${data.aiStale})`
                    : ''}{' '}
                ▾
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
            <button className="chip" onClick={() => setSettingsOpen(true)}>
              {t('app.settings')}
            </button>
          </span>
        </div>
      </div>
      {settingsOpen && (
        <SettingsModal
          width={width}
          onChangeWidth={changeWidth}
          lang={lang}
          onChangeLang={changeLang}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {data?.changes && <ChangesBanner changes={data.changes} onOpen={openSkill} reload={reload} />}
      {data && (
        <Routes>
          <Route
            path="/"
            element={
              <GridView
                data={data}
                q={q}
                sort={sort}
                view={view}
                kind={kind}
                use={use}
                onOpen={openSkill}
                onOpenMemory={openMemory}
                onOpenTriage={openTriage}
                reload={reload}
              />
            }
          />
          <Route
            path="/skills/:id"
            element={
              <DetailView
                data={data}
                all={all}
                q={q}
                sort={sort}
                view={view}
                kind={kind}
                use={use}
                onOpen={openSkill}
                reload={reload}
              />
            }
          />
          {/* 棚卸し診断はプロジェクト単位の独立画面。:id より前に置いて誤マッチを避ける */}
          <Route
            path="/memory/triage/:project"
            element={<MemoryTriageView data={data} reload={reload} />}
          />
          <Route path="/memory/:id" element={<MemoryDetail data={data} reload={reload} />} />
        </Routes>
      )}
    </div>
  );
}
