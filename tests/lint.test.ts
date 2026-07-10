import { describe, expect, it } from 'vitest';
import { estimateTokens, lintItem } from '../src/server/lint';

describe('estimateTokens', () => {
  it('ASCII はおよそ 4 文字 = 1 トークン', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });

  it('日本語はおよそ 1.5 文字 = 1 トークン', () => {
    expect(estimateTokens('あ'.repeat(150))).toBe(100);
  });

  it('混在テキストは合算、端数は切り上げ', () => {
    expect(estimateTokens('ab')).toBe(1); // 0.5 → 1
    expect(estimateTokens('')).toBe(0);
  });
});

describe('lintItem', () => {
  it('frontmatter に description が無ければ no-description のみ', () => {
    expect(lintItem({}, 'foo', 'skill')).toEqual(['no-description']);
    expect(lintItem({ description: '  ' }, 'foo', 'skill')).toEqual(['no-description']);
  });

  it('短すぎる description を警告する', () => {
    const w = lintItem({ description: 'short one. use it' }, 'foo', 'skill');
    expect(w).toContain('short-description');
  });

  it('長すぎる description を警告する', () => {
    const w = lintItem({ description: 'Use when needed. ' + 'x'.repeat(1100) }, 'foo', 'skill');
    expect(w).toContain('long-description');
  });

  it('発動条件が無い skill は no-trigger(en/ja とも検出できる)', () => {
    expect(
      lintItem({ description: 'A collection of helpful project utilities here.' }, 'foo', 'skill'),
    ).toContain('no-trigger');
    expect(
      lintItem(
        { description: 'Use when the user asks about billing and invoices.' },
        'foo',
        'skill',
      ),
    ).not.toContain('no-trigger');
    expect(
      lintItem(
        { description: 'PRのレビュー依頼のときに使用するスキルです。修正方針も提案する。' },
        'foo',
        'skill',
      ),
    ).not.toContain('no-trigger');
  });

  it('command には no-trigger を出さない(人間が明示的に打つ起点)', () => {
    expect(
      lintItem(
        { description: 'Create a pull request from the current branch.' },
        'pr-create',
        'command',
      ),
    ).not.toContain('no-trigger');
  });

  it('name の繰り返しだけの description は name-echo', () => {
    expect(lintItem({ description: 'Pr Create' }, 'pr-create', 'command')).toContain('name-echo');
  });

  it('hook は lint 対象外', () => {
    expect(lintItem({}, 'PostToolUse', 'hook')).toEqual([]);
  });

  it('良い description は警告なし', () => {
    expect(
      lintItem(
        {
          description:
            'Use this skill when the user asks to review a pull request or local diff. Analyzes code quality, bugs and security.',
        },
        'code-review',
        'skill',
      ),
    ).toEqual([]);
  });
});
