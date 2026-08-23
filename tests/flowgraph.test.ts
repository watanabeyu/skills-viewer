import { describe, expect, it } from 'vitest';
import { buildFlowGraph } from '../web/src/flowgraph';
import type { SkillFlow, SkillFlowStep } from '../src/shared/types';

const L = { yes: 'はい', no: 'いいえ', done: '完了' };

const step = (title: string, over: Partial<SkillFlowStep> = {}): SkillFlowStep => ({
  title,
  detail: '',
  calls: [],
  gate: null,
  branches: [],
  ...over,
});

describe('buildFlowGraph (抽出データ → フローチャート)', () => {
  it('開始・処理・完了の本線を組み立てる', () => {
    const flow: SkillFlow = { steps: [step('S1'), step('S2')] };
    const g = buildFlowGraph(flow, L);
    expect(g.rows.map((r) => r.node.kind)).toEqual(['start', 'proc', 'proc', 'end']);
    expect(g.edges.filter((e) => e.type === 'seq').map((e) => [e.from, e.to])).toEqual([
      ['start', 'p0'],
      ['p0', 'p1'],
      ['p1', 'end'],
    ]);
  });

  it('分岐は判断ノードになり、when に ? を補う(疑問形はそのまま)', () => {
    const flow: SkillFlow = {
      steps: [
        step('S1', { branches: [{ when: '欠落あり', then: '中止' }] }),
        step('S2', { branches: [{ when: '承認された?', then: '' }] }),
      ],
    };
    const g = buildFlowGraph(flow, L);
    const decs = g.rows.filter((r) => r.node.kind === 'dec').map((r) => r.node);
    expect(decs.map((d) => (d.kind === 'dec' ? d.when : ''))).toEqual(['欠落あり?', '承認された?']);
  });

  it('to なしの分岐は右レーンの中断カプセル + exit エッジ(はい)', () => {
    const flow: SkillFlow = {
      steps: [step('S1', { branches: [{ when: '欠落あり', then: '列挙して中止' }] })],
    };
    const g = buildFlowGraph(flow, L);
    const decRow = g.rows.find((r) => r.node.kind === 'dec');
    expect(decRow?.term?.label).toBe('⛔ 列挙して中止');
    const exit = g.edges.find((e) => e.type === 'exit');
    expect(exit).toMatchObject({ from: 'd0-0', to: 't0-0', label: 'はい' });
    // 判断ノードから本線へ抜ける辺は「いいえ」
    const seq = g.edges.find((e) => e.from === 'd0-0' && e.type === 'seq');
    expect(seq?.label).toBe('いいえ');
  });

  it('to ありの分岐はループエッジになり、行き先は該当ステップの処理ノード', () => {
    const flow: SkillFlow = {
      steps: [
        step('S1'),
        step('S2'),
        step('S3', { branches: [{ when: 'テスト失敗', then: '修正して再実行', to: 2 }] }),
      ],
    };
    const g = buildFlowGraph(flow, L);
    const loop = g.edges.find((e) => e.type === 'loop');
    expect(loop).toMatchObject({ from: 'd2-0', to: 'p1', label: '↩ 修正して再実行' });
    // ループ分岐には終端カプセルは付かない
    expect(g.rows.find((r) => r.node.id === 'd2-0')?.term).toBeUndefined();
  });

  it('範囲外の to は中断カプセルとして扱う(旧キャッシュ・壊れたデータ耐性)', () => {
    const flow: SkillFlow = {
      steps: [step('S1', { branches: [{ when: 'x', then: 'y', to: 9 }] })],
    };
    const g = buildFlowGraph(flow, L);
    expect(g.edges.some((e) => e.type === 'loop')).toBe(false);
    expect(g.edges.find((e) => e.type === 'exit')?.to).toBe('t0-0');
  });

  it('分岐の無い旧キャッシュでも本線 + 完了だけの図が成立する', () => {
    const flow: SkillFlow = { steps: [step('S1')] };
    const g = buildFlowGraph(flow, L);
    expect(g.rows.map((r) => r.node.kind)).toEqual(['start', 'proc', 'end']);
    expect(g.edges.every((e) => e.type === 'seq')).toBe(true);
  });
});
