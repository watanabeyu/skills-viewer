/*
 * memory 詳細(/memory/:id。計画 15 Phase F / README 6.2「この記憶は残すべきか」)。
 * 1 列で上から答える: 名前と説明 → 事実の帯(読まれた回数 / 追加・更新 / リンク / ファイル)
 * → 索引行(本文との一致)→ ✦ 診断(鮮度 → 行き先 → 理由 → シグナル → 指示文)→ 本文。
 * 答え(診断)を本文より先に置く。棚卸し前は鮮度(機械判定)とシグナルだけが出る。
 * 指示文は全文を等幅ブロックで見せ(事実ヘッダ + 本文 + 末尾の確認手順)、コピーは 1 件ずつ(まとめてコピーは持たない)。
 * 寸法は docs/design/0.9.0/{Ledger,Console}MemoryDetail.dc.html の実測(style.css の --mem-* / E1 のトークン)。
 */

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
import {
  backlinksOf,
  copyInstruction,
  effectiveInstruction,
  estimateLabel,
  fileName,
  fmtDate,
  memoryListSearch,
  memoryResolver,
} from '../util';
import { allSignals, indexMatchOf, triageMeta } from '../memory';
import { historyOf } from '../detail';
import { esc, mdRender, splitFrontmatter } from '../md';
import { memoryVerdictLabel, t } from '../i18n';
import { CopyButton, InlineError, InlineNote } from './Inline';
import { EditorButton, useOpenEditor } from './EditorButton';
import { FactCell, Sparkline } from './FactsBand';
import { Instruction } from './InvokeBlock';
import { KindPill, SourcePill } from './Rows';
import {
  MemoryTypePill,
  SignalLine,
  StateDot,
  VerdictWordCell,
  runTriage,
  usageTitle,
} from './MemoryBits';

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
  /* 本文の取得も読み取り許可(cwd + 選んだプロジェクト)に乗るので起点を渡す(計画 16) */
  const selected = data.selected.id;
  const [raw, setRaw] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!path) return;
    let alive = true;
    setRaw(null);
    setError('');
    fetchFile(path, selected)
      .then((content) => {
        if (alive) setRaw(content);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [path, selected]);

  /* 同一セクション内で name またはファイル名が一致するメモリに解決する */
  const resolve = useMemo(() => memoryResolver(sec?.items || []), [sec]);

  // 存在しない id は memory 一覧へ戻す
  if (!sec || !it)
    return <Navigate to={{ pathname: '/memory', search: memoryListSearch(params) }} replace />;

  const openMemory = (p: string) =>
    navigate({ pathname: '/memory/' + toId(p), search: params.toString() });

  return (
    <div className="dv">
      <TitleBlock it={it} sec={sec} selected={selected} />
      <Facts it={it} sec={sec} data={data} resolve={resolve} onOpen={openMemory} />
      <IndexPanel it={it} />
      <TriagePanel
        it={it}
        sec={sec}
        selected={selected}
        aiAvailable={data.aiAvailable}
        reload={reload}
      />
      <BodyPanel it={it} raw={raw} error={error} resolve={resolve} onOpen={openMemory} />
    </div>
  );
}

/* 名前とチップ(memory / type / プロジェクト)、右端に「エディタで開く」。下に description */
function TitleBlock({
  it,
  sec,
  selected,
}: {
  it: SkillItem;
  sec: MemorySection;
  /* 選んでいるプロジェクト(SkillsData.selected.id)。エディタで開く経路も読み取り許可に乗る */
  selected: string;
}) {
  const { openError, onOpenEditor } = useOpenEditor(it.path, selected);
  return (
    <div className="dv-title">
      <div className="dv-title-row">
        <h1>{it.name}</h1>
        <KindPill kind="memory" />
        <MemoryTypePill it={it} />
        <SourcePill source="project" label={sec.projectName} />
        {sec.orphan && (
          <span className="pill" title={t('memory.orphanTitle')}>
            {t('memory.orphan')}
          </span>
        )}
        {sec.sharedStore && (
          <span className="pill" title={t('memory.sharedStoreTitle')}>
            {t('memory.sharedStore')}
          </span>
        )}
        <span className="dv-title-r">
          <InlineError msg={openError} />
          {/* memory は読み取り専用: 削除・コピーは置かない(変更は指示文経由で Claude Code に委ねる) */}
          <EditorButton onClick={onOpenEditor} />
        </span>
      </div>
      {it.description && <p className="dv-desc">{it.description}</p>}
    </div>
  );
}

