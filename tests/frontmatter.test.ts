import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../src/server/scan';

describe('parseFrontmatter', () => {
  it('スカラー値を読める', () => {
    const { meta, body } = parseFrontmatter('---\nname: foo\ndescription: bar baz\n---\n# 本文\n');
    expect(meta.name).toBe('foo');
    expect(meta.description).toBe('bar baz');
    expect(body).toBe('# 本文\n');
  });

  it('ブロックスカラー(|)を複数行のまま読める', () => {
    const raw = '---\nname: foo\ndescription: |\n  1行目\n  2行目\n\n  4行目\nother: x\n---\nbody';
    const { meta } = parseFrontmatter(raw);
    expect(meta.description).toBe('1行目\n2行目\n\n4行目');
    expect(meta.other).toBe('x');
  });

  it('クォートを剥がす', () => {
    const { meta } = parseFrontmatter('---\nname: "quoted"\nhint: \'single\'\n---\n');
    expect(meta.name).toBe('quoted');
    expect(meta.hint).toBe('single');
  });

  it('frontmatter が無ければ全文が body', () => {
    const { meta, body } = parseFrontmatter('# タイトルだけ\n本文');
    expect(Object.keys(meta)).toHaveLength(0);
    expect(body).toBe('# タイトルだけ\n本文');
  });
});
