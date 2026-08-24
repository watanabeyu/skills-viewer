import type { MemorySection, SkillItem } from '../api';
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

/*
 * セクション見出し・棚卸しタイトルに共通で出す副題 1 行(フルパス)。
 * projectName は basename 由来で同名プロジェクト(teamA/ai-workspace と teamB/ai-workspace)を
 * 区別できないため、見出しの下に必ずフルパスを添える。プロジェクト不明は逆引き先が無いので
 * memory ディレクトリの実パス(note)を、プロジェクトのパスと誤読されないよう別ラベルで出す。
 */
export function MemoryPathSub({ sec }: { sec: MemorySection }) {
  const p = sec.projectPath ?? sec.note;
  return (
    <div className="path-sub" title={p}>
      {t(sec.projectPath ? 'memory.secPath' : 'memory.secMemDir', { path: p })}
    </div>
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
    <>
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
      <MemoryPathSub sec={sec} />
    </>
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
