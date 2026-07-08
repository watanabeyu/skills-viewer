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
  type FlatItem,
  type KindFilter,
  type SortKey,
} from './util';
import { GridView } from './components/GridView';
import { DetailView } from './components/DetailView';
import { SettingsModal } from './components/SettingsModal';

const SORT_LABELS: [SortKey, string][] = [
  ['name', '名前順'],
  ['uses', '使用回数順'],
  ['recent', '最近使った順'],
  ['updated', '更新日順'],
];

const KIND_FILTERS: [KindFilter, string][] = [
  ['all', 'すべて'],
  ['skill', 'skill'],
  ['command', 'command'],
  ['agent', 'agent'],
  ['hook', 'hook'],
];

export default function App() {
  const [data, setData] = useState<SkillsData | null>(null);
  const [error, setError] = useState('');
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const q = (params.get('q') || '').toLowerCase();
  const sort = (params.get('sort') || 'name') as SortKey;
  const grouped = params.get('grouped') !== '0';
  const kind = (params.get('kind') || 'all') as KindFilter;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [width, setWidth] = useState(() => localStorage.getItem('csb-width') || 'full');
  const changeWidth = (w: string) => {
    setWidth(w);
    localStorage.setItem('csb-width', w);
  };

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const reload = useCallback(async () => {
    setData(await fetchSkills());
  }, []);

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
    () => all.filter((it) => kindMatches(it, kind) && matches(it, q)).length,
    [all, q, kind],
  );

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
        setAiLabel(`要約中 ${st.done}/${st.total}`);
        pollTimer.current = window.setTimeout(poll, 1500);
        return;
      }
      if (st.total > 0) {
        if (st.errors.length) {
          alert(`要約完了(エラー ${st.errors.length}件):\n` + st.errors.slice(0, 5).join('\n'));
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

  useEffect(() => {
    if (!aiBusy && data) {
      setAiLabel(data.aiStale > 0 ? `AI要約 (未生成 ${data.aiStale})` : 'AI要約 ✓');
    }
  }, [data, aiBusy]);

  const onAiClick = async () => {
    if (!data || aiBusy) return;
    const force = data.aiStale === 0;
    if (force) {
      const total = all.filter((x) => x.path.startsWith('/') && x.kind !== 'hook').length;
      if (
        !confirm(
          `全 skill の要約は最新です。全 ${total} 件を強制再生成しますか?(claude CLI / haiku)`,
        )
      )
        return;
    } else if (
      !confirm(`${data.aiStale} 件の SKILL.md を claude CLI (haiku) で要約します。よろしいですか?`)
    ) {
      return;
    }
    try {
      await summarizeAll(force);
      poll();
    } catch (e) {
      alert('開始に失敗: ' + (e instanceof Error ? e.message : e));
    }
  };

  if (error)
    return (
      <div className="wrap">
        <div className="empty">読み込みに失敗しました: {error}</div>
      </div>
    );

  return (
    <div className={'wrap' + (width === 'fixed' ? ' fixed' : '')}>
      <div className="hd">
        <div className="t-row">
          <h1>
            <Link to={{ pathname: '/', search: params.toString() }}>Skills Viewer</Link>
          </h1>
          <span className="sub">skills · commands · agents · hooks — このPCにインストール済み</span>
          <span className="count">{data ? `${shownCount} / ${all.length} 件` : '…'}</span>
        </div>
        <input
          className="q"
          placeholder="スキル名や説明で検索…"
          value={params.get('q') || ''}
          onChange={(e) => setParam('q', e.target.value || null)}
        />
        <div className="controls">
          <select
            className="sel"
            value={sort}
            onChange={(e) => setParam('sort', e.target.value === 'name' ? null : e.target.value)}
            title="並び順"
          >
            {SORT_LABELS.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <span className="seg">
            {KIND_FILTERS.map(([key, label]) => (
              <button
                key={key}
                className={kind === key ? 'on' : ''}
                onClick={() => setParam('kind', key === 'all' ? null : key)}
              >
                {label}
              </button>
            ))}
          </span>
          <button
            className="chip"
            disabled={aiBusy}
            onClick={onAiClick}
            title="claude CLI (haiku) で各 SKILL.md を要約。内容が変わったものだけ再生成"
          >
            {aiLabel || 'AI要約'}
          </button>
          <label className="grp-label">
            <input
              type="checkbox"
              checked={grouped}
              onChange={(e) => setParam('grouped', e.target.checked ? null : '0')}
            />
            <span>グループ化</span>
          </label>
          <button className="chip" onClick={() => setSettingsOpen(true)}>
            設定
          </button>
        </div>
      </div>
      {settingsOpen && (
        <SettingsModal
          width={width}
          onChangeWidth={changeWidth}
          onClose={() => setSettingsOpen(false)}
        />
      )}
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
