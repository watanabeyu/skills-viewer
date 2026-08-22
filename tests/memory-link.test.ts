/*
 * [[link]] の解決は web 側(詳細画面)の責務なので、scanMemory とは別にここで担保する。
 * scanMemory は本文から [[x]] を抽出するだけ(tests/memory-scan.test.ts)。
 */
import { describe, expect, it } from 'vitest';
import { renderMemoryBody } from '../web/src/components/MemoryDetail';
import type { SkillItem } from '../src/shared/types';

const mk = (name: string, p: string): SkillItem => ({
  name,
  description: '',
  argumentHint: '',
  version: '',
  kind: 'memory',
  path: p,
  files: [],
});

/* ファイル名 ≠ frontmatter name のケースを含める(旧形式のファイル名が残っている) */
const items = [
  mk('wiki-mcp-curl', '/m/reference_wiki_mcp_curl.md'),
  mk('handoff', '/m/handoff.md'),
];
const resolve = (n: string) =>
  items.find((m) => m.name === n || m.path.split('/').pop()!.replace(/\.md$/, '') === n);

describe('renderMemoryBody ([[link]] の解決)', () => {
  it('frontmatter name で解決してリンクにする', () => {
    const html = renderMemoryBody('関連: [[handoff]]', resolve);
    expect(html).toContain('<a class="mem-link"');
    expect(html).toContain('>handoff</a>');
  });

  it('ファイル名(拡張子なし)でも解決する', () => {
    const html = renderMemoryBody('関連: [[reference_wiki_mcp_curl]]', resolve);
    expect(html).toContain('<a class="mem-link"');
    expect(html).toContain('>reference_wiki_mcp_curl</a>');
  });

  it('解決できなければリンク切れとして [[x]] のまま装飾する', () => {
    const html = renderMemoryBody('関連: [[nope]]', resolve);
    expect(html).toContain('<span class="mem-link broken"');
    expect(html).toContain('[[nope]]');
    expect(html).not.toContain('<a class="mem-link"');
  });

  it('本文の HTML はエスケープされたまま(置換で穴が開かない)', () => {
    const html = renderMemoryBody('<script>alert(1)</script> [[handoff]]', resolve);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});