/* 事実の帯: 読まれた回数(+ スパークライン、書き換え)/ 追加・更新 / リンク(2 行)/ ファイル(E1 の FactCell を共用) */
function Facts({
  it,
  sec,
  data,
  resolve,
  onOpen,
}: {
  it: SkillItem;
  sec: MemorySection;
  data: SkillsData;
  resolve: (name: string) => SkillItem | undefined;
  onOpen: (path: string) => void;
}) {
  const outgoing = (it.links || []).map((name) => ({ name, to: resolve(name) }));
  const backlinks = backlinksOf(it, sec.items);
  const h = historyOf(it, data.changes);
  const reads = it.useCount || 0;
  const writes = it.writeCount || 0;
  const dir = it.path.replace(/[\\/][^\\/]+$/, '');
  return (
    <div className="dblk facts">
      <FactCell label={t('memory.fact.reads')}>
        {sec.usageAvailable ? (
          <>
            <span className="fv" title={usageTitle(sec, t('memory.readsTitle'))}>
              {reads.toLocaleString()} <span className="meta">{t('memory.fact.times')}</span>
            </span>
            <Sparkline daily={it.dailyUse || {}} />
            <span className="meta">
              {reads ? (
                <>
                  {t('fact.last', { date: '' })}
                  <span className="mono">{fmtDate(it.lastUsed)}</span>
                </>
              ) : (
                t('memory.fact.noReads')
              )}
              {writes > 0 && (
                <span title={usageTitle(sec, t('memory.writesTitle'))}>
                  {t('memory.fact.rewrites', { n: writes })}
                </span>
              )}
            </span>
          </>
        ) : (
          <span className="meta">{t('fact.noUsage')}</span>
        )}
      </FactCell>
      <FactCell label={t('fact.history')} mark={h.mark}>
        {/* 自動メモリは Claude Code が書く。生成元セッションが分かればそれを添える(git は引けない場所なので author は無い) */}
        {it.originSessionId ? (
          <>
            <span className="fv-sub">{t('memory.fact.by')}</span>
            <span className="meta">
              {t('memory.fact.session', { id: '' })}
              <span className="mono">{shortSession(it.originSessionId)}</span>
              {' · '}
              {t('fact.updated', { date: '' })}
              <span className="mono">{fmtDate(it.updatedAt)}</span>
            </span>
          </>
        ) : (
          <span className="fv-sub mono">
            {it.updatedAt ? t('fact.updated', { date: fmtDate(it.updatedAt) }) : '—'}
          </span>
        )}
      </FactCell>
      <FactCell label={t('memory.fact.links')}>
        <span className="fv-line mlinks">
          <span className="fv-sub">{t('memory.fact.linksOut', { n: outgoing.length })}</span>
          {outgoing.map(({ name, to }) =>
            to ? (
              <button key={'o:' + name} className="link mono" onClick={() => onOpen(to.path)}>
                {name}
              </button>
            ) : (
              <span key={'o:' + name} className="mono warn" title={t('memory.linkBrokenTitle')}>
                ⚠ {name}
              </span>
            ),
          )}
        </span>
        <span className="fv-line mlinks">
          <span className="fv-sub">{t('memory.fact.linksIn', { n: backlinks.length })}</span>
          {backlinks.map((b) => (
            <button key={'b:' + b.path} className="link mono" onClick={() => onOpen(b.path)}>
              {b.name}
            </button>
          ))}
        </span>
      </FactCell>
      <FactCell label={t('fact.files')}>
        <span className="fv-files mono">
          <span>{fileName(it.path)}</span>
        </span>
        <span className="meta mono ellip" title={dir}>
          {dir}
        </span>
      </FactCell>
    </div>
  );
}

