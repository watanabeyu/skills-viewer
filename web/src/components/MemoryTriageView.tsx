import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  toId,
  triageMemory,
  type MemorySection,
  type MemoryTriage,
  type SkillItem,
  type SkillsData,
} from '../api';
import { copyText, fileName, memoryResolver, relDaysLabel, triageEstimate } from '../util';
import { memoryVerdictLabel, t } from '../i18n';
import { MemoryTypeBadge } from './GridView';

/*
 * memory 棚卸し診断の画面 + 詳細画面に埋めるブロック。
 * 判断は 3 層(機械 = 事実の提示 / AI = 行き先の仮説と指示文 / 人間 = 指示文を貼るかどうか)で、
 * viewer は採否の選択状態を持たない。操作はコピーだけ、実行は貼り先の Claude Code に委ねる。
 */

/* 試算の符号付き表記(0 は増減なしを明示するため ±0) */
const signed = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(n).toLocaleString();

const instructionsOf = (items: SkillItem[]) =>
  items.filter((it) => it.aiTriage && it.aiTriage.instruction);

/* 提案のある行だけを `## name` 見出し付きで連結(まとめてコピー用) */
const joinInstructions = (items: SkillItem[]) =>
  instructionsOf(items)
    .map((it) => '## ' + it.name + '\n\n' + it.aiTriage!.instruction)
    .join('\n\n');

function CopyButton({ text, label }: { text: string; label?: string }) {
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
    <button className="pbtn sm" onClick={onClick}>
      {done ? t('memory.triage.copied') : label || t('memory.triage.copy')}
    </button>
  );
}

/*
 * 削減試算は機械層で計算する(AI に数値を出させない)。
 * shrink は索引が変わらないので数値でなく文言だけを出す。
 */
function TriageEstimate({ it }: { it: SkillItem }) {
  if (it.aiTriage?.verdict === 'shrink')
    return <span className="triage-est">{t('memory.triage.estShrink')}</span>;
  const est = triageEstimate(it);
  if (!est) return null;
  return (
    <span className="triage-est">
      {t('memory.triage.estIndex', { n: signed(est.index) })}
      {est.always > 0 && ' · ' + t('memory.triage.estAlways', { n: est.always.toLocaleString() })}
    </span>
  );
}

export function TriageVerdictBadge({ verdict }: { verdict: MemoryTriage['verdict'] }) {
  return <span className={'triage-verdict v-' + verdict}>{memoryVerdictLabel(verdict)}</span>;
}

/* 診断結果の本体(行 / 詳細ブロックで共用)。指示文は折りたたまず全文を出す */
function TriageResult({ it }: { it: SkillItem }) {
  const tri = it.aiTriage;
  if (!tri) return null;
  return (
    <>
      <div className="triage-head">
        <TriageVerdictBadge verdict={tri.verdict} />
        <TriageEstimate it={it} />
      </div>
      {tri.reason && <p className="triage-reason">{tri.reason}</p>}
      {!!tri.issues.length && (
        <div className="triage-issues">
          {/* 同じ文言が 2 件返り得るので key は index(並びは AI 出力のまま固定) */}
          {tri.issues.map((issue, i) => (
            <span className="triage-issue" key={i}>
              {issue}
            </span>
          ))}
        </div>
      )}
      {tri.instruction && (
        <div className="triage-instr">
          <div className="triage-instr-t">{t('memory.triage.instruction')}</div>
          <pre className="triage-instr-body">{tri.instruction}</pre>
          <CopyButton text={tri.instruction} />
        </div>
      )}
    </>
  );
}

/* 機械層の事実。未診断でもここだけは常に出す(Read 0 は異常ではないので強調しない) */
function TriageFacts({ it, sec, broken }: { it: SkillItem; sec: MemorySection; broken: number }) {
  return (
    <span className="triage-facts">
      <span title={t('memory.indexTokTitle')}>
        {t('memory.indexTok', { n: (it.indexTokens || 0).toLocaleString() })}
      </span>
      <span title={t('memory.bodyTokTitle')}>
        {t('memory.bodyTok', { n: (it.bodyTokens || 0).toLocaleString() })}
      </span>
      <span>{relDaysLabel(it.updatedAt)}</span>
      {sec.usageAvailable && (
        <>
          <span title={t('memory.readsTitle')}>{t('memory.reads', { n: it.useCount || 0 })}</span>
          <span title={t('memory.writesTitle')}>
            {t('memory.writes', { n: it.writeCount || 0 })}
          </span>
        </>
      )}
      {broken > 0 && (
        <span className="triage-broken" title={t('memory.triage.brokenTitle')}>
          {t('memory.triage.broken', { n: broken })}
        </span>
      )}
    </span>
  );
}

