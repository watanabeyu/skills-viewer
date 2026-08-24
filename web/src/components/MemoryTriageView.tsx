import { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  fetchFile,
  toId,
  triageMemory,
  type MemorySection,
  type MemoryTriage,
  type SkillItem,
  type SkillsData,
} from '../api';
import {
  copyInstruction,
  copyText,
  effectiveInstruction,
  fileName,
  instructionsOf,
  joinInstructions,
  memoryListSearch,
  memoryResolver,
  skewedVerdict,
  triageEstimate,
} from '../util';
import { memoryVerdictLabel, t } from '../i18n';
import { splitFrontmatter } from '../md';
import { KindBadge } from './GridView';
import { MemoryPathSub, MemoryTypeBadge, TokFacts } from './MemoryBits';
import { renderMemoryBody } from './MemoryDetail';

/*
 * memory 棚卸し診断の画面 + 詳細画面に埋めるブロック。
 * 判断は 3 層(機械 = 事実の提示 / AI = 行き先の仮説と指示文 / 人間 = 指示文を貼るかどうか)で、
 * viewer は採否の選択状態を持たない。操作はコピーだけ、実行は貼り先の Claude Code に委ねる。
 */

/* 試算の符号付き表記(0 は増減なしを明示するため ±0) */
const signed = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(n).toLocaleString();

/*
 * 削減試算のラベル。機械層で計算する(AI に数値を出させない)。
 * shrink / update は索引が変わらないので数値でなく文言だけ、keep は空。
 */
function estimateLabel(it: SkillItem): string {
  if (it.aiTriage?.verdict === 'shrink') return t('memory.triage.estShrink');
  if (it.aiTriage?.verdict === 'update') return t('memory.triage.estUpdate');
  const est = triageEstimate(it);
  if (!est) return '';
  // 読み込み上限の外にある索引行は元から注入されていないので、消しても常時コストは減らない。
  // 「索引 ±0」だけだと変更なしに見えるため、減らない理由まで書く(delete / to-docs / … 系)
  if (it.indexBeyondLimit && est.always === 0) return t('memory.triage.estApplyBeyond');
  if (est.always > 0)
    return t('memory.triage.estApplyClaude', {
      n: signed(est.index),
      m: est.always.toLocaleString(),
    });
  return t('memory.triage.estApply', { n: signed(est.index) });
}

/* 1 件の棚卸しを実行(詳細画面の「✦ 棚卸し診断」)。診断済みなら force で診断し直す */
export const runTriageOne = (sec: MemorySection, it: SkillItem) =>
  triageMemory(sec.id, [fileName(it.path)], !!it.aiTriage);

export function CopyButton({
  text,
  label,
  className,
}: {
  text: string;
  label?: string;
  className: string;
}) {
  const [done, setDone] = useState(false);
  // コピー成功のフィードバックは 2 秒でラベルを戻す
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setDone(false), 2000);
    return () => window.clearTimeout(timer);
  }, [done]);
  const onClick = async () => {
    try {
      await copyText(text);
      setDone(true);
    } catch (e) {
      alert(t('alert.copyFailed', { msg: e instanceof Error ? e.message : String(e) }));
    }
  };
  return (
    <button className={className} onClick={onClick}>
      {done ? t('memory.triage.copied') : label || t('memory.triage.copy')}
    </button>
  );
}

/* 出力不正の件は行き先が無いので、verdict の代わりに再診断を促すバッジを出す */
export function VerdictBadge({ tri }: { tri: MemoryTriage }) {
  if (tri.error)
    return <span className="vbadge v-error">✦ {t('memory.triage.verdict.error')}</span>;
  return <span className={'vbadge v-' + tri.verdict}>✦ {memoryVerdictLabel(tri.verdict)}</span>;
}

/*
 * 機械シグナルが無い wrong-project を keep へ格下げした件の注記
 * (判断 5 のプロジェクト不明セクションでの格下げも含む)。
 * 提案としては出さないが、握り潰さず「自分で確認して」と伝えるため verdict バッジの隣に置く。
 */
export function DemotedNote({ tri }: { tri: MemoryTriage }) {
  if (!tri.demoted) return null;
  return (
    <span className="issue warn" title={t('memory.triage.demotedTitle')}>
      ⚠ {t('memory.triage.demoted')}
    </span>
  );
}

