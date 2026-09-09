/*
 * 理解画面の「全文」(計画 15 Phase E1)。frontmatter + 本文を読むだけ(ブラウザ内編集は v0.9.0 で廃止)。
 * 本文は先頭だけ見せて「続きを表示(残り n 行)」で開く(モックの見た目)。
 * 前版との diff は GET /api/diff が available: true のときだけボタンを出す(C1 の仕様どおり、
 * 非 git・履歴なし・user scope では出ない)。行 diff の計算は既存の diff.ts。
 */

import { useEffect, useState } from 'react';
import { fetchDiff, fetchFile, type DiffResponse } from '../api';
import { diffLines, type DiffLine } from '../diff';
import { mdRender, splitFrontmatter, splitPreview } from '../md';
import { shortPath } from '../detail';
import { fmtDate, type FlatItem } from '../util';
import { t } from '../i18n';

const mdCache = new Map<string, string>();

/* 「エディタで開く」で編集 → 再スキャン後に古い SKILL.md が残らないよう reload 時に呼ぶ */
export function clearMdCache(): void {
  mdCache.clear();
}

/* SKILL.md の生テキスト。全文ブロックと、フロー図未生成時の見出しツリーが共有する */
export function useMdText(path: string): { raw: string | null; error: string } {
  const [raw, setRaw] = useState<string | null>(() => (path ? (mdCache.get(path) ?? null) : null));
  const [error, setError] = useState('');
  useEffect(() => {
    if (!path) return;
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
  return { raw, error };
}

export function FullTextBlock({
  it,
  raw,
  error,
  cwd,
}: {
  it: FlatItem;
  raw: string | null;
  error: string;
  cwd: string;
}) {
  const [prev, setPrev] = useState<DiffResponse | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [more, setMore] = useState(false);

  useEffect(() => {
    let alive = true;
    setPrev(null);
    setShowDiff(false);
    setMore(false);
    // 失敗(サーバー停止など)はボタンを出さないだけ。全文の表示は妨げない
    fetchDiff(it.path)
      .then((r) => {
        if (alive) setPrev(r);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [it.path]);

  const parsed = raw === null ? null : splitFrontmatter(raw);
  const preview = parsed ? splitPreview(parsed.body) : null;
  const shown = preview ? (more || !preview.rest ? parsed!.body : preview.head) : '';

  return (
    <section className="dblk">
      <div className="dblk-hd rule">
        <h2>{t('full.title')}</h2>
        <span className="meta mono ellip">
          {t('full.updated', { path: shortPath(it.path, cwd), date: fmtDate(it.updatedAt) })}
        </span>
        {prev?.available && raw !== null && (
          <button
            className={'btn hd-r' + (showDiff ? ' on' : '')}
            onClick={() => setShowDiff((v) => !v)}
          >
            {showDiff ? t('detail.diffClose') : t('full.diffPrev')}
          </button>
        )}
      </div>
      {error && <div className="dv-empty">{t('app.loadFailed', { msg: error })}</div>}
      {!error && raw === null && <div className="dv-empty">{t('common.loading')}</div>}
      {parsed && showDiff && prev?.previous !== undefined && (
        <div className="dv-diff">
          <DiffBlock
            aLabel={t('diff.prev')}
            bLabel={t('diff.now')}
            dep={it.path}
            load={async () => [prev.previous!, raw!]}
          />
        </div>
      )}
      {parsed && (
        <>
          {parsed.frontmatter && <div className="fm">{parsed.frontmatter}</div>}
          {/* 自前レンダラ内で全テキストを HTML エスケープ済み */}
          <div className="md-full">
            <div className="md-body" dangerouslySetInnerHTML={{ __html: mdRender(shown) }} />
            {preview?.rest && (
              <button className="linkbtn meta" onClick={() => setMore((v) => !v)}>
                {more ? t('full.less') : t('full.more', { n: preview.restLines })}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/*
 * 行 diff(同名の定義どうし / 前版と現在)。テキストの取得は呼び出し側の load に委ね、
 * ここは描画だけ(0.3 の diff 文法: 行頭の + / − と 8% 透過の地色)。
 */
export function DiffBlock({
  aLabel,
  bLabel,
  dep,
  load,
}: {
  aLabel: string;
  bLabel: string;
  /* load を作り直す条件(パスの組)。関数そのものを依存にすると毎レンダー再取得になる */
  dep: string;
  load: () => Promise<[string, string]>;
}) {
  const [lines, setLines] = useState<DiffLine[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setLines(null);
    setError('');
    load()
      .then(([a, b]) => {
        if (alive) setLines(diffLines(a, b));
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep]);

  if (error) return <div className="dv-empty">{t('diff.failed', { msg: error })}</div>;
  if (!lines) return <div className="dv-empty">{t('common.loading')}</div>;
  const changed = lines.filter((l) => l.type === 'add' || l.type === 'del').length;
  return (
    <div className="diff-wrap">
      <div className="diff-legend">
        <span className="d-del-mark">{aLabel}</span>
        <span className="d-add-mark">{bLabel}</span>
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

/* 同名の別定義との diff(事実の帯から開く)。両方の現在の内容を取って並べる */
export function SameNameDiff({ a, b }: { a: FlatItem; b: FlatItem }) {
  return (
    <DiffBlock
      aLabel={t('diff.thisDef', { label: a.scopeLabel })}
      bLabel={'+ ' + b.scopeLabel}
      dep={a.path + '\n' + b.path}
      load={() => Promise.all([fetchFile(a.path), fetchFile(b.path)])}
    />
  );
}
