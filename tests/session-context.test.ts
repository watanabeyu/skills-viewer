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

/*
 * transcript(.jsonl)を何回開いたかを数えるための素通しモック。ESM の node:fs は
 * vi.spyOn できない(namespace が configurable でない)ので、モジュールごと差し替えて
 * openSync だけを包む ── 実装は本物をそのまま呼ぶので、他の describe の挙動は変わらない。
 * 使うのは最後の describe(collect が transcript を二度読みしないこと)だけ。
 */
const openedFiles = vi.hoisted(() => [] as string[]);
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      openedFiles.push(String(args[0]));
      return actual.openSync(...args);
    },
  };
});
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
 * id の衝突(レビュー 1 周目)。projectSectionId は英数字以外を '-' に潰す非可逆な変換なので、
 * `foo.bar` と `foo-bar` は同じ id になる。どちらを指しているか決められない以上、
 * 勝手に片方を選ばない ── 選択は読み取り許可の母集団でもあるため、
 * 「利用者が選んだつもりのない方」が開くことがないようにする(未知の id と同じく cwd へ)。
 */
describe('resolveSelectedProject (id が衝突したら cwd に落とす)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-id-collision-'));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'work', 'alpha');
  const dotted = path.join(tmp, 'work', 'foo.bar');
  const dashed = path.join(tmp, 'work', 'foo-bar');
  let mod: typeof import('../src/server/index');

  beforeAll(async () => {
    for (const d of [home, cwd, dotted, dashed]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ projects: { [cwd]: {}, [dotted]: {}, [dashed]: {} } }),
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

  it('同じ id になる候補が 2 つあるときは、どちらも選ばない', () => {
    // 前提: 2 つのパスが同じ id に潰れている
    expect(projectSectionId(dotted)).toBe(projectSectionId(dashed));
    expect(mod.resolveSelectedProject(cwd, projectSectionId(dotted))).toBe(cwd);
  });

  it('衝突が無ければ従来どおり解決する', () => {
    fs.rmSync(dashed, { recursive: true, force: true }); // 実在しない登録は候補から落ちる
    /*
     * 候補一式は ~/.claude.json の mtime を鍵にメモしている(レビュー 2 周目)ので、
     * 登録簿を触らずにディレクトリだけ消しても組み直されない ── 実運用でも「登録済みの
     * ディレクトリを消した」ことは登録簿が動くか再起動するまで反映されない、という限界。
     * ここでは登録簿の mtime を進めて、メモが鍵どおりに捨てられることも同時に見る。
     */
    const registry = path.join(home, '.claude.json');
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(registry, later, later);
    expect(mod.resolveSelectedProject(cwd, projectSectionId(dotted))).toBe(dotted);
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

/*
 * collect の結線(レビュー 1 周目のテストの穴)。sessionScope / sessionContext の単体は
 * 純関数として固めてあったが、「走査の起点が本当に選んだプロジェクトか」はどこも見ていなかった。
 *
 * alpha(cwd)と beta を登録し、beta だけに autoMemoryDirectory と MEMORY.md を置く。
 * ここで固定できるのは、選択を cwd に戻すと結果が変わる 3 点(レビュー 2 周目で言い直した):
 *   - memory の走査起点(scanMemory / memorySections の引数)
 *   - CLAUDE.md の走査起点(claudeMdLayers の root)
 *   - description 予算 = ② の内訳(sessionScope に渡す id)
 * 残る 2 つはここでは見えない ── 正直に書く:
 *   - primeMemoryRoots(selectedPath): 許可ルートを揃えるだけで結果は変わらない
 *     (cwd に戻すと transcript の二度読みが復活する)。下の「二度読みしない」テストで見る
 *   - attachMemoryTriage の sharedEnv(resolveAutoMemoryDir(selectedPath)?.scope === 'user'):
 *     結線を観測するには claude CLI の応答が要るので、値の効き方は
 *     tests/memory-triage.test.ts 側で単体(sharedEnv: true / false)として固定している
 */
describe('collect (走査の起点は選んだプロジェクト)', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sv-collect-')));
  const home = path.join(tmp, 'home');
  const alpha = path.join(tmp, 'work', 'alpha'); // cwd
  const beta = path.join(tmp, 'work', 'beta'); // 選ぶ方
  const store = path.join(tmp, 'beta-memory'); // beta の autoMemoryDirectory
  let mod: typeof import('../src/server/index');
  let data: import('../src/shared/types').SkillsData;

  const skill = (dir: string, name: string, desc: string) => {
    fs.mkdirSync(path.join(dir, '.claude', 'skills', name), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.claude', 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${desc}\n---\n本文\n`,
    );
  };

  beforeAll(async () => {
    for (const d of [home, alpha, beta, store, path.join(beta, '.claude')])
      fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ projects: { [alpha]: {}, [beta]: {} } }),
    );
    // 予算: alpha の description は長く、beta は短い(cwd に戻ると合計が跳ね上がる)
    skill(alpha, 'alpha-skill', 'a'.repeat(400));
    skill(beta, 'beta-skill', 'b'.repeat(40));
    skill(home, 'user-skill', 'u'.repeat(40));
    // CLAUDE.md も長さを変える(トークン合計の出どころが判別できるように)
    fs.writeFileSync(path.join(alpha, 'CLAUDE.md'), '# alpha\n' + 'x'.repeat(4000));
    fs.writeFileSync(path.join(beta, 'CLAUDE.md'), '# beta\n');
    // 自動メモリは beta の設定にだけある
    fs.writeFileSync(
      path.join(beta, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryDirectory: store }),
    );
    fs.writeFileSync(path.join(store, 'MEMORY.md'), '- [note](note.md) — beta の memory\n');
    fs.writeFileSync(path.join(store, 'note.md'), '本文');
    vi.resetModules();
    vi.stubEnv('HOME', home);
    mod = await import('../src/server/index');
    data = mod.collect(alpha, 'en', projectSectionId(beta));
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('選んだプロジェクトが selected として返る(cwd の印は付かない)', () => {
    expect(data.selected).toMatchObject({ id: projectSectionId(beta), path: beta, isCwd: false });
  });

  it('CLAUDE.md は選んだプロジェクトの分を走査する', () => {
    const files = data.claudeMd.layers.flatMap((l) => l.files.map((f) => f.path));
    expect(files).toContain(path.join(beta, 'CLAUDE.md'));
    expect(files).not.toContain(path.join(alpha, 'CLAUDE.md'));
    // ② の内訳は走査の合計をそのまま使う(alpha の 4000 字が混ざれば桁が変わる)
    expect(data.context.claudeMd.tok).toBe(data.claudeMd.tokens);
    expect(data.context.claudeMd.tok).toBeLessThan(100);
  });

  it('memory は選んだプロジェクトの置き場を「現在地」として走査する', () => {
    const current = (data.memory || []).filter((m) => m.isCurrent);
    expect(current.map((m) => m.note)).toEqual([store]);
    expect(data.context.memoryIndex.lines).toBeGreaterThan(0);
    expect(data.context.memoryIndex.tok).toBeGreaterThan(0);
  });

  it('予算は選んだプロジェクト + 共有スコープだけを足す(cwd の分は入らない)', () => {
    const sum = (secs: typeof data.sections) =>
      secs.flatMap((x) => x.items).reduce((n, it) => n + (it.tokens || 0), 0);
    const tok = (id: string) => sum(data.sections.filter((x) => x.id === id));
    const betaTok = tok(projectSectionId(beta));
    const alphaTok = tok(projectSectionId(alpha));
    // 共有スコープ(user / plugin / built-in)は選択に依らず毎セッション入る
    const shared = sum(data.sections.filter((x) => x.source !== 'project'));
    expect(betaTok).toBeGreaterThan(0);
    expect(tok('user')).toBeGreaterThan(0);
    expect(alphaTok).toBeGreaterThan(betaTok); // 取り違えたら気づける差を付けてある
    expect(data.budget.used).toBe(betaTok + shared);
    expect(data.context.descriptions.tok).toBe(betaTok + shared);
  });

  it('省略(cwd)を選ぶと 4 点とも cwd 由来に戻る', () => {
    const onCwd = mod.collect(alpha, 'en', null);
    const files = onCwd.claudeMd.layers.flatMap((l) => l.files.map((f) => f.path));
    expect(onCwd.selected.isCwd).toBe(true);
    expect(files).toContain(path.join(alpha, 'CLAUDE.md'));
    expect((onCwd.memory || []).filter((m) => m.isCurrent).map((m) => m.note)).toEqual([]);
    expect(onCwd.context.memoryIndex.lines).toBe(0);
  });
});

