/*
 * ホーム ②「セッションの文脈」と description 予算の計算(src/server/index.ts)。
 *
 * scanSections は登録済みの全プロジェクトを返すので、母集団を絞らないと複数プロジェクトの
 * description を合算してしまい、予算超過の警告が常時出る(レビュー 2026-09-09 の指摘)。
 * 3 つの内訳(CLAUDE.md / MEMORY.md 索引 / description)が同じ母集団を見ることを固定する。
 *
 * 計画 16 で母集団の基準が cwd(isCurrent)から「選んだプロジェクトの id」に変わった。
 * ?project=<id> の解決(生のパスを受け取らないこと)もここで固定する。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { descriptionBudget, sessionContext, sessionScope } from '../src/server/index';
import { projectSectionId } from '../src/server/scan';
import { encodeProjectPath } from '../src/server/usage';
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
  it('選んだプロジェクト以外の project セクションを外す(user / plugin / built-in は残す)', () => {
    const secs = [
      section('proj-a', 'project', [], true),
      section('proj-b', 'project', []),
      section('user', 'user', []),
      section('plugin', 'plugin', []),
      section('builtin', 'built-in', []),
    ];
    expect(sessionScope(secs, 'proj-a').map((s) => s.id)).toEqual([
      'proj-a',
      'user',
      'plugin',
      'builtin',
    ]);
  });

  /* 計画 16 判断 1: cwd は既定の選択にすぎないので、絞り込みの基準は isCurrent ではなく id */
  it('cwd(isCurrent)ではなく選んだ id で絞る', () => {
    const secs = [
      section('proj-a', 'project', [], true), // cwd だが選ばれていない
      section('proj-b', 'project', []), // 選ばれている(isCurrent は付かない)
      section('user', 'user', []),
    ];
    expect(sessionScope(secs, 'proj-b').map((s) => s.id)).toEqual(['proj-b', 'user']);
  });

  it('選んだプロジェクトの Section が無い(定義 0 件)なら project 段は空になる', () => {
    const secs = [section('proj-a', 'project', [], true), section('user', 'user', [])];
    expect(sessionScope(secs, 'proj-empty').map((s) => s.id)).toEqual(['user']);
  });
});

