import { describe, expect, it } from 'vitest';
import { parseDiagnosis } from '../src/server/diagnose';

describe('parseDiagnosis', () => {
  it('正常な JSON をパースする', () => {
    const d = parseDiagnosis(
      '{"verdict":"weak","issues":["発動条件がない"],"improved":"レビュー依頼のときに使用する。"}',
    );
    expect(d.verdict).toBe('weak');
    expect(d.issues).toEqual(['発動条件がない']);
    expect(d.improved).toBe('レビュー依頼のときに使用する。');
  });

  it('コードフェンス付きでも読める', () => {
    const d = parseDiagnosis('```json\n{"verdict":"good","issues":[],"improved":"ok"}\n```');
    expect(d.verdict).toBe('good');
  });

  it('未知の verdict は weak に落とし、issues は最大4件・文字列のみ', () => {
    const d = parseDiagnosis(
      JSON.stringify({
        verdict: 'excellent',
        issues: ['a', 'b', 'c', 'd', 'e', 42],
        improved: 'x',
      }),
    );
    expect(d.verdict).toBe('weak');
    expect(d.issues).toEqual(['a', 'b', 'c', 'd']);
  });

  it('improved が空なら例外(UI にエラーを出す)', () => {
    expect(() => parseDiagnosis('{"verdict":"good","issues":[]}')).toThrow();
    expect(() => parseDiagnosis('not json at all')).toThrow();
  });
});