/*
 * 詳細画面に出す 1 件分の棚卸し診断ブロック(diag-box と同じ枠構造)。
 * API は一覧と同じ /api/memory-triage で、files に自分 1 件だけを渡す。
 * 結果は同じ件単位キャッシュに載るので、一覧側の診断とも共有される。
 */
export function MemoryTriageBlock({
  it,
  sec,
  reload,
}: {
  it: SkillItem;
  sec: MemorySection;
  reload: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const tri = it.aiTriage;

  const run = async () => {
    setBusy(true);
    try {
      // 既に診断済みなら force。内容が変わっていない限りキャッシュが返るため
      await triageMemory(sec.id, [fileName(it.path)], !!tri);
      await reload();
    } catch (e) {
      alert(t('alert.triageFailed', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="triage-block">
      {tri && (
        <div className="triage-box">
          <TriageResult it={it} />
          <button
            className="triage-whole"
            onClick={() =>
              navigate({ pathname: '/memory/triage/' + sec.id, search: params.toString() })
            }
          >
            {t('memory.triage.whole')}
          </button>
        </div>
      )}
      <button
        className="pbtn sm"
        disabled={busy}
        onClick={run}
        title={t(tri ? 'memory.triage.rerunTitle' : 'memory.triage.runTitle')}
      >
        {busy
          ? t('memory.triage.running')
          : tri
            ? t('memory.triage.rerun')
            : '✦ ' + t('memory.triage.heading')}
      </button>
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

  const sec = (data.memory || []).find((s) => s.id === project);
  // 存在しないプロジェクト(削除・リネーム後の共有 URL)は一覧へ戻す
  if (!sec) return <Navigate to={{ pathname: '/', search: params.toString() }} replace />;

  const untriaged = sec.items.some((it) => !it.aiTriage);
  const proposals = instructionsOf(sec.items);
  const totals = sec.items.reduce(
    (acc, it) => {
      const est = triageEstimate(it);
      return est ? { index: acc.index + est.index, always: acc.always + est.always } : acc;
    },
    { index: 0, always: 0 },
  );

  const run = async () => {
    setBusy(true);
    try {
      // 未診断が残っていれば差分診断、全件診断済みなら force で全件を診断し直す
      await triageMemory(sec.id, undefined, !untriaged);
      await reload();
    } catch (e) {
      alert(t('alert.triageFailed', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const resolve = memoryResolver(sec.items);
  const broken = (it: SkillItem) => (it.links || []).filter((n) => !resolve(n)).length;

  return (
    <div className="pane triage-pane">
      <button
        className="back"
        onClick={() => navigate({ pathname: '/', search: params.toString() })}
      >
        {t('detail.back')}
      </button>
      <div className="meta-row">
        <span className="mem-proj">
          {sec.projectName}
          {sec.orphan && (
            <span className="orphan-badge" title={t('memory.orphanTitle')}>
              {t('memory.orphan')}
            </span>
          )}
        </span>
        <span className="mem-fact">{t('memory.triage.items', { n: sec.items.length })}</span>
        <span className="mem-fact" title={t('memory.secTokensTitle')}>
          {t('memory.secTokens', { n: sec.indexTokens.toLocaleString() })}
        </span>
      </div>
      <h2 className="d-name">{t('memory.triage.heading')}</h2>
      <p className="triage-lead">{t('memory.triage.lead')}</p>
      <div className="triage-actions">
        <button
          className="pbtn sm"
          disabled={busy}
          onClick={run}
          title={t(untriaged ? 'memory.triage.runTitle' : 'memory.triage.rerunTitle')}
        >
          {busy
            ? t('memory.triage.running')
            : untriaged
              ? '✦ ' + t('memory.triage.run')
              : t('memory.triage.rerun')}
        </button>
        {untriaged && <span className="triage-note">{t('memory.triage.pending')}</span>}
        {!untriaged && !proposals.length && (
          <span className="triage-note">{t('memory.triage.noProposals')}</span>
        )}
      </div>
      <div className="triage-list">
        {sec.items.map((it) => (
          <div className="triage-row" key={it.path}>
            <div className="r1">
              <button
                className="nm"
                onClick={() =>
                  navigate({ pathname: '/memory/' + toId(it.path), search: params.toString() })
                }
              >
                {it.name}
              </button>
              <MemoryTypeBadge it={it} />
              <TriageFacts it={it} sec={sec} broken={broken(it)} />
            </div>
            <TriageResult it={it} />
          </div>
        ))}
      </div>
      {!!proposals.length && (
        <div className="triage-foot">
          <CopyButton
            text={joinInstructions(sec.items)}
            label={t('memory.triage.copyAll', { n: proposals.length })}
          />
          <span className="triage-total">
            {t('memory.triage.totalIndex', { n: signed(totals.index) })}
            {totals.always > 0 &&
              t('memory.triage.totalAlways', { n: totals.always.toLocaleString() })}
          </span>
        </div>
      )}
    </div>
  );
}
