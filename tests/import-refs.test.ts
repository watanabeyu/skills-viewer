/*
 * @import の参照抽出(src/shared/import-refs.ts)。server の走査と web の印は同じ規則でなければ
 * ならない ── web は「本文に現れた順」と「サーバーが返した配列の順」を index で突き合わせるので、
 * 片側だけが 1 件多く拾うと以降の対応が全部ずれ、実在する @import の行に別のファイルの tok が付く。
 * 実際、サーバーだけが `~~~` を知っていて web が知らない状態が起きていた(レビュー 3 周目の指摘)。
 * 規則をこのモジュール 1 本にまとめたので、ここで規則そのものを固定する。
 */

import { describe, expect, it } from 'vitest';
import {
  bodyWithoutFrontmatter,
  importRefs,
  isFenceLine,
  refsOfLine,
} from '../src/shared/import-refs';
import { importRefsOfLine } from '../web/src/claudemd';

describe('refsOfLine — 1 行の参照', () => {
  it('行頭か空白の後の @ を拾い、末尾の句読点を落とす', () => {
    expect(refsOfLine('@README')).toEqual(['README']);
    expect(refsOfLine('see @docs/a.md, and @~/b.md.')).toEqual(['docs/a.md', '~/b.md']);
    expect(refsOfLine('mail me@example.com')).toEqual([]);
    expect(refsOfLine('@')).toEqual([]);
  });

  /* 公式の除外規則はバッククォート。`@README` は文字どおりの表記で参照ではない */
  it('コードスパンの中は拾わない', () => {
    expect(refsOfLine('write `@README` to mention it')).toEqual([]);
    expect(refsOfLine('`@a.md` but @b.md')).toEqual(['b.md']);
    // 閉じていないバッククォートは除去されない(公式もコードスパンとして閉じない)
    expect(refsOfLine('` @a.md')).toEqual(['a.md']);
  });

  it('句読点だけの参照は捨てる', () => {
    expect(refsOfLine('@...')).toEqual([]);
  });

  it('長すぎる参照は捨てる(解決の試行が無駄になる)', () => {
    expect(refsOfLine('@' + 'a'.repeat(1024))).toEqual(['a'.repeat(1024)]);
    expect(refsOfLine('@' + 'a'.repeat(1025))).toEqual([]);
  });
});

describe('isFenceLine — ``` と ~~~ の両方', () => {
  it('どちらの記法もフェンスとして扱う', () => {
    expect(isFenceLine('```')).toBe(true);
    expect(isFenceLine('~~~')).toBe(true);
    expect(isFenceLine('  ```ts')).toBe(true);
    expect(isFenceLine('not a fence')).toBe(false);
  });
});

describe('importRefs — 本文全体', () => {
  it('フェンスの内側は拾わず、フェンス行そのものも見ない', () => {
    expect(importRefs('```\n@in.md\n```\n@after.md')).toEqual(['after.md']);
    expect(importRefs('~~~\n@in.md\n~~~\n@after.md')).toEqual(['after.md']);
    // 閉じフェンス行に書かれた @ も拾わない
    expect(importRefs('```\ncode\n``` @sneaky.md\n@after.md')).toEqual(['after.md']);
  });

  it('件数の上限で打ち切る', () => {
    const body = Array.from({ length: 10 }, (_, i) => `@./n${i}.md`).join('\n');
    expect(importRefs(body, 3)).toEqual(['./n0.md', './n1.md', './n2.md']);
  });
});

describe('bodyWithoutFrontmatter', () => {
  it('先頭の frontmatter を落とす(web は別枠で描くので印を置けない)', () => {
    expect(bodyWithoutFrontmatter('---\npaths:\n  - "@types/node"\n---\n@real.md')).toBe(
      '@real.md',
    );
  });

  it('frontmatter が無い本文はそのまま', () => {
    expect(bodyWithoutFrontmatter('# h\n@a.md')).toBe('# h\n@a.md');
  });

  it('閉じられていない --- は frontmatter として扱わない', () => {
    expect(bodyWithoutFrontmatter('---\nstill open\n@a.md')).toBe('---\nstill open\n@a.md');
  });
});

/*
 * web が使う入口が同じ関数であることを固定する。別実装に戻されたらここで落ちる。
 */
describe('web と server が同じ規則を使う', () => {
  const cases = [
    '@README',
    'see @docs/a.md, and @~/b.md.',
    'write `@README` to mention it',
    '`@a.md` but @b.md',
    'mail me@example.com',
    '@' + 'a'.repeat(1025),
    '@...',
    '@a.md @b.md @c.md',
  ];

  it.each(cases)('%s の結果が一致する', (line) => {
    expect(importRefsOfLine(line)).toEqual(refsOfLine(line));
  });
});