/*
 * ①(前回からの変化)の入力を collect と /api/changes-ack で 1 か所に寄せた(changeInputs)。
 * 入力がずれると「既読にする」を押した直後に同じ差分がまた出る ── Phase D で CLAUDE.md の
 * 追跡が登録簿の全プロジェクトに広がったので、ack 側が cwd の 7 段しか見ていないと
 * 別プロジェクトの CLAUDE.md が永久に「追加」のままになる。
 * snapshot ファイルは一時ディレクトリに向ける(実環境の ~/.cache を触らない)。
 */
describe('changeInputs (collect と ack が同じ入力を見る)', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sv-change-inputs-')));
  const home = path.join(tmp, 'home');
  const alpha = path.join(tmp, 'work', 'alpha'); // cwd
  const beta = path.join(tmp, 'work', 'beta');
  const snap = path.join(tmp, 'snapshot.json');
  let mod: typeof import('../src/server/index');
  let snapMod: typeof import('../src/server/snapshot');

  beforeAll(async () => {
    for (const d of [home, alpha, beta]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ projects: { [alpha]: {}, [beta]: {} } }),
    );
    fs.writeFileSync(path.join(alpha, 'CLAUDE.md'), '# alpha\n');
    fs.writeFileSync(path.join(beta, 'CLAUDE.md'), '# beta\n');
    vi.resetModules();
    vi.stubEnv('HOME', home);
    mod = await import('../src/server/index');
    snapMod = await import('../src/server/snapshot');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const inputs = () => mod.changeInputs(alpha, 'en', mod.projectCandidates(alpha));

  it('cwd 以外の登録済みプロジェクトの CLAUDE.md も参照に含む', () => {
    const paths = inputs().claudeMd.map((c) => c.path);
    expect(paths).toContain(path.join(beta, 'CLAUDE.md'));
    expect(paths).toContain(path.join(alpha, 'CLAUDE.md'));
  });

  it('既読にした直後は差分が出ない(ack と computeChanges の入力が一致する)', () => {
    const i1 = inputs();
    snapMod.ackChanges(i1.sections, i1.memory, i1.claudeMd, snap);
    const i2 = inputs();
    expect(snapMod.computeChanges(i2.sections, i2.memory, i2.claudeMd, snap)).toBeNull();
  });

  it('cwd 以外のプロジェクトに CLAUDE.md が増えれば「追加」になり、既読にすると消える', () => {
    const added = path.join(beta, 'CLAUDE.local.md');
    fs.writeFileSync(added, '# beta local\n');
    const i1 = inputs();
    const ch = snapMod.computeChanges(i1.sections, i1.memory, i1.claudeMd, snap);
    expect(ch?.added.map((e) => e.path)).toContain(added);
    const i2 = inputs();
    snapMod.ackChanges(i2.sections, i2.memory, i2.claudeMd, snap);
    const i3 = inputs();
    expect(snapMod.computeChanges(i3.sections, i3.memory, i3.claudeMd, snap)).toBeNull();
  });
});

