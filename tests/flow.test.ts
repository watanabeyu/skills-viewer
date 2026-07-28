import { describe, expect, it } from 'vitest';
import { parseFlow } from '../src/server/flow';

describe('parseFlow (フロー抽出出力のパース)', () => {
  it('正常な JSON を構造化して返す', () => {
    const out = parseFlow(
      JSON.stringify({
        steps: [
          {
            title: 'ready 判定',
            detail: '必須節を検証',
            calls: [],
            gate: 'auto',
            branches: [{ when: '欠落あり', then: '列挙して中止' }],
          },
          { title: '実装指示投入', detail: 'weall-feature へ委譲', calls: ['weall-feature'] },
        ],
      }),
    );
    expect(out.steps).toHaveLength(2);
    expect(out.steps[0].gate).toBe('auto');
    expect(out.steps[0].branches).toEqual([{ when: '欠落あり', then: '列挙して中止' }]);
    expect(out.steps[1].calls).toEqual(['weall-feature']);
    expect(out.steps[1].gate).toBeNull();
    expect(out.steps[1].branches).toEqual([]);
  });

  it('コードフェンス付き JSON も剥がしてパースする', () => {
    const out = parseFlow('```json\n{"steps":[{"title":"S1"}]}\n```');
    expect(out.steps[0].title).toBe('S1');
  });

  it('不正な gate は null に、文字列でない calls / branches は捨てる', () => {
    const out = parseFlow(
      JSON.stringify({
        steps: [
          {
            title: 'S',
            gate: '爆発',
            calls: ['ok', 42, null],
            branches: [{ when: 'a', then: 'b' }, { bad: true }, 'x'],
          },
        ],
      }),
    );
    expect(out.steps[0].gate).toBeNull();
    expect(out.steps[0].calls).toEqual(['ok']);
    expect(out.steps[0].branches).toEqual([{ when: 'a', then: 'b' }]);
  });

  it('title の無い step は捨て、12 step で打ち切る', () => {
    const steps = [{ title: '' }, ...Array.from({ length: 20 }, (_, i) => ({ title: 'S' + i }))];
    const out = parseFlow(JSON.stringify({ steps }));
    expect(out.steps).toHaveLength(12);
    expect(out.steps[0].title).toBe('S0');
  });

  it('steps が 1 件も取れない出力はエラー', () => {
    expect(() => parseFlow(JSON.stringify({ steps: [] }))).toThrow();
    expect(() => parseFlow('ただの文章')).toThrow();
  });
});
