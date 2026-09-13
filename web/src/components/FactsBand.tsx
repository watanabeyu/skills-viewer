/*
 * 理解画面の「事実の帯」(design-system 1.3)。1 行で読める事実だけを 4 マスに置く:
 *   使用実績(+ スパークライン)/ 追加・更新(既読基準 + git)/ 同名の定義 / ファイル。
 * 幅 1280 未満でも 4 マスのまま(0.8)。寸法は docs/design/0.9.0/{Ledger,Console}Understand.dc.html の
 * 実測(style.css の --fact-* トークン)。同名の diff はこの帯から開く(README 6.2)。
 * FactCell は hook 画面(HookView)と CLAUDE.md 画面(E2)も使う。
 */

import { useState, type ReactNode } from 'react';
import type { SkillsData } from '../api';
import { historyOf, shortPath } from '../detail';
import { fileName, fmtDate, sameNameOthers, type FlatItem } from '../util';
import { t } from '../i18n';
import { Mark, SourceDot } from './Rows';
import { SameNameDiff } from './FullText';

export function FactCell({
  label,
  mark,
  children,
}: {
  label: string;
  /* 差分に載っている項目は見出しの脇に + / ~ を添える(0.3) */
  mark?: 'add' | 'mod' | null;
  children: ReactNode;
}) {
  return (
    <div className="fact">
      <span className="fk">
        {label}
        {mark && <Mark mark={mark} small />}
      </span>
      {children}
    </div>
  );
}

/*
 * 直近 30 日の日別使用回数(幅 120 × 高さ 16、棒 3px、本文色 60%。1.4 の部品)。
 * 日付キーはサーバー(usage.ts の dayKey)と同じローカルタイムゾーンの YYYY-MM-DD。
 */
export function Sparkline({ daily }: { daily: Record<string, number> }) {
  const DAYS = 30;
  const STEP = 4;
  const BAR = 3;
  const H = 16;
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const days: { key: string; n: number }[] = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    days.push({ key, n: daily[key] || 0 });
  }
  const max = Math.max(...days.map((d) => d.n), 1);
  return (
    <svg
      className="spark"
      width={DAYS * STEP}
      height={H}
      viewBox={`0 0 ${DAYS * STEP} ${H}`}
      role="img"
      aria-label={t('detail.spark')}
    >
      {days.map((d, i) => {
        if (!d.n) return null;
        const h = Math.max(4, Math.round((d.n / max) * H));
        return (
          <rect key={d.key} x={i * STEP} y={H - h} width={BAR} height={h}>
            <title>{`${d.key}: ${d.n}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

/* 追加・更新の 2 行。git が引けた変化は「誰が・いつ」、それ以外は更新日だけ(README 6.3) */
export function HistoryLines({
  it,
  changes,
}: {
  it: Pick<FlatItem, 'path' | 'kind' | 'updatedAt'>;
  changes: SkillsData['changes'];
}) {
  const h = historyOf(it, changes);
  const who =
    h.who && h.when
      ? t(h.mark === 'add' ? 'fact.addedBy' : 'fact.updatedBy', {
          who: h.who,
          date: fmtDate(h.when),
        })
      : '';
  const updated = h.updatedAt ? t('fact.updated', { date: fmtDate(h.updatedAt) }) : '—';
  return (
    <>
      {who && <span className="fv-sub">{who}</span>}
      <span className={who ? 'meta mono' : 'fv-sub mono'}>{updated}</span>
    </>
  );
}

const FILES_MAX = 4;

export function FactsBand({
  it,
  data,
  all,
  onOpen,
}: {
  it: FlatItem;
  data: SkillsData;
  all: FlatItem[];
  onOpen: (key: string) => void;
}) {
  const [diffWith, setDiffWith] = useState<FlatItem | null>(null);
  const usage = data.usageAvailable && it.kind !== 'hook';
  const others = sameNameOthers(it, all);
  // files には SKILL.md 自身が含まれることもあるので重複を寄せる(command / agent は単独の .md)
  const files = [...new Set([...(it.hasMd ? [fileName(it.path)] : []), ...it.files])];
  const dir = it.path ? shortPath(it.path.replace(/[\\/][^\\/]+$/, ''), data.cwd, data.home) : '';
  const mark = historyOf(it, data.changes).mark;
  return (
    <div className="facts-wrap">
      <div className="dblk facts">
        <FactCell label={t('fact.usage')}>
          {usage ? (
            <>
              <span className="fv">
                {(it.useCount || 0).toLocaleString()}
                <span className="meta">
                  {' '}
                  {t('fact.usageNote', { typed: it.typedCount || 0, auto: it.autoCount || 0 })}
                </span>
              </span>
              <Sparkline daily={it.dailyUse || {}} />
              {it.lastUsed ? (
                <span className="meta mono">{t('fact.last', { date: fmtDate(it.lastUsed) })}</span>
              ) : (
                <span className="warn-inline" title={t('badge.unusedTitle')}>
                  ⚠ {t('badge.unused')}
                </span>
              )}
            </>
          ) : (
            <span className="meta">{t('fact.noUsage')}</span>
          )}
        </FactCell>
        <FactCell label={t('fact.history')} mark={mark}>
          <HistoryLines it={it} changes={data.changes} />
        </FactCell>
        <FactCell label={t('fact.sameName')}>
          {others.length ? (
            others.map((o) => (
              <span className="fv-line" key={o.key}>
                <SourceDot source={o.source} />
                <button className="link" onClick={() => onOpen(o.key)}>
                  {o.scopeLabel}
                </button>
                {it.hasMd && o.hasMd && (
                  <button
                    className={'linkbtn meta' + (diffWith?.key === o.key ? ' on' : '')}
                    onClick={() => setDiffWith(diffWith?.key === o.key ? null : o)}
                  >
                    {diffWith?.key === o.key ? t('detail.diffClose') : t('detail.diff')}
                  </button>
                )}
              </span>
            ))
          ) : (
            <span className="meta">{t('fact.sameNone')}</span>
          )}
        </FactCell>
        <FactCell label={t('fact.files')}>
          {files.length > 0 && (
            <span className="fv-files mono">
              {files.slice(0, FILES_MAX).map((f) => (
                <span key={f}>{f}</span>
              ))}
              {files.length > FILES_MAX && (
                <span className="meta">{t('fact.filesMore', { n: files.length - FILES_MAX })}</span>
              )}
            </span>
          )}
          <span className="meta mono ellip" title={it.path}>
            {dir || t('detail.builtinLocation')}
          </span>
        </FactCell>
      </div>
      {diffWith && (
        <div className="dv-diff">
          {/* 同名の別定義は別プロジェクトにあり得るので、読み取りの起点(選んだプロジェクト)を渡す */}
          <SameNameDiff a={it} b={diffWith} selected={data.selected.id} />
        </div>
      )}
    </div>
  );
}