/*
 * transcript を二度読みしないこと(レビュー 2 周目)。collect は
 *   1. attributeUsage → scanUsageByDir(skill の実績)
 *   2. memorySections → attributeMemoryUsage → scanMemoryUsage(memory の実績)
 * の 2 回、同じ jsonl を走査する。走査結果のキャッシュ鍵は「自動メモリの許可ルート」なので、
 * この 2 回の間で許可ルートがずれる(= primeMemoryRoots の起点が選択と食い違う)と、
 * 同じファイルを 2 回読み直す ── 実環境の transcript は数百 MB あるので体感に出る。
 * 結果の値には現れない性質なので、読み取り回数そのものを見る
 * (jsonl はチャンク読みなので readFileSync ではなく openSync が 1 ファイル 1 回)。
 */
describe('collect (transcript を二度読みしない)', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sv-transcript-')));
  const home = path.join(tmp, 'home');
  const alpha = path.join(tmp, 'work', 'alpha'); // cwd
  const beta = path.join(tmp, 'work', 'beta'); // 選ぶ方(置き場を設定している)
  const store = path.join(tmp, 'beta-memory');
  const transcripts = path.join(home, '.claude', 'projects');
  let mod: typeof import('../src/server/index');

  beforeAll(async () => {
    for (const d of [home, alpha, path.join(beta, '.claude'), store])
      fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ projects: { [alpha]: {}, [beta]: {} } }),
    );
    fs.writeFileSync(
      path.join(beta, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryDirectory: store }),
    );
    fs.writeFileSync(path.join(store, 'MEMORY.md'), '- [note](note.md) — beta の memory\n');
    fs.writeFileSync(path.join(store, 'note.md'), '本文');
    // 呼び出し元プロジェクトごとに 1 本ずつ(合計 2 本)
    for (const p of [alpha, beta]) {
      const dir = path.join(transcripts, encodeProjectPath(p));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 's1.jsonl'),
        [
          '{"timestamp":"2026-07-20T00:00:00.000Z","tool":{"name":"Skill","input":{"skill":"x"}}}',
          `{"timestamp":"2026-07-20T01:00:00.000Z","tool":{"name":"Read","input":{"file_path":"${path.join(store, 'note.md')}"}}}`,
        ].join('\n'),
      );
    }
    vi.resetModules();
    vi.stubEnv('HOME', home);
    mod = await import('../src/server/index');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('1 回の collect で開く jsonl は transcript の本数と同じ(skill 集計と memory 集計で共用)', () => {
    openedFiles.length = 0; // 他の describe が開いた分は数えない
    mod.collect(alpha, 'en', projectSectionId(beta));
    const opened = openedFiles.filter((p) => p.endsWith('.jsonl'));
    expect(opened).toHaveLength(2); // transcript 2 本 × 1 回
    expect(new Set(opened).size).toBe(2); // 同じファイルを 2 度開いていない
  });
});
