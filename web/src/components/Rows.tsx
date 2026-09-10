/*
 * 一覧の行と部品(design-system 1.4)。ホーム ③「効いているもの」と「すべてのプロジェクト」の
 * 「置かれているもの」が同じ行を使う。寸法はモック(docs/design/0.9.0/{Ledger,Console}Home.dc.html)の
 * inline style から実測し、style.css のトークン(--trow-h / --col-* など)に置いた。
 *
 * 押せる / 押せないの規則(0.4): 行そのものは押せる(<button>)。行の中の kind / 出所 / 発動は
 * 罫線なしの薄い地(.pill)で、塗り(反転)は使わない。
 */

import { useEffect, useState } from 'react';
import type { ItemKind, SkillItem, Source } from '../api';
import { itemKey } from '../api';
import {
  MARK_CHAR,
  SRC_COLOR,
  invocationLabel,
  invocationOf,
  invocationTitle,
  isUnused,
  type ChangeMark,
  type PurposeGroup,
} from '../util';
import { lintLabel, t } from '../i18n';

/* ---- v0.8 から引き継ぐバッジ(「すべてのプロジェクト」の用途別が使う) ---- */

/* hover で警告内容を CSS tooltip 表示(native title より視認性が高い) */
export function WarnBadge({ it }: { it: SkillItem }) {
  if (!it.lint?.length) return null;
  return (
    <span className="warn-badge">
      ⚠ {it.lint.length}
      <span className="tip">
        <span className="tip-t">{t('badge.warnTitle')}</span>
        {it.lint.map((code) => (
          <span key={code} className="tip-line">
            {lintLabel(code)}
          </span>
        ))}
      </span>
    </span>
  );
}

export function GroupHeading({
  g,
  count,
  small,
  sub,
}: {
  g: PurposeGroup;
  count: number;
  small?: boolean;
  /* セクション見出しの配下に出す小見出し(sticky 無し・インデント付き) */
  sub?: boolean;
}) {
  return (
    <div className={'sec-h' + (small ? ' sm' : '') + (sub ? ' sub' : '')}>
      <span className="g-emoji">{g.emoji || (g.manual ? '📌' : '📁')}</span>
      <span className="lbl">{g.label}</span>
      {g.manual && (
        <span className="g-manual" title={t('group.manualTitle')}>
          {t('group.manual')}
        </span>
      )}
      <span className="n">{count}</span>
      <span className="ln" />
    </div>
  );
}

/* ---- v0.9.0 の部品 ---- */

/*
 * 幅 1280 未満(design-system 0.8 の「中」)。列落としは CSS の @media で行い、
 * ここは文言の差し替え(検索のプレースホルダ・見出しの説明)にだけ使う。
 */
