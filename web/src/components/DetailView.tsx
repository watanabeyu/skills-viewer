/*
 * 理解画面(/skills/:id。計画 15 Phase E1 / README 6.2)。受け取る人の主ジョブ「これは何をどう動かすか」に
 * 1 列で上から答える: 要約 → 事実の帯 → 発動(診断を畳む)→ 触るもの → 流れ → 全文。
 * 右カラム・タブ(tab=md|flow)・独立した診断セクションは持たない。書き込み系のボタンは無く、
 * 残るのは「エディタで開く」と指示文のコピー、AI 生成(要約 / 診断 / 抽出)だけ。
 * hook(kind === 'hook')は簡易版(HookView)。
 *
 * 分割: TitleBlock(ここ)/ FactsBand / InvokeBlock / TouchesBlock / FlowDiagram(FlowBlock)/ FullText。
 * 寸法は docs/design/0.9.0/{Ledger,Console}Understand.dc.html の実測(style.css の --dv-* / --dblk-* トークン)。
 */

import { useState } from 'react';
import { Navigate, useParams, useSearchParams } from 'react-router-dom';
import { fromId, openSkill, summarizeSkill, type SkillsData } from '../api';
import { makeResolve } from '../detail';
import { isUnused, type FlatItem } from '../util';
import { editorUrl, loadEditorSetting } from '../settings';
import { t } from '../i18n';
import { InlineError, InlineNote } from './Inline';
import { InvPill, KindPill, SourcePill, WarnBadge } from './Rows';
import { FactsBand } from './FactsBand';
import { InvokeBlock } from './InvokeBlock';
import { TouchesBlock } from './TouchesBlock';
import { FlowBlock } from './FlowDiagram';
import { FullTextBlock, useMdText } from './FullText';
import { HookView } from './HookView';

export { clearMdCache } from './FullText';

export function DetailView({
  data,
  all,
  onOpen,
  reload,
}: {
  data: SkillsData;
  all: FlatItem[];
  onOpen: (key: string) => void;
  reload: () => Promise<void>;
}) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const it = all.find((x) => x.key === fromId(id || ''));
  if (!it) return <Navigate to={{ pathname: '/', search: params.toString() }} replace />;
  return (
    <div className="dv">
      <TitleBlock it={it} data={data} reload={reload} />
      {it.kind === 'hook' ? (
        <HookView it={it} data={data} all={all} onOpen={onOpen} />
      ) : (
        <SkillBody it={it} data={data} all={all} onOpen={onOpen} reload={reload} />
      )}
    </div>
  );
}

/* skill / command / agent の本体(要約の下)。built-in は path が無いので流れと全文を持たない */
function SkillBody({
  it,
  data,
  all,
  onOpen,
  reload,
}: {
  it: FlatItem;
  data: SkillsData;
  all: FlatItem[];
  onOpen: (key: string) => void;
  reload: () => Promise<void>;
}) {
  const { raw, error } = useMdText(it.hasMd ? it.path : '');
  const dir = data.sections.find((s) => s.id === it.secId)?.note || '';
  return (
    <>
      <FactsBand it={it} data={data} all={all} onOpen={onOpen} />
      <InvokeBlock it={it} dir={dir} data={data} reload={reload} />
      <TouchesBlock it={it} all={all} onOpen={onOpen} />
      {it.hasMd && (
        <FlowBlock
          it={it}
          raw={raw}
          resolve={makeResolve(it, all)}
          aiAvailable={data.aiAvailable}
          onOpen={onOpen}
          reload={reload}
        />
      )}
      {it.hasMd && <FullTextBlock it={it} raw={raw} error={error} cwd={data.cwd} />}
    </>
  );
}

function EditorIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M6 3H3v10h10v-3M9 3h4v4M13 3L7 9" />
    </svg>
  );
}

/*
 * 名前とチップ、右端に「エディタで開く」。その下に ✦ 一言要約と description 全文。
 * hook は description がコマンドそのもの(コマンドのブロックで出す)なので本文行を出さない
 */
function TitleBlock({
  it,
  data,
  reload,
}: {
  it: FlatItem;
  data: SkillsData;
  reload: () => Promise<void>;
}) {
  const [summarizing, setSummarizing] = useState(false);
  // 操作起点の失敗はボタンの脇に 1 行で出す(alert は使わない)
  const [openError, setOpenError] = useState('');
  const [summaryError, setSummaryError] = useState('');

  const onOpenEditor = async () => {
    // 設定(⚙)の URL スキームで開く。OS デフォルト設定時のみサーバー側で開く
    setOpenError('');
    const url = editorUrl(loadEditorSetting(), it.path);
    if (url) {
      window.location.href = url;
      return;
    }
    try {
      await openSkill(it.path);
    } catch (e) {
      setOpenError(t('alert.openFailed', { msg: e instanceof Error ? e.message : String(e) }));
    }
  };
  const onSummarize = async () => {
    setSummarizing(true);
    setSummaryError('');
    try {
      await summarizeSkill(it.path, it.name);
      await reload();
    } catch (e) {
      setSummaryError(
        t('alert.summarizeFailed', { msg: e instanceof Error ? e.message : String(e) }),
      );
    } finally {
      setSummarizing(false);
    }
  };

  return (
    <div className="dv-title">
      <div className="dv-title-row">
        <h1>{it.name}</h1>
        <KindPill kind={it.kind} />
        <SourcePill source={it.source} label={it.scopeLabel} />
        <InvPill it={it} />
        {it.version && <span className="meta mono">v{it.version}</span>}
        {isUnused(it, data.usageAvailable) && (
          <span className="warn-inline" title={t('badge.unusedTitle')}>
            ⚠ {t('badge.unusedShort')}
          </span>
        )}
        <WarnBadge it={it} />
        <span className="dv-title-r">
          <InlineError msg={openError} />
          <InlineError msg={summaryError} />
          {it.hasMd && !data.aiAvailable && <InlineNote msg={t('ai.unavailable')} />}
          {it.hasMd && (
            <button
              className="btn quiet"
              disabled={summarizing || !data.aiAvailable}
              onClick={onSummarize}
              title={t('ai.buttonTitle')}
            >
              {summarizing ? t('detail.summarizing') : '✦ ' + t('detail.resummarize')}
            </button>
          )}
          {!!it.path && (
            <button className="btn" onClick={onOpenEditor}>
              <EditorIcon />
              {t('detail.openEditor')}
            </button>
          )}
        </span>
      </div>
      {it.aiSummary && (
        <p className="dv-summary">
          <span className="ai-mark">✦ </span>
          {it.aiSummary}
        </p>
      )}
      {it.kind !== 'hook' && it.description && <p className="dv-desc">{it.description}</p>}
    </div>
  );
}