/*
 * 診断結果の本体(棚卸し行 / 詳細ブロックで共用)。理由 → issues → 指示文。
 * 指示文は折りたたまず全文を出す(貼るかどうかの判断がここで完結するように)。
 */
function TriageResult({ it, sec }: { it: SkillItem; sec: MemorySection }) {
  const tri = it.aiTriage;
  // 出力不正の件は理由・根拠・指示文・試算のいずれも信用できないので何も出さない
  if (!tri || tri.error) return null;
  // 分類(body)があればテンプレートの指示文、無ければ AI の散文
  const instruction = effectiveInstruction(it);
  // 行き先に関わらず必ず見せる事実(置き場所の誤り・索引と本文の食い違い)。verdict が keep でも消えない
  const warns = [...(it.signals || []), ...(tri.signals || [])].filter(
    (s) => s.kind === 'other-project' || s.kind === 'index-mismatch',
  );
  return (
    <>
      {/* 格下げ件の理由文は機械シグナルの裏付けが無いモデルの見立てなので、事実と混ぜずラベルを付ける */}
      {tri.reason && (
        <p className="reason">
          {tri.demoted && t('memory.triage.demotedReason')}
          {tri.reason}
        </p>
      )}
      {!!warns.length && (
        <div className="issues">
          {warns.map((s, i) => (
            <span className="issue warn" key={'w' + i}>
              ⚠ {t(`memory.signal.${s.kind}` as 'memory.signal.other-project', { value: s.value })}
            </span>
          ))}
        </div>
      )}
      {!!tri.issues.length && (
        <div className="issues">
          {/* 同じ文言が 2 件返り得るので key は index(並びは AI 出力のまま固定) */}
          {/* 格下げ件の issues は採用しなかった行き先の根拠なので、機械が裏付けた事実チップと
              同じ見た目にしない(左アクセントで区別し、未検証であることを title で補う) */}
          {tri.issues.map((issue, i) => (
            <span
              className={tri.demoted ? 'issue demoted' : 'issue'}
              title={tri.demoted ? t('memory.triage.demotedTitle') : undefined}
              key={i}
            >
              {issue}
            </span>
          ))}
        </div>
      )}
      {instruction && (
        <div className="instr">
          <div className="instr-h">
            <span className="instr-t">{t('memory.triage.instruction')}</span>
            <span className="instr-d">{estimateLabel(it)}</span>
            {/* コピー本文は前置き + 事実ヘッダ(対象ディレクトリ・プロジェクト・ファイル)付き */}
            <CopyButton className="copybtn" text={copyInstruction(sec, it)} />
          </div>
          <div className="instr-body">{instruction}</div>
        </div>
      )}
    </>
  );
}

/*
 * 詳細画面の概要タブに出す 1 件分の診断ブロック(発動診断の diag-box と同じ枠)。
 * 実行ボタンは pane-top 側にあるので、ここは診断済みのときだけ結果を描く。
 * 結果は一覧と同じ件単位キャッシュに載るので、棚卸し画面とも共有される。
 */
export function MemoryTriageBox({ it, sec }: { it: SkillItem; sec: MemorySection }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const tri = it.aiTriage;
  if (!tri) return null;
  return (
    <div className="diag-box triage-box">
      <div className="nmline">
        <VerdictBadge tri={tri} />
        <DemotedNote tri={tri} />
      </div>
      <TriageResult it={it} sec={sec} />
      <button
        className="triage-whole"
        onClick={() =>
          navigate({ pathname: '/memory/triage/' + sec.id, search: params.toString() })
        }
      >
        {t('memory.triage.whole')}
      </button>
    </div>
  );
}

/*
 * 棚卸し行の memory 名クリックで本文を出すモーダル。行き先の判断は本文を読まないと
 * 決められないことが多いので、画面を離れずに(診断結果と並べたまま)読めるようにする。
 * [[link]] は詳細と同じ解決で、クリックすると詳細へ遷移(モーダルは閉じる)。
 */
