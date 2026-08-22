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

  it('1段ネスト(metadata:)をドット key で読む', () => {
    const raw = [
      '---',
      'name: wiki-mcp-curl',
      'description: wiki は curl で書く',
      'metadata: ',
      '  type: reference',
      '  originSessionId: "0eff9cea"',
      '  node_type: memory',
      '---',
      '本文',
    ].join('\n');
    const { meta, body } = parseFrontmatter(raw);
    expect(meta.name).toBe('wiki-mcp-curl');
    expect(meta['metadata.type']).toBe('reference');
    expect(meta['metadata.originSessionId']).toBe('0eff9cea');
    expect(meta['metadata.node_type']).toBe('memory');
    expect(meta.metadata).toBe(''); // 親キー自体は従来どおり空文字
    expect(body).toBe('本文');
  });

  it('ネストの後もトップレベルの解釈が続く', () => {
    const { meta } = parseFrontmatter('---\nmetadata:\n  type: feedback\nname: after\n---\n');
    expect(meta['metadata.type']).toBe('feedback');
    expect(meta.name).toBe('after');
  });

  it('値なし + インデントのリスト(- x)はネストとして拾わない', () => {
    const { meta } = parseFrontmatter('---\nallowed-tools:\n  - Bash\n  - Read\nname: x\n---\n');
    expect(meta['allowed-tools']).toBe('');
    expect(meta.name).toBe('x');
    expect(Object.keys(meta).filter((k) => k.startsWith('allowed-tools.'))).toHaveLength(0);
  });

  it('frontmatter が無ければ全文が body', () => {
    const { meta, body } = parseFrontmatter('# タイトルだけ\n本文');
    expect(Object.keys(meta)).toHaveLength(0);
    expect(body).toBe('# タイトルだけ\n本文');
  });
});