/* セッション id は先頭 4 + 末尾 4(モックの「c8b3…9d12」) */
const shortSession = (id: string) => (id.length > 12 ? id.slice(0, 4) + '…' + id.slice(-4) : id);

/* 索引行: MEMORY.md のその行(等幅)と、本文との一致(AI の答え。棚卸し前は未比較) */
function IndexPanel({ it }: { it: SkillItem }) {
  const m = indexMatchOf(it);
  const status =
    m === 'match' ? (
      <span className="good mstatus">{t('memory.index.match')}</span>
    ) : m === 'mismatch' ? (
      <span className="warn mstatus">{t('memory.index.mismatch')}</span>
    ) : m === 'beyond' ? (
      <span className="warn mstatus">{t('memory.index.beyond')}</span>
    ) : m === 'none' ? (
      <span className="warn mstatus">{t('memory.index.none')}</span>
    ) : (
      <span className="meta mstatus">{t('memory.index.unknown')}</span>
    );
  return (
    <section className="mpanel">
      <div className="mhd">
        <span className="mcap">{t('memory.index.title')}</span>
        {it.indexLine && (
          <span className="meta">
            {t('memory.index.meta', { n: (it.indexTokens || 0).toLocaleString() })}
          </span>
        )}
        <span className="hd-r">{status}</span>
      </div>
      {it.indexLine && <div className="mindex mono">{it.indexLine}</div>}
    </section>
  );
}

/*
 * ✦ 診断: 鮮度 → 行き先 → 理由 → シグナル → 指示文。実行ボタンは見出しの右(1 件だけを診断し直す)。
 * 棚卸し前は鮮度(機械)とシグナルだけ。判断は 3 層(機械 = 事実 / AI = 行き先の仮説と指示文 / 人間 = 貼るかどうか)で、
 * viewer は採否の選択状態を持たない。
 */
