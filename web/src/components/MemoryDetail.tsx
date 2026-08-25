import { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  fetchFile,
  fromId,
  openSkill,
  toId,
  type MemorySection,
  type SkillItem,
  type SkillsData,
} from '../api';
import {
  backlinksOf,
  fmtMD,
  matches,
  memoryListSearch,
  memoryResolver,
  refMatches,
  sortMemory,
  type MemorySortKey,
  type RefFilter,
} from '../util';
import { editorUrl, loadEditorSetting } from '../settings';
import { esc, mdRender, splitFrontmatter } from '../md';
import { t } from '../i18n';
import { KindBadge } from './GridView';
import { MemoryHeading, MemoryTypeBadge, TokFacts, UnreadBadge, readsTitle } from './MemoryBits';
import { MemoryTriageBox, runTriageOne } from './MemoryTriageView';

/*
 * [[x]] を md レンダリング前に置き換える。レンダラは全テキストをエスケープするので、
 * 一旦プレースホルダ(私用領域の文字 + 連番)に退避し、レンダリング後に HTML へ差し戻す。
 */
export function renderMemoryBody(
  body: string,
  resolve: (name: string) => SkillItem | undefined,
): string {
  const holes: string[] = [];
  const src = body.replace(/\[\[([^\][]+)\]\]/g, (_m, raw: string) => {
    const name = raw.trim();
    const target = resolve(name);
    holes.push(
      target
        ? `<a class="mem-link" href="/memory/${toId(target.path)}" data-mem="${toId(
            target.path,
          )}">${esc(name)}</a>`
        : `<span class="mem-link broken" title="${esc(t('memory.linkBrokenTitle'))}">[[${esc(
            name,
          )}]]</span>`,
    );
    return `\uE000${holes.length - 1}\uE000`;
  });
  return mdRender(src).replace(/\uE000(\d+)\uE000/g, (_m, i: string) => holes[Number(i)]);
}