const NARROW = '(max-width: 1280px)';
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => {
    try {
      return matchMedia(NARROW).matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    const mq = matchMedia(NARROW);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

/* 出所の CSS クラス名(built-in の '-' を落とす) */
const srcClass = (s: Source) => 'src-' + s.replace('-', '');

/* kind のチップ(0.4b の語彙。CLAUDE.md は差分にだけ現れる) */
export function KindPill({ kind }: { kind: ItemKind }) {
  return <span className="pill">{kind === 'claude-md' ? t('kind.claudeMd') : kind}</span>;
}

/* 出所のチップ。project は面(強)+ 本文色、user / plugin / built-in は tint + その色(0.1) */
export function SourcePill({ source, label }: { source: Source; label: string }) {
  return <span className={'pill ' + srcClass(source)}>{label}</span>;
}

/* 発動のチップ。実測は本文色の太字(.measured)、AI 推定は ✦、呼べないは hidden */
export function InvPill({ it }: { it: SkillItem }) {
  if (it.hidden)
    return (
      <span className="pill" title={t('invocation.hiddenTitle')}>
        {t('invocation.hidden')}
      </span>
    );
  const inv = invocationOf(it);
  if (!inv) return null;
  return (
    <span
      className={'pill' + (inv.basis === 'measured' ? ' measured' : '')}
      title={invocationTitle(it)}
    >
      {invocationLabel(inv.kind)}
      {inv.basis === 'ai' ? ' ✦' : ''}
    </span>
  );
}

/* 変化の記号(0.3)。Ledger は線だけの丸、Console は等幅の文字 — 差はトークン(--mark-*) */
export function Mark({ mark, small }: { mark: ChangeMark; small?: boolean }) {
  return <span className={'mark ' + mark + (small ? ' sm' : '')}>{MARK_CHAR[mark]}</span>;
}

/* トークン比のバー(高さ 4px)。超過は警告色。上限のない行では呼ばない(0.5) */
export function Bar({ ratio, over }: { ratio: number; over: boolean }) {
  return (
    <span className="bar">
      <span className={over ? 'over' : ''} style={{ width: Math.min(100, ratio * 100) + '%' }} />
    </span>
  );
}

/* 出所の点(project は本文色) */
export function SourceDot({ source }: { source: Source }) {
  return <span className="dot" style={{ background: SRC_COLOR[source] }} />;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className="chev"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      {open ? <path d="M3 4.5l3 3 3-3" /> : <path d="M4.5 3l3 3-3 3" />}
    </svg>
  );
}

/*
 * 出所ごとの見出し(開閉の山形 + 出所色の点 + 名前 + 件数などの注記 + 右端 tok)。
 * 押せるので <button>。畳んだ状態でも件数と tok が読める(1.2)
 */
export function GroupHead({
  open,
  onToggle,
  source,
  name,
  meta,
  tok,
  note,
}: {
  open: boolean;
  onToggle: () => void;
  source: Source;
  name: string;
  meta: string;
  tok: number;
  /* 見出しの 2 行目に出す注記(0 件の理由など)。表の行にしない(1.4 の骨格) */
  note?: string;
}) {
  return (
    <button className="ghead" onClick={onToggle} aria-expanded={open}>
      <span className="ghead-line">
        <Chevron open={open} />
        <SourceDot source={source} />
        <span className="gname">{name}</span>
        <span className="meta">{meta}</span>
        <span className="num meta gtok">{t('act.tok', { n: tok.toLocaleString() })}</span>
      </span>
      {note && <span className="gnote">{note}</span>}
    </button>
  );
}

/* 表ヘッダ。使用列はトランスクリプトがあるときだけ(README 6.3) */
export function TableHead({ usage }: { usage: boolean }) {
  return (
    <div className={'trow thead' + (usage ? '' : ' no-uses')}>
      <span>{t('col.name')}</span>
      <span>{t('col.kind')}</span>
      <span>{t('col.source')}</span>
      <span>{t('col.invoke')}</span>
      {usage && <span className="num c-uses">{t('col.uses')}</span>}
      <span className="num c-tok">{t('col.tok')}</span>
    </div>
  );
}

/*
 * 一覧の 1 行 = 名前と説明 / kind / 出所 / 発動 / 使用 / tok。
 * 変化の記号は名前の脇に小さく(① と同じ文法)。未使用と lint は警告色の文字で(0.2)
 */
export function ItemRow({
  it,
  source,
  scopeLabel,
  mark,
  usage,
  onOpen,
}: {
  it: SkillItem;
  source: Source;
  scopeLabel: string;
  mark: 'add' | 'mod' | null;
  usage: boolean;
  onOpen: (key: string) => void;
}) {
  return (
    <button className={'trow' + (usage ? '' : ' no-uses')} onClick={() => onOpen(itemKey(it))}>
      <span className="cell">
        <span className="nm">
          {it.name}
          {mark && <Mark mark={mark} small />}
          {isUnused(it, usage) && (
            <span className="warn-inline" title={t('badge.unusedTitle')}>
              ⚠ {t('badge.unusedShort')}
            </span>
          )}
          <WarnBadge it={it} />
        </span>
        <span className="desc">
          {it.aiSummary && <span className="ai-mark">✦ </span>}
          {it.aiSummary || it.description}
        </span>
      </span>
      <span>
        <KindPill kind={it.kind} />
      </span>
      <span>
        <SourcePill source={source} label={scopeLabel} />
      </span>
      <span>
        <InvPill it={it} />
      </span>
      {usage && (
        <span className={'num c-uses' + (it.useCount ? '' : ' meta')}>
          {it.kind === 'hook' ? '' : it.useCount ? it.useCount.toLocaleString() : '—'}
        </span>
      )}
      <span className="num sub c-tok">{it.tokens ? it.tokens.toLocaleString() : ''}</span>
    </button>
  );
}