describe('descriptionBudget', () => {
  it('他プロジェクトの description を合算しない', () => {
    const secs = [
      section('proj-a', 'project', [item('a', 100)], true),
      section('proj-b', 'project', [item('b', 900)]),
      section('user', 'user', [item('u', 50)]),
    ];
    // 選んだプロジェクト 100 + user 50。proj-b の 900 は入らない
    expect(descriptionBudget(secs, 'proj-a')).toEqual({
      used: 150,
      limit: 2000,
      source: 'default',
    });
  });

  it('hidden(tokens 無し)は加算しない', () => {
    const secs = [
      section('proj-a', 'project', [item('a', 100), item('h', undefined, { hidden: true })], true),
    ];
    expect(descriptionBudget(secs, 'proj-a').used).toBe(100);
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

  it('description は件数・hidden 件数・合計とも選んだプロジェクト + 共有スコープだけを見る', () => {
    const ctx = sessionContext(secs, [], emptyClaudeMd, 'proj-a');
    expect(ctx.descriptions).toEqual({ tok: 150, count: 2, hiddenCount: 1, limit: 2000 });
  });

  it('hook は description を注入しないので件数に数えない', () => {
    // 母集団は proj-a の 3 件(a / h / hook)+ user の 1 件。hook を除いた 3 件が数えられる
    const ctx = sessionContext(secs, [], emptyClaudeMd, 'proj-a');
    expect(ctx.descriptions.count + ctx.descriptions.hiddenCount).toBe(3);
    // hook を足した 4 件になっていないこと
    const withHook = sessionScope(secs, 'proj-a').flatMap((x) => x.items).length;
    expect(withHook).toBe(4);
  });

  it('MEMORY.md 索引は選んだプロジェクトの分だけを見る(memory は選択を起点に走査済み)', () => {
    const ctx = sessionContext(
      secs,
      [memSection('a', 310, 3, true), memSection('b', 999, 9, false)],
      emptyClaudeMd,
      'proj-a',
    );
    expect(ctx.memoryIndex.tok).toBe(310);
    expect(ctx.memoryIndex.lines).toBe(3);
  });

  it('memory が無ければ索引は 0 行(画面はこの行を出さない)', () => {
    expect(sessionContext(secs, [], emptyClaudeMd, 'proj-a').memoryIndex.lines).toBe(0);
  });

  it('公式仕様の上限をそのまま載せる(200 行 / 25KB)', () => {
    const ctx = sessionContext(secs, [], emptyClaudeMd, 'proj-a');
    expect(ctx.memoryIndex.limitLines).toBe(200);
    expect(ctx.memoryIndex.limitBytes).toBe(25 * 1024);
  });

  it('CLAUDE.md は走査の合計をそのまま使う', () => {
    const ctx = sessionContext(secs, [], { layers: [], tokens: 1180 }, 'proj-a');
    expect(ctx.claudeMd.tok).toBe(1180);
  });
});

/*
 * 母集団の食い違いは「選んだプロジェクトの Section が 1 つも無い」ときに出る
 * (定義 0 件のプロジェクトは scanSections が落とすので、選んでも id が一致しない)。
 * 以前は memoryIndex だけ全プロジェクトを合算するフォールバックがあり、description が user だけに
 * 縮むのに索引だけ全件、という状態になっていた(レビュー 2 周目の指摘。新テストが isCurrent 付きの
 * memory しか渡していなかったのでこの分岐に入っていなかった)。
 */
describe('sessionContext(選んだプロジェクトの Section が無いとき)', () => {
  const secs = [section('proj-a', 'project', [item('a', 100)]), section('user', 'user', [])];

  it('memoryIndex も 0 行に落とす(全プロジェクトを合算しない)', () => {
    const ctx = sessionContext(
      secs,
      [memSection('a', 310, 3, false), memSection('b', 999, 9, false)],
      emptyClaudeMd,
      'proj-empty',
    );
    expect(ctx.memoryIndex.tok).toBe(0);
    expect(ctx.memoryIndex.lines).toBe(0);
  });

  it('3 つの内訳が同じ母集団を見る(description も 0)', () => {
    const ctx = sessionContext(secs, [memSection('a', 310, 3, false)], emptyClaudeMd, 'proj-empty');
    expect(ctx.descriptions.tok).toBe(0);
    expect(ctx.memoryIndex.tok).toBe(0);
  });
});

/*
 * ?project=<id> の解決(計画 16 判断 2)。サーバーは生のパスを受け取らず、候補
 * (listProjects = ~/.claude.json の登録簿 + cwd)を projectSectionId で突き合わせるだけ。
 * 一致しないものは全部 cwd に落ちるので、「?project= に任意のパスを渡して読ませる」経路が無い。
 * scan.ts は HOME を import 時に固定するので、環境を差し替えてから動的 import する。
 */
describe('resolveSelectedProject (?project= の解決)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-selected-'));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'work', 'alpha');
  const other = path.join(tmp, 'work', 'beta');
  const unregistered = path.join(tmp, 'work', 'gamma');
  let mod: typeof import('../src/server/index');

  beforeAll(async () => {
    for (const d of [home, cwd, other, unregistered]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ projects: { [cwd]: {}, [other]: {} } }),
    );
    vi.resetModules();
    vi.stubEnv('HOME', home);
    mod = await import('../src/server/index');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('登録済みプロジェクトの id はそのパスに解決する', () => {
    expect(mod.resolveSelectedProject(cwd, projectSectionId(other))).toBe(other);
  });

  it("省略・'all'・未知の id はすべて cwd に落ちる", () => {
    expect(mod.resolveSelectedProject(cwd, null)).toBe(cwd);
    expect(mod.resolveSelectedProject(cwd, 'all')).toBe(cwd);
    expect(mod.resolveSelectedProject(cwd, 'user')).toBe(cwd);
    expect(mod.resolveSelectedProject(cwd, 'proj-0')).toBe(cwd);
    // 実在するが登録簿に無いディレクトリの id も通さない(候補との一致だけが根拠)
    expect(mod.resolveSelectedProject(cwd, projectSectionId(unregistered))).toBe(cwd);
  });

  it('生のパスは解決しない(パスを渡して読ませる経路を作らない)', () => {
    expect(mod.resolveSelectedProject(cwd, other)).toBe(cwd);
    expect(mod.resolveSelectedProject(cwd, 'proj-' + other)).toBe(cwd);
    expect(mod.resolveSelectedProject(cwd, path.join(other, 'CLAUDE.md'))).toBe(cwd);
    expect(mod.resolveSelectedProject(cwd, '../beta')).toBe(cwd);
  });

  it('候補には cwd 自身も入る(登録簿に無くても既定の選択は成立する)', () => {
    const outside = path.join(tmp, 'work', 'delta');
    fs.mkdirSync(outside, { recursive: true });
    expect(mod.projectCandidates(outside)).toContain(outside);
    expect(mod.resolveSelectedProject(outside, projectSectionId(outside))).toBe(outside);
  });
});

/*
 * 棚卸し(POST /api/memory-triage)の対象解決(計画 16)。一覧は選んだプロジェクトを起点に
 * 走査するので、棚卸しだけ cwd 固定だと autoMemoryDirectory の置き場が引けない
 * ── 画面には出ているのに not-found、という食い違いをここで塞ぐ。
 * 起点の指定は ?project= と同じ Section.id で、解決は resolveSelectedProject に任せる。
 */
describe('triageTarget (棚卸しの対象は選んだプロジェクトを起点に探す)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-triage-target-'));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'work', 'alpha');
  const other = path.join(tmp, 'work', 'beta');
  const store = path.join(tmp, 'beta-memory'); // beta だけが設定している置き場
  let mod: typeof import('../src/server/index');
  let storeId: string;

  beforeAll(async () => {
    for (const d of [home, cwd, path.join(other, '.claude'), store])
      fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ projects: { [cwd]: {}, [other]: {} } }),
    );
    fs.writeFileSync(
      path.join(other, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryDirectory: store }),
    );
    fs.writeFileSync(path.join(store, 'MEMORY.md'), '- [note](note.md) — beta の memory\n');
    fs.writeFileSync(path.join(store, 'note.md'), '本文');
    // 置き場セクションの id は置き場パス由来(既定走査の slug と衝突しないための接頭辞つき)
    storeId = 'auto-' + encodeProjectPath(store);
    vi.resetModules();
    vi.stubEnv('HOME', home);
    mod = await import('../src/server/index');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('別の登録済みプロジェクトの id を渡すと、その置き場のセクションが対象になる', () => {
    const r = mod.triageTarget(cwd, projectSectionId(other), storeId);
    expect(r.root).toBe(other);
    expect(r.section?.note).toBe(store);
    expect(r.section?.items.map((it) => it.name)).toEqual(['note']);
  });

  it('省略・未知の id は cwd に落ちる(cwd からは beta の置き場が見えない)', () => {
    for (const id of [null, 'proj-0', store]) {
      const r = mod.triageTarget(cwd, id, storeId);
      expect(r.root).toBe(cwd);
      expect(r.section).toBeUndefined();
    }
  });
});