/* memory 詳細(/memory/:id)。skill 詳細と同じ 2 カラム(左: 同プロジェクトの一覧 / 右: pane) */
export function MemoryDetail({
  data,
  q,
  sort,
  // ref は React の予約 prop 名(memo / forwardRef で剥がされる)なので prop 名は refFilter
  refFilter,
  reload,
}: {
  data: SkillsData;
  q: string;
  sort: MemorySortKey;
  refFilter: RefFilter;
  reload: () => Promise<void>;
}) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const target = fromId(id || '');
  const sections: MemorySection[] = data.memory || [];
  const sec = sections.find((s) => s.items.some((x) => x.path === target));
  const it = sec?.items.find((x) => x.path === target);

  const path = it?.path || '';
  const [raw, setRaw] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [triageBusy, setTriageBusy] = useState(false);

  useEffect(() => {
    if (!path) return;
    let alive = true;
    setRaw(null);
    setError('');
    fetchFile(path)
      .then((content) => {
        if (alive) setRaw(content);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [path]);

  /* 同一セクション内で name またはファイル名が一致するメモリに解決する */
  const resolve = useMemo(() => memoryResolver(sec?.items || []), [sec]);

  const html = useMemo(
    () => (raw === null ? '' : renderMemoryBody(splitFrontmatter(raw).body, resolve)),
    [raw, resolve],
  );

  // 存在しない id は memory 一覧へ戻す(skill 詳細と同じ挙動)
  const listSearch = memoryListSearch(params);
  if (!sec || !it) return <Navigate to={{ pathname: '/', search: listSearch }} replace />;

  const tab = params.get('tab') === 'body' ? 'body' : 'overview';
  const setTab = (name: 'overview' | 'body') => {
    const next = new URLSearchParams(params);
    if (name === 'body') next.set('tab', 'body');
    else next.delete('tab');
    navigate({ pathname: '/memory/' + toId(it.path), search: next.toString() }, { replace: true });
  };
  const openMemory = (p: string) =>
    navigate({ pathname: '/memory/' + toId(p), search: params.toString() });

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
  const onTriage = async () => {
    setTriageBusy(true);
    try {
      await runTriageOne(sec, it);
      await reload();
      // 結果は概要タブの棚卸しブロックに出るので、本文タブにいたら概要へ切り替える
      if (tab !== 'overview') setTab('overview');
    } catch (e) {
      alert(t('alert.triageFailed', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setTriageBusy(false);
    }
  };

  /* 本文中のリンクは HTML なので、クリックを拾って SPA 遷移にする(フルリロード回避) */
  const onBodyClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    const a = (e.target as HTMLElement).closest('a[data-mem]');
    if (!a) return;
    e.preventDefault();
    navigate({ pathname: '/memory/' + a.getAttribute('data-mem'), search: params.toString() });
  };

  // 左カラムは一覧と同じ検索・参照フィルタ・並び順を映す(skill 詳細の LeftColumn と同じ流儀)
  const listItems = sortMemory(
    sec.items.filter((x) => matches(x, q) && refMatches(x, refFilter, sec.usageAvailable)),
    sort,
  );
  const unread = sec.usageAvailable && !it.useCount;

  return (
    <div className="md-wrap">
      <div className="left-col">
        <MemoryHeading
          sec={sec}
          /* 左カラムは listItems(検索・参照フィルタ後)を描くので、件数も一覧と同じくフィルタ後の数 */
          count={listItems.length}
          tokLabel={'≈' + sec.indexTokens.toLocaleString()}
        />
        {listItems.map((o) => (
          <button
            key={o.path}
            className={'ccard' + (o.path === it.path ? ' sel' : '')}
            onClick={() => openMemory(o.path)}
          >
            <span className="cn">{o.name}</span>
            <span className="cd">{o.description}</span>
            <span className="cm">
              <TokFacts it={o} />
            </span>
          </button>
        ))}
        {!listItems.length && <div className="empty">{t('list.empty')}</div>}
      </div>
      <div className="pane">
        <div className="pane-top">
          <button className="back" onClick={() => navigate({ pathname: '/', search: listSearch })}>
            {t('memory.back')}
          </button>
          {/* memory は完全読み取り専用: 削除・コピーは置かない(変更は指示文経由で Claude Code に委ねる) */}
          <span className="push">
            <button className="pbtn" onClick={onOpenEditor}>
              {t('detail.openEditor')}
            </button>
            <button
              className="pbtn"
              disabled={triageBusy}
              onClick={onTriage}
              title={t(it.aiTriage ? 'memory.triage.rerunTitle' : 'memory.triage.runTitle')}
            >
              {triageBusy
                ? t('memory.triage.running')
                : it.aiTriage
                  ? t('memory.triage.rerun')
                  : '✦ ' + t('memory.triage.heading')}
            </button>
          </span>
        </div>
        <h2 className="d-name mem">
          {it.name}
          <KindBadge it={it} />
          <MemoryTypeBadge it={it} />
          <UnreadBadge show={unread} />
        </h2>
        <div className="tabs">
          <button
            className={'tab' + (tab === 'overview' ? ' on' : '')}
            onClick={() => setTab('overview')}
          >
            {t('tab.overview')}
          </button>
          <button className={'tab' + (tab === 'body' ? ' on' : '')} onClick={() => setTab('body')}>
            {t('memory.tab.body')}
          </button>
        </div>
        {tab === 'overview' ? (
          <OverviewTab it={it} sec={sec} raw={raw} resolve={resolve} onOpen={openMemory} />
        ) : (
          <>
            {error && <div className="empty">{t('app.loadFailed', { msg: error })}</div>}
            {!error && raw === null && <div className="empty">{t('common.loading')}</div>}
            {!error && raw !== null && (
              /* renderMemoryBody 内で全テキストを HTML エスケープ済み */
              <div
                className="md-body"
                onClick={onBodyClick}
                dangerouslySetInnerHTML={{ __html: html }}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function OverviewTab({
  it,
  sec,
  raw,
  resolve,
  onOpen,
}: {
  it: SkillItem;
  sec: MemorySection;
  raw: string | null;
  resolve: (name: string) => SkillItem | undefined;
  onOpen: (path: string) => void;
}) {
  const links = it.links || [];
  const outgoing = links.map((name) => ({ name, to: resolve(name) }));
  const dead = outgoing.filter((l) => !l.to).map((l) => l.name);
  const backlinks = backlinksOf(it, sec.items);
  const frontmatter = raw === null ? null : splitFrontmatter(raw).frontmatter;

  // 本文(従量)の注記: 参照あり / なし / 計測不能 で言い分ける
  const bodyNote = !sec.usageAvailable
    ? t('memory.cbox.bodyNA')
    : it.useCount
      ? t('memory.cbox.bodyRead', { n: it.useCount })
      : t('memory.cbox.bodyUnread');

  return (
    <div>
      <p className="full-desc mem">{it.description}</p>
      {dead.length > 0 && (
        <div className="warnline">
          <span>⚠</span>
          <span>{t('memory.warnline', { n: dead.length, names: dead.join(', ') })}</span>
        </div>
      )}
      {/* 行き先の仮説と指示文。採否は人間が「貼るかどうか」で決めるので選択 UI は置かない */}
      <MemoryTriageBox it={it} sec={sec} />

      <div className="sec-t mem">{t('memory.sec.cost')}</div>
      <div className="cost2">
        <div className="cbox">
          <span className="k">{t('memory.cbox.indexK')}</span>
          <span className="v">
            {(it.indexTokens || 0).toLocaleString()}
            <small> {t('memory.cost.unit')}</small>
          </span>
          <span className="n">{t('memory.cbox.indexNote')}</span>
        </div>
        <div className="cbox dim">
          <span className="k">{t('memory.cost.bodyK')}</span>
          <span className="v">
            {(it.bodyTokens || 0).toLocaleString()}
            <small> {t('memory.cost.unit')}</small>
          </span>
          {/* 本文コストの注記も Read 回数を含むので、共有ストアでは同じ合算注記を添える */}
          <span className="n" title={readsTitle(sec)}>
            {bodyNote}
          </span>
        </div>
      </div>

      <div className="sec-t mem">{t('memory.sec.reads')}</div>
      <div className="f-row mem">
        <span className="rk">{t('memory.f.reads')}</span>
        <span title={readsTitle(sec, t('memory.readsTitle'))}>
          {!sec.usageAvailable ? (
            t('memory.f.na')
          ) : it.useCount ? (
            <>
              {t('memory.f.times', { n: it.useCount })}
              <span className="mono dim">{t('memory.f.last', { date: fmtMD(it.lastUsed) })}</span>
            </>
          ) : (
            <>
              {t('memory.f.none')}
              <span className="mono dim">{t('memory.f.noneNote')}</span>
            </>
          )}
        </span>
      </div>
      <div className="f-row mem">
        <span className="rk">{t('memory.f.writes')}</span>
        {/* Write も共有ストアでは全プロジェクト合算なので、Read と同じ注記を付ける */}
        <span title={readsTitle(sec, t('memory.writesTitle'))}>
          {!sec.usageAvailable
            ? t('memory.f.na')
            : it.writeCount
              ? t('memory.f.times', { n: it.writeCount })
              : t('memory.f.none')}
        </span>
      </div>
      {it.originSessionId && (
        <div className="f-row mem">
          <span className="rk">{t('memory.f.origin')}</span>
          <span className="mono">{it.originSessionId}</span>
        </div>
      )}

      {(outgoing.length > 0 || backlinks.length > 0) && (
        <>
          <div className="sec-t mem">{t('memory.sec.links')}</div>
          <div className="linkrow">
            {outgoing.map(({ name, to }) =>
              to ? (
                <button key={'o:' + name} className="lchip" onClick={() => onOpen(to.path)}>
                  <span className="arrow">→</span>
                  {name}
                </button>
              ) : (
                <span key={'o:' + name} className="lchip dead" title={t('memory.linkBrokenTitle')}>
                  <span className="arrow">→</span>
                  {t('memory.linkDead', { name })}
                </span>
              ),
            )}
            {backlinks.map((b) => (
              <button key={'b:' + b.path} className="lchip" onClick={() => onOpen(b.path)}>
                <span className="arrow">←</span>
                {b.name}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="sec-t mem">{t('memory.sec.frontmatter')}</div>
      <div className="fm-box mem">
        {raw === null ? t('common.loading') : (frontmatter ? frontmatter + '\n\n' : '') + it.path}
      </div>
    </div>
  );
}
