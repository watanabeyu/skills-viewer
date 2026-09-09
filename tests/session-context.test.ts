/*
 * ホーム ②「セッションの文脈」と description 予算の計算(src/server/index.ts)。
 *
 * scanSections は登録済みの全プロジェクトを返すので、母集団を絞らないと複数プロジェクトの
 * description を合算してしまい、予算超過の警告が常時出る(レビュー 2026-09-09 の指摘)。
 * 3 つの内訳(CLAUDE.md / MEMORY.md 索引 / description)が同じ母集団を見ることを固定する。
 */

import { describe, expect, it } from 'vitest';
import { descriptionBudget, sessionContext, sessionScope } from '../src/server/index';
import type {
  ClaudeMdScan,
  ItemKind,
  MemorySection,
  Section,
  SkillItem,
  Source,
} from '../src/shared/types';

function item(name: string, tokens: number | undefined, extra: Partial<SkillItem> = {}): SkillItem {
  return {
    name,
    description: name + ' desc',
    argumentHint: '',
    version: '',
    kind: 'skill' as ItemKind,
    path: '/x/' + name + '/SKILL.md',
    updatedAt: 0,
    files: [],
    ...(tokens === undefined ? {} : { tokens }),
    ...extra,
  };
}

function section(id: string, source: Source, items: SkillItem[], isCurrent = false): Section {
  return { id, source, note: '/w/' + id, items, ...(isCurrent ? { isCurrent: true } : {}) };
}

const emptyClaudeMd: ClaudeMdScan = { layers: [], tokens: 0 };

function memSection(id: string, indexTokens: number, lines: number, isCurrent: boolean) {
  return {
    id,
    projectName: id,
    note: '/w/' + id + '/memory',
    usageAvailable: true,
    indexTokens,
    items: Array.from({ length: lines }, (_, i) => item('m' + i, undefined)),
    ...(isCurrent ? { isCurrent: true } : {}),
  } as MemorySection;
}

describe('sessionScope', () => {
  it('現在プロジェクト以外の project セクションを外す(user / plugin / built-in は残す)', () => {
    const secs = [
      section('proj-a', 'project', [], true),
      section('proj-b', 'project', []),
      section('user', 'user', []),
      section('plugin', 'plugin', []),
      section('builtin', 'built-in', []),
    ];
    expect(sessionScope(secs).map((s) => s.id)).toEqual(['proj-a', 'user', 'plugin', 'builtin']);
  });

  it('現在プロジェクトが無い(cwd が未登録)なら project セクションは 1 つも残らない', () => {
    const secs = [section('proj-a', 'project', []), section('user', 'user', [])];
    expect(sessionScope(secs).map((s) => s.id)).toEqual(['user']);
  });
});

describe('descriptionBudget', () => {
  it('他プロジェクトの description を合算しない', () => {
    const secs = [
      section('proj-a', 'project', [item('a', 100)], true),
      section('proj-b', 'project', [item('b', 900)]),
      section('user', 'user', [item('u', 50)]),
    ];
    // 現在プロジェクト 100 + user 50。proj-b の 900 は入らない
    expect(descriptionBudget(secs)).toEqual({ used: 150, limit: 2000, source: 'default' });
  });

  it('hidden(tokens 無し)は加算しない', () => {
    const secs = [
      section('proj-a', 'project', [item('a', 100), item('h', undefined, { hidden: true })], true),
    ];
    expect(descriptionBudget(secs).used).toBe(100);
  });
});

describe('sessionContext', () => {
  const secs = [
    section(
      'proj-a',
      'project',
      [
        item('a', 100),
        item('h', undefined, { hidden: true }),
        item('hk', undefined, { kind: 'hook' as ItemKind }),
      ],
      true,
    ),
    section('proj-b', 'project', [item('b', 900)]),
    section('user', 'user', [item('u', 50)]),
  ];

  it('description は件数・hidden 件数・合計とも現在プロジェクト + 共有スコープだけを見る', () => {
    const ctx = sessionContext(secs, [], emptyClaudeMd);
    expect(ctx.descriptions).toEqual({ tok: 150, count: 2, hiddenCount: 1, limit: 2000 });
  });

  it('hook は description を注入しないので件数に数えない', () => {
    // 母集団は proj-a の 3 件(a / h / hook)+ user の 1 件。hook を除いた 3 件が数えられる
    const ctx = sessionContext(secs, [], emptyClaudeMd);
    expect(ctx.descriptions.count + ctx.descriptions.hiddenCount).toBe(3);
    // hook を足した 4 件になっていないこと
    const withHook = sessionScope(secs).flatMap((x) => x.items).length;
    expect(withHook).toBe(4);
  });

  it('MEMORY.md 索引は現在プロジェクトの分だけを見る', () => {
    const ctx = sessionContext(
      secs,
      [memSection('a', 310, 3, true), memSection('b', 999, 9, false)],
      emptyClaudeMd,
    );
    expect(ctx.memoryIndex.tok).toBe(310);
    expect(ctx.memoryIndex.lines).toBe(3);
  });

  it('memory が無ければ索引は 0 行(画面はこの行を出さない)', () => {
    expect(sessionContext(secs, [], emptyClaudeMd).memoryIndex.lines).toBe(0);
  });

  it('公式仕様の上限をそのまま載せる(200 行 / 25KB)', () => {
    const ctx = sessionContext(secs, [], emptyClaudeMd);
    expect(ctx.memoryIndex.limitLines).toBe(200);
    expect(ctx.memoryIndex.limitBytes).toBe(25 * 1024);
  });

  it('CLAUDE.md は走査の合計をそのまま使う', () => {
    const ctx = sessionContext(secs, [], { layers: [], tokens: 1180 });
    expect(ctx.claudeMd.tok).toBe(1180);
  });
});
