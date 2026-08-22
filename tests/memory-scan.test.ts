import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { scanMemory } from '../src/server/memory';
import { encodeProjectPath } from '../src/server/usage';
import { estimateTokens } from '../src/server/lint';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-memory-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/* ~/.claude/projects 相当のルートと、そこに紐づくプロジェクト実体を用意する */
const root = path.join(tmp, 'projects');
const projA = path.join(tmp, 'work', 'alpha');
const projB = path.join(tmp, 'work', 'beta');
fs.mkdirSync(projA, { recursive: true });
fs.mkdirSync(projB, { recursive: true });

function memDir(encoded: string): string {
  const dir = path.join(root, encoded, 'memory');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function write(dir: string, name: string, content: string): void {
  fs.writeFileSync(path.join(dir, name), content);
}

const encA = encodeProjectPath(projA);
const encB = encodeProjectPath(projB);

const dirA = memDir(encA);
write(
  dirA,
  'MEMORY.md',
  [
    '- [wiki MCP curl](reference_wiki_mcp_curl.md) — MCP ではなく curl で書く',
    '- [引き継ぎ issue](handoff.md) — ブランチと base を明記',
  ].join('\n'),
);
// metadata: 配下にネストした frontmatter(手元の多数派)。[[x]] は name とファイル名の両方
write(
  dirA,
  'reference_wiki_mcp_curl.md',
  [
    '---',
    'name: wiki-mcp-curl',
    'description: wiki への書き込みは MCP ではなく curl で行う',
    'metadata: ',
    '  type: reference',
    '  originSessionId: 0eff9cea-0db3',
    '  node_type: memory',
    '---',
    '',
    '本文。関連: [[handoff]] [[wiki-mcp-curl]] [[missing-one]] [[handoff]]',
  ].join('\n'),
);
// トップレベル type:(少数派)+ 索引行あり
write(
  dirA,
  'handoff.md',
  [
    '---',
    'name: handoff',
    'description: 引き継ぎ issue にはブランチと base を書く',
    'type: feedback',
    'originSessionId: 2ade0da4',
    '---',
    '',
    '本文',
  ].join('\n'),
);
// frontmatter に name / description が無く、索引にも載っていない
write(dirA, 'zz_no_meta.md', '# 見出し行\n\n本文\n');

const dirB = memDir(encB);
write(dirB, 'MEMORY.md', '- [beta memo](b.md) — beta のメモ');
write(dirB, 'b.md', '---\nname: beta-memo\ndescription: beta のメモ\n---\n\n本文\n');
// 未知の type(将来 Claude Code 側が値を増やしたときの想定)
write(
  dirB,
  'z_bogus_type.md',
  '---\nname: bogus\ndescription: 未知の type\ntype: bogus\n---\n\n本文\n',
);

// 逆引きできない孤児(削除済みプロジェクト)
const dirOrphan = memDir('-Users-me-gone');
write(dirOrphan, 'MEMORY.md', '- [gone](g.md) — 消えたプロジェクト');
write(dirOrphan, 'g.md', '---\nname: gone\ndescription: 消えたプロジェクトのメモ\n---\n\n本文\n');

// memory ディレクトリが無いプロジェクト(除外される)
fs.mkdirSync(path.join(root, '-Users-me-nomemory'), { recursive: true });

// MEMORY.md(索引)だけがあるプロジェクト。アイテムが 0 件なのでセクションにしない
write(memDir('-Users-me-indexonly'), 'MEMORY.md', '- [none](none.md) — 本文が残っていない');

const sections = scanMemory(projB, { root, projects: [projA, projB] });
const secA = sections.find((s) => s.projectName === 'alpha')!;
const secB = sections.find((s) => s.projectName === 'beta')!;

describe('scanMemory (自動メモリの走査)', () => {
  it('memory ディレクトリのあるプロジェクトだけをセクションにする', () => {
    expect(sections.map((s) => s.projectName)).toEqual(['beta', 'alpha', '-Users-me-gone']);
  });

  it('MEMORY.md だけのディレクトリはセクションにしない', () => {
    expect(sections.some((s) => s.id === '-Users-me-indexonly')).toBe(false);
  });

  it('未知の type は memoryType を付けない(バッジを出さない)', () => {
    const it = secB.items.find((x) => x.path.endsWith('z_bogus_type.md'))!;
    expect(it.memoryType).toBeUndefined();
  });

  it('cwd のプロジェクトが current で先頭、孤児は末尾', () => {
    expect(secB.isCurrent).toBe(true);
    expect(secA.isCurrent).toBeUndefined();
    const orphan = sections[sections.length - 1];
    expect(orphan.orphan).toBe(true);
    expect(orphan.projectPath).toBeNull();
    expect(orphan.projectName).toBe('-Users-me-gone'); // エンコード名そのまま
  });

  it('items はファイル名順、kind は memory で skill 側の tokens は付けない', () => {
    expect(secA.items.map((it) => path.basename(it.path))).toEqual([
      'handoff.md',
      'reference_wiki_mcp_curl.md',
      'zz_no_meta.md',
    ]);
    expect(secA.items.every((it) => it.kind === 'memory')).toBe(true);
    expect(secA.items.every((it) => it.tokens === undefined)).toBe(true);
    expect(secA.items.every((it) => it.lint === undefined && it.refs === undefined)).toBe(true);
  });

  it('metadata: 配下にネストした type / originSessionId を読む', () => {
    const it = secA.items.find((x) => x.name === 'wiki-mcp-curl')!;
    expect(it.memoryType).toBe('reference');
    expect(it.originSessionId).toBe('0eff9cea-0db3');
    expect(it.description).toBe('wiki への書き込みは MCP ではなく curl で行う');
  });

  it('トップレベルの type / originSessionId も読む', () => {
    const it = secA.items.find((x) => x.name === 'handoff')!;
    expect(it.memoryType).toBe('feedback');
    expect(it.originSessionId).toBe('2ade0da4');
  });

  it('name / description が無ければファイル名と本文1行目で埋める', () => {
    const it = secA.items.find((x) => x.path.endsWith('zz_no_meta.md'))!;
    expect(it.name).toBe('zz_no_meta');
    expect(it.description).toBe('見出し行');
    expect(it.memoryType).toBeUndefined();
    expect(it.originSessionId).toBeUndefined();
  });

  it('索引行があれば indexTokens、無ければ 0。bodyTokens は全文から', () => {
    const listed = secA.items.find((x) => x.name === 'handoff')!;
    expect(listed.indexTokens).toBe(
      estimateTokens('- [引き継ぎ issue](handoff.md) — ブランチと base を明記'),
    );
    const unlisted = secA.items.find((x) => x.path.endsWith('zz_no_meta.md'))!;
    expect(unlisted.indexTokens).toBe(0);
    expect(unlisted.bodyTokens).toBe(estimateTokens('# 見出し行\n\n本文\n'));
  });

  it('セクションの indexTokens は items の合計', () => {
    expect(secA.indexTokens).toBe(secA.items.reduce((n, it) => n + (it.indexTokens || 0), 0));
    expect(secA.indexTokens).toBeGreaterThan(0);
  });

  it('本文の [[x]] を重複排除して links に入れる(解決はしない)', () => {
    const it = secA.items.find((x) => x.name === 'wiki-mcp-curl')!;
    expect(it.links).toEqual(['handoff', 'wiki-mcp-curl', 'missing-one']);
  });

  it('usageAvailable は Phase A では常に false', () => {
    expect(sections.every((s) => s.usageAvailable === false)).toBe(true);
  });

  it('note は memory ディレクトリの実パス、id はエンコード名', () => {
    expect(secB.note).toBe(dirB);
    expect(secB.id).toBe(encB);
    expect(secB.projectPath).toBe(projB);
  });

  it('ルートが存在しなければ空配列', () => {
    expect(scanMemory(projA, { root: path.join(tmp, 'nope'), projects: [projA] })).toEqual([]);
  });
});
