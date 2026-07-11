import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom';
import {
  fetchSkills,
  fetchSummaryStatus,
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
} from './util';
import { GridView } from './components/GridView';
import { DetailView, clearMdCache } from './components/DetailView';
import { ChangesBanner } from './components/ChangesBanner';
import { SettingsModal } from './components/SettingsModal';
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

export default function App() {
  const [data, setData] = useState<SkillsData | null>(null);
  const [error, setError] = useState('');
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const q = (params.get('q') || '').toLowerCase();
  const sort = (params.get('sort') || 'name') as SortKey;
  const grouped = params.get('grouped') !== '0';
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
          <span className="seg">
            {KIND_FILTERS.map((key) => (
              <button
                key={key}
                className={kind === key ? 'on' : ''}
                onClick={() => setParam('kind', key === 'all' ? null : key)}
              >
                {key === 'all' ? t('kind.all') : key}
              </button>
            ))}
          </span>
          {data?.usageAvailable && (
            <span className="seg">
              {(
                [
                  ['all', t('kind.all'), ''],
                  ['used', t('filter.used'), t('filter.usedTitle')],
                  ['unused', t('filter.unused'), t('filter.unusedTitle')],
                ] as [UseFilter, string, string][]
              ).map(([key, label, title]) => (
                <button
                  key={key}
                  className={use === key ? 'on' : ''}
                  title={title}
                  onClick={() => {
                    // 旧パラメータ(unused=1)は新パラメータ設定時に掃除する
                    const next = new URLSearchParams(params);
                    next.delete('unused');
                    if (key === 'all') next.delete('use');
                    else next.set('use', key);
                    setParams(next, { replace: true });
                  }}
                >
                  {label}
                </button>
              ))}
            </span>
          )}
          <button
            className="chip"
            disabled={aiBusy}
            onClick={onAiClick}
            title={t('ai.buttonTitle')}
          >
            {aiBusy ? aiLabel || t('ai.button') : idleAiLabel}
          </button>
          <label className="grp-label">
            <input
              type="checkbox"
              checked={grouped}
              onChange={(e) => setParam('grouped', e.target.checked ? null : '0')}
            />
            <span>{t('app.grouped')}</span>
          </label>
          <button className="chip" onClick={() => setSettingsOpen(true)}>
            {t('app.settings')}
          </button>
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
                grouped={grouped}
                kind={kind}
                use={use}
                onOpen={openSkill}
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
                grouped={grouped}
                kind={kind}
                use={use}
                onOpen={openSkill}
                reload={reload}
              />
            }
          />
        </Routes>
      )}
    </div>
  );
}
