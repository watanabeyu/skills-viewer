import type { MemorySection, MemorySignal, MemoryTriage, SkillItem } from '../api';
import { MEM_COLOR, fmtMD } from '../util';
import { memoryTypeLabel, t } from '../i18n';

/*
 * memory の一覧 / 詳細 / 棚卸しで共用する小部品。
 * バッジの文字は kind バッジと同じく言語非依存(type 名そのまま)にし、意訳は tooltip に回す。
 */

/* frontmatter type のバッジ(.tbadge .t-<type>)。未指定なら出さない */
export function MemoryTypeBadge({ it }: { it: SkillItem }) {
  if (!it.memoryType) return null;
  return (
    <span className={'tbadge t-' + it.memoryType} title={memoryTypeLabel(it.memoryType)}>
      {it.memoryType}
    </span>
  );
}

/*
 * 「直近未参照」バッジ。トランスクリプトが無いプロジェクトでは判定不能なので出さない
 * (呼び出し側で usageAvailable を見て show を決める)。
 */
export function UnreadBadge({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span className="unread-badge" title={t('memory.unreadTitle')}>
      {t('memory.unread')}
    </span>
  );
}

/* 索引 N / 本文 N の組。桁は bold(カード・棚卸し行)か素のまま(詳細の左カラム)か */
export function TokFacts({ it, cls, bold }: { it: SkillItem; cls?: string; bold?: boolean }) {
  const idx = (it.indexTokens || 0).toLocaleString();
  const body = (it.bodyTokens || 0).toLocaleString();
  return (
    <>
      <span className={cls} title={t('memory.indexTokTitle')}>
        {t('memory.idx')} {bold ? <b>{idx}</b> : idx}
      </span>
      <span className={cls} title={t('memory.bodyTokTitle')}>
        {t('memory.body')} {bold ? <b>{body}</b> : body}
      </span>
    </>
  );
}

/* プロジェクト見出し「MEMORY — <project>」。skill の SectionHeading と同じ骨格(sq / lbl / n / sec-tok / ln) */
export function MemoryHeading({
  sec,
  count,
  tokLabel,
}: {
  sec: MemorySection;
  count: number;
  /* 索引トークンの表示文字列(一覧は「≈N tok/セッション」、詳細の左カラムは「≈N」) */
  tokLabel: string;
}) {
  return (
    <div className="sec-h">
      <span className="sq" style={{ background: MEM_COLOR }} />
      <span className="lbl">{t('memory.secLabel', { name: sec.projectName })}</span>
      <span className="n">{count}</span>
      {!!sec.indexTokens && (
        <span className="sec-tok" title={t('memory.secTokensTitle')}>
          {tokLabel}
        </span>
      )}
      {sec.orphan && (
        <span className="orphan-badge" title={t('memory.orphanTitle')}>
          {t('memory.orphan')}
        </span>
      )}
      <span className="ln" />
    </div>
  );
}

/*
 * 参照実績の 1 行(カードの usage 行)。Read 0 は異常ではないので言い切らず、
 * feedback 型は「索引行だけで機能している」と添える。計測不能なら数値を出さない。
 */
export function readsLine(it: SkillItem, usageAvailable: boolean): string {
  if (!usageAvailable) return t('memory.card.na');
  if (it.useCount) return t('memory.card.reads', { n: it.useCount, date: fmtMD(it.lastUsed) });
  return t(it.memoryType === 'feedback' ? 'memory.card.noReadsFeedback' : 'memory.card.noReads');
}

/* 鮮度(state)のバッジ。type バッジと同じく生値を出し、意訳は tooltip。出力不正・未診断には出さない */
export function MemoryStateBadge({ tri }: { tri?: MemoryTriage }) {
  if (!tri || tri.error || !tri.state) return null;
  return (
    <span
      className={'sbadge s-' + tri.state}
      title={t(`memory.state.${tri.state}.title` as Parameters<typeof t>[0])}
    >
      {tri.state}
    </span>
  );
}

/* 行き先に関わらず必ず見せる注意系(置き場所の誤り・索引と本文の食い違い) */
export const isWarnSignal = (s: MemorySignal) =>
  s.kind === 'other-project' || s.kind === 'index-mismatch';

/* 一覧では賑やかになりすぎるので出さない(正常な形を示すだけのシグナル) */
const HIDDEN_SIGNALS: MemorySignal['kind'][] = ['first-line-restates'];

const ICON: Partial<Record<MemorySignal['kind'], string>> = {
  date: '⏱',
  'path-missing': '⊘',
  'done-words': '✓',
  'branch-merged': '⎇',
  'branch-missing': '⎇',
  'how-restates': '¶',
  'why-episodic': '¶',
  'has-exception': '¶',
  'body-over': '¶',
};

export function signalLabel(s: MemorySignal): string {
  return t(`memory.signal.${s.kind}` as Parameters<typeof t>[0], {
    value: s.value,
    days: s.days ?? 0,
  });
}

/*
 * 機械シグナルのチップ。注意系(赤)を先に、事実(枠線だけ)を後に並べる。
 * AI の issues(灰色の塗り)と見分けられるように、事実は塗らない。max で一覧カード向けに絞る
 */
export function SignalChips({ signals, max }: { signals: MemorySignal[]; max?: number }) {
  const warns = signals.filter(isWarnSignal);
  const facts = signals.filter((s) => !isWarnSignal(s) && !HIDDEN_SIGNALS.includes(s.kind));
  const shown = [...warns, ...facts].slice(0, max ?? Infinity);
  if (!shown.length) return null;
  return (
    <div className="issues sigs">
      {shown.map((s, i) => (
        <span className={'issue ' + (isWarnSignal(s) ? 'warn' : 'fact')} key={s.kind + i}>
          {isWarnSignal(s) ? '⚠' : ICON[s.kind] || '·'} {signalLabel(s)}
        </span>
      ))}
    </div>
  );
}
