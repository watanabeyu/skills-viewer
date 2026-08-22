import { describe, expect, it } from 'vitest';
import type { SkillItem } from '../src/shared/types';
import { itemKey } from '../web/src/api';
import {
  backlinksOf,
  brokenLinkCount,
  invocationOf,
  joinInstructions,
  kindMatches,
  memoryListSearch,
  refMatches,
  sameNameOthers,
  sortItems,
  sortMemory,
  usageLine,
  usageMatches,
  withPreamble,
} from '../web/src/util';
import { t } from '../web/src/i18n';

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
  it('agent は @名前、hook / memory は空', () => {
    expect(usageLine(base({ kind: 'agent' }))).toBe('@foo');
    expect(usageLine(base({ kind: 'hook' }))).toBe('');
    expect(usageLine(base({ kind: 'memory' }))).toBe(''); // memory は起動形を持たない
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

describe('usageMatches (使用実績フィルタ)', () => {
  const used = base({ useCount: 3 });
  const unused = base();
  const hook = base({ kind: 'hook' });
  it('all は常に通す', () => {
    expect(usageMatches(used, 'all', true)).toBe(true);
    expect(usageMatches(hook, 'all', false)).toBe(true);
  });
  it('used / unused を出し分ける(hook はどちらにも含めない)', () => {
    expect(usageMatches(used, 'used', true)).toBe(true);
    expect(usageMatches(unused, 'used', true)).toBe(false);
    expect(usageMatches(used, 'unused', true)).toBe(false);
    expect(usageMatches(unused, 'unused', true)).toBe(true);
    expect(usageMatches(hook, 'used', true)).toBe(false);
    expect(usageMatches(hook, 'unused', true)).toBe(false);
  });
  it('トランスクリプトが無い環境では unused に何も出さない', () => {
    expect(usageMatches(unused, 'unused', false)).toBe(false);
  });
});

describe('itemKey', () => {
  it('同一ファイル・同一イベント名の hook 同士でもキーが衝突しない', () => {
    // 重複キーがあると React がソート変更・グループ化切替の並べ替えで DOM を壊す
    const h1 = base({
      kind: 'hook',
      name: 'PostToolUse (Write|Edit)',
      path: '/p/.claude/settings.json',
      description: 'a.sh',
    });
    const h2 = base({
      kind: 'hook',
      name: 'PostToolUse (Write|Edit)',
      path: '/p/.claude/settings.json',
      description: 'b.sh',
    });
    expect(itemKey(h1)).not.toBe(itemKey(h2));
  });

  it('hook 以外は path#name(URL 互換を維持)', () => {
    expect(itemKey(base())).toBe('/p/.claude/skills/foo/SKILL.md#foo');
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

/* ---- memory 軸(plan 10 Phase D)の純関数 ---- */

const mem = (name: string, over: Partial<SkillItem> = {}): SkillItem =>
  base({ name, kind: 'memory', path: `/m/${name}.md`, ...over });

describe('sortMemory (memory 軸の並び順)', () => {
  const items = [
    mem('b', { indexTokens: 30, bodyTokens: 900, updatedAt: 200 }),
    mem('a', { indexTokens: 30, bodyTokens: 100, updatedAt: 100 }),
    mem('c', { indexTokens: 50, bodyTokens: 500 }),
  ];
  it('index は索引トークンが多い順、同値は名前順', () => {
    expect(sortMemory(items, 'index').map((i) => i.name)).toEqual(['c', 'a', 'b']);
  });
  it('body は本文トークンが多い順', () => {
    expect(sortMemory(items, 'body').map((i) => i.name)).toEqual(['b', 'c', 'a']);
  });
  it('updated は更新が古い順(更新日不明は末尾)', () => {
    expect(sortMemory(items, 'updated').map((i) => i.name)).toEqual(['a', 'b', 'c']);
  });
  /* サーバーは stat に失敗した項目に updatedAt: 0 を載せるので、0 も「不明」として末尾に置く */
  it('updatedAt: 0(stat 失敗)は最古ではなく不明として末尾', () => {
    const withZero = [...items, mem('z', { updatedAt: 0 })];
    expect(sortMemory(withZero, 'updated').map((i) => i.name)).toEqual(['a', 'b', 'c', 'z']);
  });
  it('name は名前順', () => {
    expect(sortMemory(items, 'name').map((i) => i.name)).toEqual(['a', 'b', 'c']);
  });
  it('元の配列を変更しない', () => {
    const before = items.map((i) => i.name);
    sortMemory(items, 'index');
    expect(items.map((i) => i.name)).toEqual(before);
  });
});

describe('refMatches (参照フィルタ)', () => {
  const read = mem('r', { useCount: 2 });
  const unread = mem('u');
  it('all は常に通す(計測不能でも)', () => {
    expect(refMatches(read, 'all', true)).toBe(true);
    expect(refMatches(unread, 'all', false)).toBe(true);
  });
  it('read / unread を Read 回数で出し分ける', () => {
    expect(refMatches(read, 'read', true)).toBe(true);
    expect(refMatches(unread, 'read', true)).toBe(false);
    expect(refMatches(read, 'unread', true)).toBe(false);
    expect(refMatches(unread, 'unread', true)).toBe(true);
  });
  it('トランスクリプトが無いプロジェクトは「未参照」ではなく判定不能なので、どちらにも含めない', () => {
    expect(refMatches(read, 'read', false)).toBe(false);
    expect(refMatches(unread, 'unread', false)).toBe(false);
  });
});

describe('backlinksOf / brokenLinkCount ([[link]] の被リンクとリンク切れ)', () => {
  // ファイル名 ≠ frontmatter name のケース(旧形式のファイル名が残っている)を含める
  const wiki = mem('wiki-mcp-curl', { path: '/m/reference_wiki_mcp_curl.md' });
  const handoff = mem('handoff', { links: ['wiki-mcp-curl', 'nope'] });
  const deploy = mem('deploy', { links: ['reference_wiki_mcp_curl', 'handoff'] });
  const lonely = mem('lonely', { links: ['lonely'] });
  const items = [wiki, handoff, deploy, lonely];

  it('被リンクは name 一致とファイル名一致のどちらでも拾う', () => {
    expect(backlinksOf(wiki, items).map((i) => i.name)).toEqual(['handoff', 'deploy']);
    expect(backlinksOf(handoff, items).map((i) => i.name)).toEqual(['deploy']);
  });
  it('自分自身へのリンクは被リンクに数えない', () => {
    expect(backlinksOf(lonely, items)).toEqual([]);
  });
  it('リンク切れ数は同プロジェクト内で解決できない発リンクの数', () => {
    expect(brokenLinkCount(handoff, items)).toBe(1); // nope
    expect(brokenLinkCount(deploy, items)).toBe(0);
    expect(brokenLinkCount(wiki, items)).toBe(0); // links 無し
  });
});

describe('joinInstructions / withPreamble (まとめコピーの本文)', () => {
  const tri = (instruction: string): SkillItem['aiTriage'] => ({
    verdict: 'delete',
    reason: '',
    issues: [],
    instruction,
  });
  const items = [
    mem('alpha', { aiTriage: tri('- alpha を消す') }),
    mem('beta', { aiTriage: tri('') }), // 提案なし(keep 相当)
    mem('gamma', { aiTriage: tri('- gamma を docs/ へ') }),
    mem('delta'), // 未診断
  ];
  const preamble = t('memory.triage.copyPreamble');

  it('前置きは本文の先頭に 1 回だけ付く', () => {
    const text = joinInstructions(items);
    expect(text.startsWith(preamble + '\n\n')).toBe(true);
    expect(text.split(preamble)).toHaveLength(2); // 出現は 1 回
    expect(withPreamble('body')).toBe(preamble + '\n\nbody');
  });

  it('各件は「## name」見出しで区切る', () => {
    const text = joinInstructions(items);
    expect(text).toContain('## alpha\n\n- alpha を消す');
    expect(text).toContain('## gamma\n\n- gamma を docs/ へ');
  });

  it('指示文が空の件・未診断の件は含めない', () => {
    const text = joinInstructions(items);
    expect(text).not.toContain('## beta');
    expect(text).not.toContain('## delta');
  });
});

describe('memoryListSearch (memory 一覧へ戻る URL)', () => {
  it('view=memory を立て、詳細のタブ状態は捨てる(他の条件は保つ)', () => {
    const params = new URLSearchParams('q=foo&msort=body&tab=body&view=source');
    const next = new URLSearchParams(memoryListSearch(params));
    expect(next.get('view')).toBe('memory');
    expect(next.get('tab')).toBeNull();
    expect(next.get('q')).toBe('foo');
    expect(next.get('msort')).toBe('body');
  });
  it('渡された params は変更しない', () => {
    const params = new URLSearchParams('tab=body');
    memoryListSearch(params);
    expect(params.get('tab')).toBe('body');
  });
});
