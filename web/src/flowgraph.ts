/*
 * AI フロー図解: 抽出データ(直列 steps + 分岐注記)をフローチャートのグラフに写像する。
 * 描画(FlowDiagram.tsx)から分離した純粋ロジック。docs/plans/09 の変換ルール:
 * - step → 処理ノード
 * - branch → 直後の判断ノード(ひし形)。when を「〜?」の問いとして表示し、
 *   はい = 分岐発動(ループ or 終端へ)、いいえ = 本線を続行
 * - branch.to あり → ループ/スキップエッジ(行き先 step の処理ノードへ)
 * - branch.to なし → 右レーンの中断カプセルへ抜ける
 * - 最終ノードの下に完了カプセル
 */

import type { SkillFlow, SkillFlowStep } from '../../src/shared/types';

export type FlowNode =
  | { kind: 'start'; id: string }
  | { kind: 'proc'; id: string; step: SkillFlowStep; index: number }
  | { kind: 'dec'; id: string; when: string }
  | { kind: 'end'; id: string; label: string };

/* 右レーンの終端カプセル(中断) */
export interface FlowTerm {
  id: string;
  label: string;
}

export interface FlowRow {
  node: FlowNode;
  term?: FlowTerm;
}

export interface FlowEdge {
  from: string;
  to: string;
  type: 'seq' | 'loop' | 'exit';
  label: string;
}

export interface FlowGraph {
  rows: FlowRow[];
  edges: FlowEdge[];
}

/* 表示言語の語彙(i18n は呼び出し側で解決し、この層は言語非依存に保つ) */
export interface FlowLabels {
  yes: string;
  no: string;
  done: string;
}

/* when を判断ノードの問いに整形(すでに疑問形ならそのまま) */
const question = (when: string): string => (/[?？]$/.test(when) ? when : when + '?');

export function buildFlowGraph(flow: SkillFlow, labels: FlowLabels): FlowGraph {
  const rows: FlowRow[] = [{ node: { kind: 'start', id: 'start' } }];
  const edges: FlowEdge[] = [];

  flow.steps.forEach((step, i) => {
    rows.push({ node: { kind: 'proc', id: `p${i}`, step, index: i } });
    step.branches.forEach((b, j) => {
      const decId = `d${i}-${j}`;
      const row: FlowRow = { node: { kind: 'dec', id: decId, when: question(b.when) } };
      if (b.to !== undefined && b.to >= 1 && b.to <= flow.steps.length) {
        edges.push({
          from: decId,
          to: `p${b.to - 1}`,
          type: 'loop',
          label: '↩ ' + (b.then || labels.yes),
        });
      } else {
        const termId = `t${i}-${j}`;
        row.term = { id: termId, label: '⛔ ' + (b.then || b.when) };
        edges.push({ from: decId, to: termId, type: 'exit', label: labels.yes });
      }
      rows.push(row);
    });
  });

  rows.push({ node: { kind: 'end', id: 'end', label: '✓ ' + labels.done } });

  // 本線(seq): start → p0 → (判断列) → … → end。判断ノードから下へ抜ける辺は「いいえ」
  for (let k = 0; k + 1 < rows.length; k++) {
    const from = rows[k].node;
    edges.push({
      from: from.id,
      to: rows[k + 1].node.id,
      type: 'seq',
      label: from.kind === 'dec' ? labels.no : '',
    });
  }

  return { rows, edges };
}
