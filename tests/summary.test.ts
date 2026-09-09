import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { contentHash, parseAnalysis } from '../src/server/summary';

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

/*
 * contentHash の上限(レビュー 1 周目)。計画 16 Phase D で差分追跡の対象が登録簿の全プロジェクトに
 * 広がり、この関数は 1 リクエストで数百ファイルに掛かるようになった ── 巨大な .md が 1 つ混ざる
 * だけで毎リクエストその全文を読むことになるので、claude-md.ts と同じ 4 MiB で切る。
 */
describe('contentHash (大きすぎるファイルは中身を読まない)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-content-hash-'));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('上限内は内容の hash(16 桁の hex)', () => {
    const fp = path.join(tmp, 'small.md');
    fs.writeFileSync(fp, '# small');
    expect(contentHash(fp)).toMatch(/^[0-9a-f]{16}$/);
    fs.writeFileSync(fp, '# small changed');
    expect(contentHash(fp)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('4 MiB 超は size:mtime のメタで代用し、更新されれば値が変わる', () => {
    const fp = path.join(tmp, 'huge.md');
    fs.writeFileSync(fp, 'x'.repeat(4 * 1024 * 1024 + 1));
    const h = contentHash(fp);
    expect(h).toMatch(/^\d+:\d+$/); // 内容の hash(hex)とは形が違うので取り違えない
    // 中身が変われば mtime が動くので、追跡としては成立する
    fs.writeFileSync(fp, 'y'.repeat(4 * 1024 * 1024 + 2));
    fs.utimesSync(fp, new Date('2026-02-02T00:00:00.000Z'), new Date('2026-02-02T00:00:00.000Z'));
    expect(contentHash(fp)).not.toBe(h);
  });

  it('読めないパスは null(従来どおり)', () => {
    expect(contentHash(path.join(tmp, 'no-such.md'))).toBeNull();
  });
});
