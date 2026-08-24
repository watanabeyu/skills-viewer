import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mainWorktreeOf, scanMemory } from '../src/server/memory';
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
    // 末尾の [[a[[handoff]] は文字クラス([^\][]+)の回帰ガード: 'a[[handoff' を拾ってはいけない
    '本文。関連: [[handoff]] [[wiki-mcp-curl]] [[missing-one]] [[handoff]] [[a[[handoff]]',
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

// 逆引きできないプロジェクト不明(削除済みプロジェクト)
const dirOrphan = memDir('-Users-me-gone');
write(dirOrphan, 'MEMORY.md', '- [gone](g.md) — 消えたプロジェクト');
write(dirOrphan, 'g.md', '---\nname: gone\ndescription: 消えたプロジェクトのメモ\n---\n\n本文\n');

// memory ディレクトリが無いプロジェクト(除外される)
fs.mkdirSync(path.join(root, '-Users-me-nomemory'), { recursive: true });

// MEMORY.md(索引)だけがあるプロジェクト。アイテムが 0 件なのでセクションにしない
write(memDir('-Users-me-indexonly'), 'MEMORY.md', '- [none](none.md) — 本文が残っていない');

const sections = scanMemory(projB, { root, projects: [projA, projB], mainWorktree: null });
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

  it('cwd のプロジェクトが current で先頭、プロジェクト不明は末尾', () => {
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
    // [[a[[handoff]] は内側だけを拾う(文字クラスを [^\]]+ に緩めると 'a[[handoff' が入る)
    expect(it.links).toContain('handoff');
    expect(it.links).not.toContain('a[[handoff');
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
    expect(
      scanMemory(projA, { root: path.join(tmp, 'nope'), projects: [projA], mainWorktree: null }),
    ).toEqual([]);
  });
});