function TriagePanel({
  it,
  sec,
  selected,
  aiAvailable,
  reload,
}: {
  it: SkillItem;
  sec: MemorySection;
  /* 走査の起点(SkillsData.selected.id)。一覧と同じ起点で棚卸しする(計画 16) */
  selected: string;
  aiAvailable: boolean;
  reload: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const tri = it.aiTriage;
  const done = !!tri && !tri.error;
  const signals = allSignals(it);
  const instruction = effectiveInstruction(it);
  const meta = triageMeta(tri, fmtDate);
  const estimate =
    tri && tri.verdict !== 'shrink' && tri.verdict !== 'update' ? estimateLabel(it) : '';

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      await runTriage(sec, selected, it);
      await reload();
    } catch (e) {
      setError(t('alert.triageFailed', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mpanel">
      <div className="mhd">
        <span className="mcap">{t('memory.diag.title')}</span>
        {meta && <span className="meta">{meta}</span>}
        <span className="hd-r">
          <InlineError msg={error} />
          {!aiAvailable && <InlineNote msg={t('ai.unavailable')} />}
          <button
            className="btn"
            disabled={busy || !aiAvailable}
            onClick={run}
            title={t(tri ? 'memory.triage.rerunTitle' : 'memory.triage.runTitle')}
          >
            {busy
              ? t('memory.triage.running')
              : tri
                ? t('memory.triage.rerun')
                : t('memory.triage.runOne')}
          </button>
        </span>
      </div>
      <div className="kv mkv">
        <span className="k">{t('memory.diag.state')}</span>
        <span>
          <StateDot it={it} />
          <span className="meta">{t(done ? 'memory.state.byAi' : 'memory.state.byMachine')}</span>
        </span>
        {done && (
          <>
            <span className="k">{t('memory.diag.verdict')}</span>
            <span className="v-wrap">
              <VerdictWordCell tri={tri} />
              <span className="meta">
                {memoryVerdictLabel(tri.verdict)}
                {tri.demoted && (
                  <span title={t('memory.triage.demotedTitle')}>
                    {' · ⚠ ' + t('memory.triage.demoted')}
                  </span>
                )}
                {/* 試算は索引が動く行き先(移動・削除)だけ。shrink / update は「±0 · 本文を…」が行き先と重複する */}
                {estimate && ' · ' + estimate}
              </span>
            </span>
            <span className="k">{t('memory.diag.reason')}</span>
            <span className="v-col mreason">
              {tri.reason && (
                <span className="sub">
                  {tri.demoted && t('memory.triage.demotedReason')}
                  {tri.reason}
                </span>
              )}
              {tri.issues.map((issue, i) => (
                <span className="meta" key={i}>
                  – {issue}
                </span>
              ))}
            </span>
          </>
        )}
        {tri?.error && (
          <>
            <span className="k">{t('memory.diag.verdict')}</span>
            <span>
              <VerdictWordCell tri={tri} />
              <span className="meta">{t('memory.diag.errorNote')}</span>
            </span>
          </>
        )}
        <span className="k">{t('memory.diag.signals')}</span>
        <span className="v-col msignals">
          {signals.length ? (
            signals.map((s, i) => <SignalLine s={s} key={i} />)
          ) : (
            <span className="meta">{t('memory.diag.signalsNone')}</span>
          )}
          <span className="meta">{t('memory.diag.signalsNote')}</span>
        </span>
        {!tri && (
          <>
            <span className="k">{t('memory.diag.prompt')}</span>
            <span className="v-wrap">
              <span className="meta">{t('memory.diag.none')}</span>
            </span>
          </>
        )}
        {done && instruction && (
          <>
            <span className="k">{t('memory.diag.prompt')}</span>
            <span className="v-col mprompt">
              <span className="v-line">
                <span className="meta grow">{t('memory.diag.promptNote')}</span>
                {/* コピー本文は事実ヘッダ(対象ディレクトリ・プロジェクト・ファイル)+ 本文 + 確認手順 */}
                <CopyButton
                  className="btn sm"
                  text={copyInstruction(sec, it)}
                  label={t('memory.diag.copy')}
                />
              </span>
              <Instruction text={copyInstruction(sec, it)} />
            </span>
          </>
        )}
      </div>
    </section>
  );
}

/* 本文: frontmatter + md(E1 の全文と同じ枠)。[[link]] は詳細へ SPA 遷移 */
function BodyPanel({
  it,
  raw,
  error,
  resolve,
  onOpen,
}: {
  it: SkillItem;
  raw: string | null;
  error: string;
  resolve: (name: string) => SkillItem | undefined;
  onOpen: (path: string) => void;
}) {
  const parsed = raw === null ? null : splitFrontmatter(raw);
  const html = useMemo(
    () => (parsed ? renderMemoryBody(parsed.body, resolve) : ''),
    [parsed, resolve],
  );
  /* 本文中のリンクは HTML なので、クリックを拾って SPA 遷移にする(フルリロード回避) */
  const onBodyClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    const a = (e.target as HTMLElement).closest('a[data-mem]');
    if (!a) return;
    e.preventDefault();
    onOpen(fromId(a.getAttribute('data-mem') || ''));
  };
  return (
    <section className="mpanel">
      <div className="mhd">
        <span className="mcap">{t('memory.body.title')}</span>
        <span className="meta mono">
          {t('memory.body.meta', { n: (it.bodyTokens || 0).toLocaleString() })}
        </span>
      </div>
      {error && <div className="dv-empty">{t('app.loadFailed', { msg: error })}</div>}
      {!error && raw === null && <div className="dv-empty">{t('common.loading')}</div>}
      {parsed && (
        <>
          {parsed.frontmatter && <div className="fm">{parsed.frontmatter}</div>}
          {/* renderMemoryBody 内で全テキストを HTML エスケープ済み */}
          <div className="md-full">
            <div
              className="md-body"
              onClick={onBodyClick}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>
        </>
      )}
    </section>
  );
}
