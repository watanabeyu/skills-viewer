import { describe, expect, it } from 'vitest';
import { parseAnalysis } from '../src/server/summary';

describe('parseAnalysis (haiku 出力のパース)', () => {
  const refs = ['weall-ship', 'loop'];

  it('正常な JSON を構造化して返す', () => {
    const out = parseAnalysis(
      JSON.stringify({
        summary: 'テスト要約。',
        invocation: 'human',
        invocationReason: '手で打つ起点',
        relations: [{ name: 'weall-ship', type: 'invokes', note: 'ship を起動' }],
      }),
      refs,
    );
    expect(out.summary).toBe('テスト要約。');
    expect(out.invocation).toBe('human');
    expect(out.relations).toEqual([{ name: 'weall-ship', type: 'invokes', note: 'ship を起動' }]);
  });

  it('コードフェンス付き JSON も剥がしてパースする', () => {
    const out = parseAnalysis(
      '```json\n{"summary":"S","invocation":"agent","relations":[]}\n```',
      [],
    );
    expect(out.summary).toBe('S');
    expect(out.invocation).toBe('agent');
  });

  it('refs に無い skill 名の relation は捨てる(幻覚防止)', () => {
    const out = parseAnalysis(
      JSON.stringify({
        summary: 'S',
        invocation: 'both',
        relations: [
          { name: 'weall-ship', type: 'delegates', note: '' },
          { name: 'hallucinated-skill', type: 'invokes', note: '' },
        ],
      }),
      refs,
    );
    expect(out.relations.map((r) => r.name)).toEqual(['weall-ship']);
  });

  it('不正な relation type は references に正規化する', () => {
    const out = parseAnalysis(
      JSON.stringify({
        summary: 'S',
        invocation: 'human',
        relations: [{ name: 'loop', type: '爆発' }],
      }),
      refs,
    );
    expect(out.relations[0].type).toBe('references');
  });

  it('多言語対応前の日本語 relation type は新キーへマップする', () => {
    const out = parseAnalysis(
      JSON.stringify({
        summary: 'S',
        invocation: 'human',
        relations: [
          { name: 'weall-ship', type: '起動' },
          { name: 'loop', type: '呼ばれる側' },
        ],
      }),
      refs,
    );
    expect(out.relations.map((r) => r.type)).toEqual(['invokes', 'called-by']);
  });

  it('不正な invocation は null にする', () => {
    const out = parseAnalysis(JSON.stringify({ summary: 'S', invocation: 'alien' }), []);
    expect(out.invocation).toBeNull();
  });

  it('JSON でない出力は全文を summary として扱う', () => {
    const out = parseAnalysis('これはただの文章です。', refs);
    expect(out.summary).toBe('これはただの文章です。');
    expect(out.invocation).toBeNull();
    expect(out.relations).toEqual([]);
  });
});