function MemoryBodyModal({
  it,
  sec,
  onClose,
}: {
  it: SkillItem;
  sec: MemorySection;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [raw, setRaw] = useState<string | null>(null);
  const [error, setError] = useState('');
  const resolve = useMemo(() => memoryResolver(sec.items), [sec]);

  useEffect(() => {
    let alive = true;
    setRaw(null);
    setError('');
    fetchFile(it.path)
      .then((content) => {
        if (alive) setRaw(content);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [it.path]);

  // Esc で閉じる(overlay クリックと同じ扱い)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const html = useMemo(
    () => (raw === null ? '' : renderMemoryBody(splitFrontmatter(raw).body, resolve)),
    [raw, resolve],
  );
  const goDetail = (id: string) => {
    onClose();
    navigate({ pathname: '/memory/' + id, search: params.toString() });
  };
  const onBodyClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    const a = (e.target as HTMLElement).closest('a[data-mem]');
    if (!a) return;
    e.preventDefault();
    goDetail(a.getAttribute('data-mem') || '');
  };

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal mem-modal" role="dialog" aria-label={it.name}>
        <div className="mem-modal-h">
          <span className="mem-modal-name">{it.name}</span>
          <KindBadge it={it} />
          <MemoryTypeBadge it={it} />
          <span className="mem-modal-sp" />
          <button className="pbtn" onClick={() => goDetail(toId(it.path))}>
            {t('memory.triage.openDetail')}
          </button>
          <button className="pbtn" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
        {it.description && <p className="mem-modal-desc">{it.description}</p>}
        <div className="mem-modal-body">
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
        </div>
      </div>
    </div>
  );
}

/* プロジェクト 1 件分の棚卸し診断画面(/memory/triage/:project) */
export function MemoryTriageView({
  data,
  reload,
}: {
  data: SkillsData;
  reload: () => Promise<void>;
}) {
  const { project } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  // 本文モーダルで開いている memory(パスで持ち、再取得後も同じ行を指せるようにする)
  const [bodyPath, setBodyPath] = useState<string | null>(null);

  const sec = (data.memory || []).find((s) => s.id === project);
  // 存在しないプロジェクト(削除・リネーム後の共有 URL)は memory 一覧へ戻す
  const listSearch = memoryListSearch(params);
  if (!sec) return <Navigate to={{ pathname: '/', search: listSearch }} replace />;

  const untriagedCount = sec.items.filter((it) => !it.aiTriage).length;
  const proposals = instructionsOf(sec.items);
  // 提案が 1 種類に偏っているときは、行き先より先に「プロジェクトの特定」を疑ってもらう
  const skew = skewedVerdict(sec.items);
  // 出力不正は verdict keep / 指示文なしで入っているので、現状維持の件数から除いて別に数える
  const errorCount = sec.items.filter((it) => it.aiTriage?.error).length;
  const keepCount = sec.items.length - untriagedCount - proposals.length - errorCount;
  const totals = sec.items.reduce(
    (acc, it) => {
      const est = triageEstimate(it);
      return est ? { index: acc.index + est.index, always: acc.always + est.always } : acc;
    },
    { index: 0, always: 0 },
  );
  const diff = totals.index + totals.always;
  const applied = sec.indexTokens + diff;

  const run = async () => {
    setBusy(true);
    try {
      // 未診断が残っていれば差分診断、全件診断済みなら force で全件を診断し直す
      await triageMemory(sec.id, undefined, untriagedCount === 0);
      await reload();
    } catch (e) {
      alert(t('alert.triageFailed', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="triage-view">
      <div className="hd">
        <div className="t-row">
          <button className="pbtn" onClick={() => navigate({ pathname: '/', search: listSearch })}>
            {t('memory.triage.back')}
          </button>
          <h1>{t('memory.triage.title', { project: sec.projectName })}</h1>
          <span className="sub">{t('memory.triage.sub')}</span>
          <button
            className="pbtn push-r"
            disabled={busy}
            onClick={run}
            title={t(untriagedCount ? 'memory.triage.runTitle' : 'memory.triage.rerunTitle')}
          >
            {busy
              ? t('memory.triage.running')
              : untriagedCount
                ? t('memory.triage.run')
                : t('memory.triage.rerun')}
          </button>
        </div>
        <MemoryPathSub sec={sec} />
      </div>
      <div className="triage-pad">
        <div className="sec-t mem tri">
          {untriagedCount
            ? t('memory.triage.summaryPending', { n: sec.items.length, u: untriagedCount })
            : t(errorCount ? 'memory.triage.summaryWithErrors' : 'memory.triage.summary', {
                n: sec.items.length,
                p: proposals.length,
                k: keepCount,
                e: errorCount,
              })}
        </div>
        {/* 偏り警告。verdict は上書きせず、確認の順序(まずプロジェクトの特定)だけを促す */}
        {skew && !busy && (
          <div className="chg-banner warn">
            <span className="chg-title">⚠ {memoryVerdictLabel(skew)}</span>
            <span>{t('memory.triage.skew')}</span>
          </div>
        )}
        {/* 入口の「✦ 棚卸し診断」は遷移だけで AI は走らない。未診断・診断中は行の上で状態を明示する */}
        {busy ? (
          <div className="triage-cta busy">
            <div className="txt">
              <span className="ttl">{t('memory.triage.busyTitle')}</span>
              <span className="bd">
                {t('memory.triage.busyBody', { n: untriagedCount || sec.items.length })}
              </span>
            </div>
          </div>
        ) : (
          untriagedCount > 0 && (
            <div className="triage-cta">
              <div className="txt">
                <span className="ttl">{t('memory.triage.ctaTitle')}</span>
                <span className="bd">
                  {untriagedCount === sec.items.length
                    ? t('memory.triage.ctaBody', { n: sec.items.length })
                    : t('memory.triage.ctaPartial', { n: sec.items.length, u: untriagedCount })}
                </span>
              </div>
              <button className="apply" onClick={run} title={t('memory.triage.runTitle')}>
                ✦ {t('memory.triage.run')}
              </button>
            </div>
          )
        )}
        {/* 前置きは画面にも 1 回だけ出す(範囲選択でコピーする人が拾えるように)。行の指示文には繰り返さない */}
        {!!proposals.length && !busy && (
          <div className="triage-preamble">
            <div className="txt">
              <span className="lbl">{t('memory.triage.preambleLabel')}</span>
              <span className="bd">{t('memory.triage.copyPreamble')}</span>
            </div>
            <CopyButton className="copybtn" text={t('memory.triage.copyPreamble')} />
          </div>
        )}
        {bodyPath &&
          (() => {
            const cur = sec.items.find((x) => x.path === bodyPath);
            return cur ? (
              <MemoryBodyModal it={cur} sec={sec} onClose={() => setBodyPath(null)} />
            ) : null;
          })()}
        <div className={'triage-rows' + (busy ? ' busy' : '')}>
          {sec.items.map((it) => (
            <div className="triage-row" key={it.path}>
              <div className="nmline">
                {/* 名前クリックは本文モーダル(詳細へは modal 内のボタンから) */}
                <button className="nm" onClick={() => setBodyPath(it.path)}>
                  {it.name}
                </button>
                <KindBadge it={it} />
                <MemoryTypeBadge it={it} />
                {/* 未診断の行は verdict 無しで事実だけを出す */}
                {it.aiTriage && <VerdictBadge tri={it.aiTriage} />}
                {it.aiTriage && <DemotedNote tri={it.aiTriage} />}
                <span className="toks">
                  <TokFacts it={it} bold />
                  {/* 参照回数はトランスクリプトが無いプロジェクトでは判定不能なので出さない */}
                  {sec.usageAvailable && (
                    <span title={t('memory.readsTitle')}>
                      {it.useCount
                        ? t('memory.triage.seen', { n: it.useCount })
                        : t('memory.triage.unseen')}
                    </span>
                  )}
                </span>
              </div>
              <TriageResult it={it} sec={sec} />
            </div>
          ))}
        </div>
        {!!proposals.length && (
          <div className="foot">
            <div className="cell">
              <span className="k">{t('memory.triage.footProposals')}</span>
              <span className="v">
                {proposals.length}
                <span className="u"> {t('memory.triage.footProposalsUnit')}</span>
              </span>
            </div>
            <div className="cell">
              <span className="k">{t('memory.triage.footApplied')}</span>
              <span className="v">
                {applied.toLocaleString()}
                <span className="u"> {t('memory.triage.footTokUnit')}</span>
              </span>
            </div>
            <div className="cell">
              <span className="k">{t('memory.triage.footDiff')}</span>
              <span className={'v' + (diff < 0 ? ' neg' : '')}>
                {t('memory.triage.footDiffVal', { n: signed(diff) })}
              </span>
            </div>
            <span className="note">{t('memory.triage.footNote')}</span>
            <CopyButton
              className="apply"
              text={joinInstructions(sec)}
              label={t('memory.triage.copyAll', { n: proposals.length })}
            />
          </div>
        )}
      </div>
    </div>
  );
}
