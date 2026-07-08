import { describe, expect, it } from 'vitest';
import type { SkillItem } from '../src/shared/types';
import { invocationOf, kindMatches, sameNameOthers, sortItems, usageLine } from '../web/src/util';

const base = (over: Partial<SkillItem> = {}): SkillItem => ({
  name: 'foo',
  description: 'desc',
  argumentHint: '',
  version: '',
  kind: 'skill',
  path: '/p/.claude/skills/foo/SKILL.md',
  files: [],
  ...over,
});

describe('usageLine (呼び出し例の表記)', () => {
  it('skill は /名前 + 引数ヒント', () => {
    expect(usageLine(base({ argumentHint: '<PR>' }))).toBe('/foo <PR>');
  });
  it('agent は @名前、hook は空', () => {
    expect(usageLine(base({ kind: 'agent' }))).toBe('@foo');
    expect(usageLine(base({ kind: 'hook' }))).toBe('');
  });
});

describe('invocationOf (起動経路の判定)', () => {
  it('実測が最優先', () => {
    expect(invocationOf(base({ typedCount: 3, autoCount: 1 }))).toEqual({
      kind: 'both',
      basis: 'measured',
    });
    expect(invocationOf(base({ typedCount: 3 }))).toEqual({ kind: 'human', basis: 'measured' });
    expect(invocationOf(base({ autoCount: 2 }))).toEqual({ kind: 'agent', basis: 'measured' });
  });
  it('実測が無ければ AI 判定にフォールバック', () => {
    expect(invocationOf(base({ aiInvocation: 'both' }))).toEqual({ kind: 'both', basis: 'ai' });
    expect(invocationOf(base())).toBeNull();
  });
});

describe('sortItems', () => {
  const items = [
    base({ name: 'b', useCount: 5, lastUsed: 10, updatedAt: 1 }),
    base({ name: 'a', useCount: 1, lastUsed: 30, updatedAt: 2 }),
    base({ name: 'c', updatedAt: 3 }),
  ];
  it('name / uses / recent / updated の各順', () => {
    expect(sortItems(items, 'name').map((i) => i.name)).toEqual(['a', 'b', 'c']);
    expect(sortItems(items, 'uses').map((i) => i.name)).toEqual(['b', 'a', 'c']);
    expect(sortItems(items, 'recent').map((i) => i.name)).toEqual(['a', 'b', 'c']);
    expect(sortItems(items, 'updated').map((i) => i.name)).toEqual(['c', 'a', 'b']);
  });
});

describe('kindMatches / sameNameOthers', () => {
  it('kind フィルタ', () => {
    expect(kindMatches(base(), 'all')).toBe(true);
    expect(kindMatches(base({ kind: 'agent' }), 'agent')).toBe(true);
    expect(kindMatches(base({ kind: 'agent' }), 'skill')).toBe(false);
  });

  it('同名の別定義を short name で見つける(自分自身と hook は除外)', () => {
    const me = { ...base(), key: 'k1' };
    const all = [
      me,
      { ...base({ path: '/other/SKILL.md' }), key: 'k2' },
      { ...base({ name: 'plugin:foo', path: '/pl.md' }), key: 'k3' },
      { ...base({ kind: 'hook' as const, path: '/s.json' }), key: 'k4' },
      { ...base({ name: 'unrelated' }), key: 'k5' },
    ];
    expect(sameNameOthers(me, all).map((x) => x.key)).toEqual(['k2', 'k3']);
  });
});
