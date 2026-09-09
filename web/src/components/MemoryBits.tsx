/*
 * memory 一覧・詳細で共用する小部品(計画 15 Phase F)。値の決め方は ../memory.ts(純粋ロジック)にあり、
 * ここは見た目だけ。押せないラベルは罫線なしのチップ(.pill)、鮮度と診断は色だけで分ける文字(design-system 0.4)。
 */

import type { MemorySection, MemorySignal, MemoryTriage, SkillItem } from '../api';
import { triageMemory } from '../api';
import { fileName } from '../util';
import { STATE_TONE, VERDICT_TONE, freshnessOf, verdictWord } from '../memory';
import { memorySignalLabel, memoryStateLabel, memoryTypeLabel, memoryWordLabel, t } from '../i18n';

/* frontmatter type のチップ。文字は type 名そのまま(言語非依存)、意訳は tooltip。未指定なら出さない */
export function MemoryTypePill({ it }: { it: SkillItem }) {
  if (!it.memoryType) return null;
  return (
    <span className="pill" title={memoryTypeLabel(it.memoryType)}>
      {it.memoryType}
    </span>
  );
}

/* 鮮度「● 現行」。色は状態色(良好 / 警告 / 副文 / 危険)、根拠(AI / 機械)は tooltip */
export function StateDot({ it }: { it: SkillItem }) {
  const f = freshnessOf(it);
  return (
    <span
      className={'mstate tone-' + STATE_TONE[f.state]}
      title={t(f.basis === 'ai' ? 'memory.state.byAi' : 'memory.state.byMachine')}
    >
      ● {memoryStateLabel(f.state)}
    </span>
  );
}

/* 診断列の 4 語。未診断は「—」(補足色)。太さは揃え、色だけで分ける */
export function VerdictWordCell({ tri }: { tri?: MemoryTriage }) {
  const w = verdictWord(tri);
  if (!w) return <span className="meta">—</span>;
  return <span className={'mword tone-' + VERDICT_TONE[w]}>{memoryWordLabel(w)}</span>;
}

/* 機械シグナルの 1 行(kind のチップ + 文言)。詳細の診断「シグナル」行で使う */
export function SignalLine({ s }: { s: MemorySignal }) {
  return (
    <span className="msig">
      <span className="pill msig-k">{s.kind}</span>
      <span className="sub">{memorySignalLabel(s)}</span>
    </span>
  );
}

/*
 * Read / Write など transcript 由来の回数表示に付ける tooltip。共有ストア
 * (user scope の autoMemoryDirectory)の回数は全プロジェクトの transcript を横断した
 * 合算なので、「このプロジェクトでの回数」と誤読されないよう注記を添える。
 */
export function usageTitle(sec: MemorySection, base?: string): string | undefined {
  const parts = [base, sec.sharedStore ? t('memory.usage.sharedTitle') : ''].filter(Boolean);
  return parts.length ? parts.join('\n') : undefined;
}

/*
 * 棚卸しの実行。プロジェクト単位(it 省略)は未診断が残っていれば差分診断、全件診断済みなら force で診断し直す。
 * 1 件(詳細)は診断済みなら force。どちらも既存 POST /api/memory-triage で、結果は再取得で aiTriage に載る。
 */
export const runTriage = (sec: MemorySection, it?: SkillItem) =>
  it
    ? triageMemory(sec.id, [fileName(it.path)], !!it.aiTriage)
    : triageMemory(
        sec.id,
        undefined,
        sec.items.every((x) => !!x.aiTriage),
      );