/* worktree(.git がファイル)から起動しても親リポジトリの memory を current にできること */
describe('mainWorktreeOf (.git だけからメインワークツリーを解決する)', () => {
  const gitTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-worktree-'));
  afterAll(() => fs.rmSync(gitTmp, { recursive: true, force: true }));
  const main = path.join(gitTmp, 'main');
  const wt = path.join(gitTmp, 'wt');
  fs.mkdirSync(path.join(main, '.git', 'worktrees', 'wt'), { recursive: true });
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: ' + path.join(main, '.git', 'worktrees', 'wt'));

  it('.git がファイル(worktree)なら gitdir から親のルートを返す', () => {
    expect(mainWorktreeOf(wt)).toBe(main);
  });

  it('.git がディレクトリ(通常のリポジトリ)なら自分自身', () => {
    expect(mainWorktreeOf(main)).toBe(main);
  });

  it('.git が無い / gitdir が worktree の形でなければ null', () => {
    expect(mainWorktreeOf(path.join(gitTmp, 'nogit'))).toBeNull();
    const sub = path.join(gitTmp, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    // submodule の .git ファイル(…/.git/modules/<name>)は worktree ではない
    fs.writeFileSync(
      path.join(sub, '.git'),
      'gitdir: ' + path.join(main, '.git', 'modules', 'sub'),
    );
    expect(mainWorktreeOf(sub)).toBeNull();
  });
});

describe('scanMemory (worktree から起動したとき)', () => {
  it('メインワークツリーの memory を current にし、projects に無くても逆引きできる', () => {
    const wtRoot = path.join(tmp, 'wt-projects');
    const mainProj = path.join(tmp, 'work', 'main-repo');
    const worktree = path.join(tmp, 'work', 'main-repo-feat-a');
    fs.mkdirSync(mainProj, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    const dir = path.join(wtRoot, encodeProjectPath(mainProj), 'memory');
    fs.mkdirSync(dir, { recursive: true });
    write(dir, 'MEMORY.md', '- [memo](m.md) — メモ');
    write(dir, 'm.md', '---\nname: memo\ndescription: メモ\n---\n\n本文\n');

    // projects には worktree 側しか無い(~/.claude.json に親が登録されていない状況)
    const secs = scanMemory(worktree, {
      root: wtRoot,
      projects: [worktree],
      mainWorktree: mainProj,
    });
    expect(secs).toHaveLength(1);
    expect(secs[0].projectPath).toBe(mainProj);
    expect(secs[0].isCurrent).toBe(true);
    expect(secs[0].orphan).toBeUndefined();
  });

  it('worktree 用の memory もあれば両方 current で、cwd 完全一致が先頭', () => {
    const wtRoot = path.join(tmp, 'wt2-projects');
    const mainProj = path.join(tmp, 'work2', 'aaa-main');
    const worktree = path.join(tmp, 'work2', 'zzz-feat');
    fs.mkdirSync(mainProj, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    for (const [proj, file] of [
      [mainProj, 'main.md'],
      [worktree, 'wt.md'],
    ]) {
      const dir = path.join(wtRoot, encodeProjectPath(proj), 'memory');
      fs.mkdirSync(dir, { recursive: true });
      write(dir, 'MEMORY.md', `- [x](${file}) — メモ`);
      write(dir, file, '---\nname: x\ndescription: メモ\n---\n\n本文\n');
    }
    const secs = scanMemory(worktree, {
      root: wtRoot,
      projects: [mainProj, worktree],
      mainWorktree: mainProj,
    });
    // 名前順(aaa-main < zzz-feat)ではなく cwd → メインワークツリーの順に並ぶ
    expect(secs.map((s) => s.projectPath)).toEqual([worktree, mainProj]);
    expect(secs.every((s) => s.isCurrent)).toBe(true);
  });
});

/*
 * Phase A(計画 13): otherProjects フィルタの安全化。
 *   - 入れ子プロジェクト(親子関係)は除外(除外は従来 worktree 関係だけだった)
 *   - 自分の memory dir slug と同じ slug になるプロジェクトは除外(encodeProjectPath(p) === d.name)。
 *     slug が衝突する(非英数字が全て `-` に正規化されるため `dup_a` と `dup-a` は同じ slug になる)
 *     2 プロジェクトが登録されている場合、byEncoded で負けた側(projectPath には解決されない側)も
 *     このセクションの「別プロジェクト」候補には残ってはいけない
 */
describe('scanMemory (otherProjects フィルタの安全化)', () => {
  it('入れ子プロジェクト(親子関係)は otherProjects から除外され、配下パス参照で other-project シグナルが付かない', () => {
    const nestRoot = path.join(tmp, 'nest-projects');
    const parent = path.join(tmp, 'nest-work', 'parent');
    const child = path.join(tmp, 'nest-work', 'parent', 'child');
    fs.mkdirSync(child, { recursive: true });
    const dir = path.join(nestRoot, encodeProjectPath(parent), 'memory');
    fs.mkdirSync(dir, { recursive: true });
    write(dir, 'MEMORY.md', '- [x](x.md) — メモ');
    write(
      dir,
      'x.md',
      '---\nname: x\ndescription: メモ\n---\n\n本文: ' +
        path.join(child, 'src', 'app.ts') +
        ' を確認\n',
    );
    const secs = scanMemory(parent, {
      root: nestRoot,
      projects: [parent, child],
      mainWorktree: null,
    });
    const sec = secs.find((s) => s.projectPath === parent)!;
    const item = sec.items.find((x) => x.name === 'x')!;
    expect((item.signals || []).some((s) => s.kind === 'other-project')).toBe(false);
  });

  it('slug が衝突する登録プロジェクトは、byEncoded で負けた側も otherProjects から除外される', () => {
    const dupRoot = path.join(tmp, 'dup-projects');
    const dupA = path.join(tmp, 'dup-work', 'dup_a'); // byEncoded で負ける側(先に処理される)
    const dupB = path.join(tmp, 'dup-work', 'dup-a'); // byEncoded で勝つ側(同じ slug で後勝ち)
    fs.mkdirSync(dupA, { recursive: true });
    fs.mkdirSync(dupB, { recursive: true });
    const slug = encodeProjectPath(dupB);
    expect(encodeProjectPath(dupA)).toBe(slug); // 前提: 非英数字は全て `-` になるので衝突する
    const dir = path.join(dupRoot, slug, 'memory');
    fs.mkdirSync(dir, { recursive: true });
    write(dir, 'MEMORY.md', '- [x](x.md) — メモ');
    write(
      dir,
      'x.md',
      '---\nname: x\ndescription: メモ\n---\n\n本文: ' +
        path.join(dupA, 'src', 'app.ts') +
        ' を確認\n',
    );
    const secs = scanMemory(dupB, { root: dupRoot, projects: [dupA, dupB], mainWorktree: null });
    const sec = secs.find((s) => s.id === slug)!;
    expect(sec.projectPath).toBe(dupB); // 後勝ちで dupB に解決される
    const item = sec.items.find((x) => x.name === 'x')!;
    expect((item.signals || []).some((s) => s.kind === 'other-project')).toBe(false);
  });

  /* 計画 13 検証節の再現シナリオ: プロジェクト不明 + 本文が自分の配下パスを参照 → 付かない */
  it('プロジェクト不明(未登録の子リポジトリ)は、本文が自分の配下パスを参照しても登録済みの親に other-project が付かない', () => {
    const orphRoot = path.join(tmp, 'orph-projects');
    const parent = path.join(tmp, 'orph-work', 'parent'); // 登録済み
    const child = path.join(tmp, 'orph-work', 'parent', 'child'); // 未登録(登録抹消・未マウントの想定)
    fs.mkdirSync(child, { recursive: true });
    const dir = path.join(orphRoot, encodeProjectPath(child), 'memory');
    fs.mkdirSync(dir, { recursive: true });
    write(dir, 'MEMORY.md', '- [x](x.md) — メモ');
    write(
      dir,
      'x.md',
      '---\nname: x\ndescription: メモ\n---\n\n本文: ' +
        path.join(child, 'src', 'app.ts') +
        ' を確認\n',
    );
    const secs = scanMemory(path.join(tmp, 'orph-work'), {
      root: orphRoot,
      projects: [parent],
      mainWorktree: null,
    });
    const sec = secs.find((s) => s.id === encodeProjectPath(child))!;
    expect(sec.orphan).toBe(true);
    expect(sec.projectPath).toBe(null);
    const item = sec.items.find((x) => x.name === 'x')!;
    expect((item.signals || []).some((s) => s.kind === 'other-project')).toBe(false);
  });

  it('プロジェクト不明(メイン未登録)は、登録済みの自リポジトリ worktree に other-project が付かない', () => {
    const wtRoot = path.join(tmp, 'wt-projects');
    const mainRepo = path.join(tmp, 'wt-work', 'repo'); // 未登録(memory dir の slug はこちら基準)
    const wt = path.join(tmp, 'wt-work', 'feat-x'); // メインの linked worktree。これだけ登録
    fs.mkdirSync(mainRepo, { recursive: true });
    fs.mkdirSync(wt, { recursive: true });
    // linked worktree の .git ファイル(mainWorktreeOf は git コマンドを呼ばずこれだけを読む)
    fs.writeFileSync(
      path.join(wt, '.git'),
      'gitdir: ' + path.join(mainRepo, '.git', 'worktrees', 'feat-x') + '\n',
    );
    const dir = path.join(wtRoot, encodeProjectPath(mainRepo), 'memory');
    fs.mkdirSync(dir, { recursive: true });
    write(dir, 'MEMORY.md', '- [x](x.md) — メモ');
    write(
      dir,
      'x.md',
      '---\nname: x\ndescription: メモ\n---\n\n本文: ' +
        path.join(wt, 'src', 'app.ts') +
        ' を確認\n',
    );
    // mainWorktree を注入しない = mainOf が実際に .git ファイルを読む経路を通す
    const secs = scanMemory(path.join(tmp, 'wt-work'), { root: wtRoot, projects: [wt] });
    const sec = secs.find((s) => s.id === encodeProjectPath(mainRepo))!;
    expect(sec.orphan).toBe(true);
    const item = sec.items.find((x) => x.name === 'x')!;
    expect((item.signals || []).some((s) => s.kind === 'other-project')).toBe(false);
  });

  /* 過剰除外の番犬: path.sep 境界を落とす変異(/s/b が /s/bc を配下扱い)で fail する肯定テスト */
  it('区切りの無い兄弟(/s/b と /s/bc)は除外されず、配下パス参照で other-project が付く(値はフルパス)', () => {
    const sibRoot = path.join(tmp, 'sib-projects');
    const b = path.join(tmp, 'sib-work', 'b');
    const bc = path.join(tmp, 'sib-work', 'bc');
    fs.mkdirSync(b, { recursive: true });
    fs.mkdirSync(bc, { recursive: true });
    const dir = path.join(sibRoot, encodeProjectPath(b), 'memory');
    fs.mkdirSync(dir, { recursive: true });
    write(dir, 'MEMORY.md', '- [x](x.md) — メモ');
    write(
      dir,
      'x.md',
      '---\nname: x\ndescription: メモ\n---\n\n本文: ' +
        path.join(bc, 'src', 'app.ts') +
        ' を確認\n',
    );
    const secs = scanMemory(b, { root: sibRoot, projects: [b, bc], mainWorktree: null });
    const sec = secs.find((s) => s.projectPath === b)!;
    const item = sec.items.find((x) => x.name === 'x')!;
    const sig = (item.signals || []).find((s) => s.kind === 'other-project');
    expect(sig?.value).toBe(bc);
  });

  /* 変異の番犬: orphan で other-project を全滅させる退行(return false)で fail する肯定テスト */
  it('プロジェクト不明でも、無関係な登録プロジェクトへの参照には other-project が付く(値はフルパス)', () => {
    const opRoot = path.join(tmp, 'op-projects');
    const mine = path.join(tmp, 'op-work', 'mine'); // 未登録(このセクションの実体)
    const elsewhere = path.join(tmp, 'op-work', 'elsewhere'); // 登録済み・無関係
    fs.mkdirSync(mine, { recursive: true });
    fs.mkdirSync(elsewhere, { recursive: true });
    const dir = path.join(opRoot, encodeProjectPath(mine), 'memory');
    fs.mkdirSync(dir, { recursive: true });
    write(dir, 'MEMORY.md', '- [x](x.md) — メモ');
    write(
      dir,
      'x.md',
      '---\nname: x\ndescription: メモ\n---\n\n本文: ' +
        path.join(elsewhere, 'src', 'app.ts') +
        ' を確認\n',
    );
    const secs = scanMemory(path.join(tmp, 'op-work'), {
      root: opRoot,
      projects: [elsewhere],
      mainWorktree: null,
    });
    const sec = secs.find((s) => s.id === encodeProjectPath(mine))!;
    expect(sec.orphan).toBe(true);
    const item = sec.items.find((x) => x.name === 'x')!;
    const sig = (item.signals || []).find((s) => s.kind === 'other-project');
    expect(sig?.value).toBe(elsewhere);
  });

  /* 変異の番犬: slug 前方一致の区切り `-` を落とす過剰除外(…-appx が …-app の配下扱い)で fail する */
  it('プロジェクト不明の slug 前方一致は区切り付き: 兄弟 …/app(orphan は …/appx)は除外されない', () => {
    const swRoot = path.join(tmp, 'sw-projects');
    const appx = path.join(tmp, 'sw-work', 'appx'); // 未登録(このセクションの実体)
    const app = path.join(tmp, 'sw-work', 'app'); // 登録済みの兄弟(slug は区切り無しなら appx の前方一致)
    fs.mkdirSync(appx, { recursive: true });
    fs.mkdirSync(app, { recursive: true });
    const dir = path.join(swRoot, encodeProjectPath(appx), 'memory');
    fs.mkdirSync(dir, { recursive: true });
    write(dir, 'MEMORY.md', '- [x](x.md) — メモ');
    write(
      dir,
      'x.md',
      '---\nname: x\ndescription: メモ\n---\n\n本文: ' +
        path.join(app, 'src', 'app.ts') +
        ' を確認\n',
    );
    const secs = scanMemory(path.join(tmp, 'sw-work'), {
      root: swRoot,
      projects: [app],
      mainWorktree: null,
    });
    const sec = secs.find((s) => s.id === encodeProjectPath(appx))!;
    expect(sec.orphan).toBe(true);
    const item = sec.items.find((x) => x.name === 'x')!;
    const sig = (item.signals || []).find((s) => s.kind === 'other-project');
    expect(sig?.value).toBe(app);
  });

  it('入れ子の逆方向: 子プロジェクトの memory が親配下のパスを参照しても other-project は付かない', () => {
    const revRoot = path.join(tmp, 'rev-projects');
    const parent = path.join(tmp, 'rev-work', 'parent');
    const child = path.join(tmp, 'rev-work', 'parent', 'child');
    fs.mkdirSync(child, { recursive: true });
    const dir = path.join(revRoot, encodeProjectPath(child), 'memory');
    fs.mkdirSync(dir, { recursive: true });
    write(dir, 'MEMORY.md', '- [x](x.md) — メモ');
    write(
      dir,
      'x.md',
      '---\nname: x\ndescription: メモ\n---\n\n本文: ' +
        path.join(parent, 'docs', 'guide.md') +
        ' を確認\n',
    );
    const secs = scanMemory(child, {
      root: revRoot,
      projects: [parent, child],
      mainWorktree: null,
    });
    const sec = secs.find((s) => s.projectPath === child)!;
    const item = sec.items.find((x) => x.name === 'x')!;
    expect((item.signals || []).some((s) => s.kind === 'other-project')).toBe(false);
  });
});
