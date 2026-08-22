import { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  fetchFile,
  fromId,
  toId,
  type MemorySection,
  type SkillItem,
  type SkillsData,
} from '../api';
import { fileBase, fmtDate, relDaysLabel } from '../util';
import { esc, mdRender, splitFrontmatter } from '../md';
import { t } from '../i18n';
import { MemoryTypeBadge } from './GridView';
import { MemoryTriageBlock } from './MemoryTriageView';

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

export function MemoryDetail({ data, reload }: { data: SkillsData; reload: () => Promise<void> }) {
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
  const resolve = useMemo(() => {
    const items = sec?.items || [];
    return (name: string) => items.find((m) => m.name === name || fileBase(m.path) === name);
  }, [sec]);

  const html = useMemo(
    () => (raw === null ? '' : renderMemoryBody(splitFrontmatter(raw).body, resolve)),
    [raw, resolve],
  );

  // 存在しない id は一覧へ戻す(skill 詳細と同じ挙動)
  if (!sec || !it) return <Navigate to={{ pathname: '/', search: params.toString() }} replace />;

  const openMemory = (p: string) =>
    navigate({ pathname: '/memory/' + toId(p), search: params.toString() });

  /* 本文中のリンクは HTML なので、クリックを拾って SPA 遷移にする(フルリロード回避) */
  const onBodyClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    const a = (e.target as HTMLElement).closest('a[data-mem]');
    if (!a) return;
    e.preventDefault();
    navigate({ pathname: '/memory/' + a.getAttribute('data-mem'), search: params.toString() });
  };

  return (
    <div className="pane mem-pane">
      <button
        className="back"
        onClick={() => navigate({ pathname: '/', search: params.toString() })}
      >
        {t('detail.back')}
      </button>
      <div className="meta-row">
        <MemoryTypeBadge it={it} />
        <span className="mem-proj">
          {sec.projectName}
          {sec.orphan && (
            <span className="orphan-badge" title={t('memory.orphanTitle')}>
              {t('memory.orphan')}
            </span>
          )}
        </span>
        <span className="m-upd">{relDaysLabel(it.updatedAt)}</span>
        {/* 常時コスト(索引)と従量コスト(本文)、参照/更新の実績を事実として並べる */}
        <span className="mem-fact" title={t('memory.indexTokTitle')}>
          {t('memory.indexTok', { n: (it.indexTokens || 0).toLocaleString() })}
        </span>
        <span className="mem-fact" title={t('memory.bodyTokTitle')}>
          {t('memory.bodyTok', { n: (it.bodyTokens || 0).toLocaleString() })}
        </span>
        {sec.usageAvailable && (
          <>
            <span className="mem-fact" title={t('memory.readsTitle')}>
              {t('memory.reads', { n: it.useCount || 0 })}
            </span>
            <span className="mem-fact" title={t('memory.writesTitle')}>
              {t('memory.writes', { n: it.writeCount || 0 })}
            </span>
            {!!it.lastUsed && (
              <span className="mem-fact">
                {t('memory.lastRead', { date: fmtDate(it.lastUsed) })}
              </span>
            )}
          </>
        )}
      </div>
      <h2 className="d-name">{it.name}</h2>
      {it.originSessionId && (
        <div className="mem-origin">{t('memory.originSession', { id: it.originSessionId })}</div>
      )}
      <div className="sec-t">{t('detail.description')}</div>
      <p className="full-desc">{it.description}</p>
      {/* 行き先の仮説と指示文。採否は人間が「貼るかどうか」で決めるので選択 UI は置かない */}
      <MemoryTriageBlock it={it} sec={sec} reload={reload} />
      {error && <div className="empty">{t('app.loadFailed', { msg: error })}</div>}
      {!error && raw === null && <div className="empty">{t('common.loading')}</div>}
      {!error && raw !== null && (
        /* renderMemoryBody 内で全テキストを HTML エスケープ済み */
        <div className="md-body" onClick={onBodyClick} dangerouslySetInnerHTML={{ __html: html }} />
      )}
      {!!it.links?.length && (
        <>
          <div className="sec-t">{t('memory.links')}</div>
          <div className="rel-chips">
            {it.links.map((name) => {
              const to = resolve(name);
              return to ? (
                <button key={name} className="rel-chip" onClick={() => openMemory(to.path)}>
                  <span className="rn">{name}</span>
                </button>
              ) : (
                <span key={name} className="rel-chip missing">
                  <span className="rn">{name}</span>
                  <span className="rm">{t('memory.linkBroken')}</span>
                </span>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
