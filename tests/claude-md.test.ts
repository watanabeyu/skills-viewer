/*
 * CLAUDE.md 群の走査。この開発環境には CLAUDE.md が 1 枚も無い(7 段すべて不在)ので、
 * 実環境ではなく一時ディレクトリのフィクスチャで確かめる。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { claudeMdLayers, claudeMdPaths, claudeMdRefs } from '../src/server/claude-md';
import type { ClaudeMdLayerKind } from '../src/shared/types';

let dir: string;
let home: string;
let root: string;
/* 管理ポリシーは OS 固定パスなので、テストでは存在しない場所に向けて「無い」を確かめる */
let managedPath: string;

function write(fp: string, body: string): string {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, body);
  return fp;
}

function layer(kind: ClaudeMdLayerKind, opts: Parameters<typeof claudeMdLayers>[0] = {}) {
  const scan = claudeMdLayers({ home, root, managedPath, ...opts });
  return scan.layers.find((l) => l.kind === kind)!;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csb-claudemd-'));
  home = path.join(dir, 'home');
  root = path.join(dir, 'proj');
  managedPath = path.join(dir, 'no-such-managed', 'CLAUDE.md');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('claudeMdLayers — 7 段の列挙', () => {
  it('1 枚も無ければ全段が files: [] で、合計は 0(「なし」の行を出せるように段自体は残す)', () => {
    const scan = claudeMdLayers({ home, root, managedPath });
    expect(scan.layers.map((l) => l.kind)).toEqual([
      'managed',
      'user',
      'project',
      'project-dot',
      'local',
      'rules',
      'parent',
    ]);
    expect(scan.layers.every((l) => l.files.length === 0)).toBe(true);
    expect(scan.tokens).toBe(0);
  });

  it('注入順に並び、存在する段だけ files が埋まる', () => {
    write(path.join(home, '.claude', 'CLAUDE.md'), '# user\nhello');
    write(path.join(root, 'CLAUDE.md'), '# project\nhello');
    write(path.join(root, '.claude', 'CLAUDE.md'), '# project-dot\nhello');
    write(path.join(root, 'CLAUDE.local.md'), '# local\nhello');
    const scan = claudeMdLayers({ home, root, managedPath });
    const filled = scan.layers.filter((l) => l.files.length).map((l) => l.kind);
    expect(filled).toEqual(['user', 'project', 'project-dot', 'local']);
    expect(scan.tokens).toBeGreaterThan(0);
  });

  it('root が無ければ管理ポリシーと user の 2 段だけを見る', () => {
    const scan = claudeMdLayers({ home, root: null, managedPath });
    expect(scan.layers.map((l) => l.kind)).toEqual(['managed', 'user']);
  });

  it('管理ポリシーは本文を返さず、存在と概算だけ扱う', () => {
    const managed = path.join(dir, 'managed', 'CLAUDE.md');
    write(managed, '# managed\n## 節\n本文');
    const l = layer('managed', { managedPath: managed });
    expect(l.files[0].bodyWithheld).toBe(true);
    expect(l.files[0].headings).toEqual([]);
    expect(l.files[0].tokens).toBeGreaterThan(0);
  });
});

describe('見出しごとの概算', () => {
  it('見出しから次の見出しの直前までを 1 節として数える', () => {
    write(path.join(root, 'CLAUDE.md'), '# 基本方針\n本文A\n\n## 言語\n本文B\n');
    const f = layer('project').files[0];
    expect(f.headings.map((h) => h.text)).toEqual(['基本方針', '言語']);
    expect(f.headings.every((h) => h.tokens > 0)).toBe(true);
  });
});

describe('rules 段', () => {
  it('paths: が無いものだけを常時コストに数え、paths: 付きは lazy として残す', () => {
    write(path.join(root, '.claude', 'rules', 'always.md'), '# always\n本文');
    write(
      path.join(root, '.claude', 'rules', 'lazy.md'),
      '---\npaths:\n  - "src/**/*.ts"\n---\n# lazy\n本文',
    );
    const l = layer('rules');
    expect(l.files.map((f) => path.basename(f.path))).toEqual(['always.md', 'lazy.md']);
    expect(l.files.find((f) => f.path.endsWith('lazy.md'))!.lazy).toBe(true);
    expect(l.files.find((f) => f.path.endsWith('always.md'))!.lazy).toBeUndefined();
    // 合計は always.md の分だけ
    expect(l.tokens).toBe(l.files.find((f) => f.path.endsWith('always.md'))!.tokens);
  });

  it('paths: の値は YAML リストで既存パーサが読めないので、キーの有無で判定する', () => {
    // 値が空文字列になる形。真偽値で判定すると取りこぼす
    write(path.join(root, '.claude', 'rules', 'a.md'), '---\npaths:\n  - "x"\n---\n本文');
    expect(layer('rules').files[0].lazy).toBe(true);
  });

  it('rules ディレクトリが無ければ空', () => {
    expect(layer('rules').files).toEqual([]);
  });
});

describe('@import の展開', () => {
  it('参照先の中身を数え、深さを記録する', () => {
    write(path.join(root, 'common.md'), 'shared body');
    write(path.join(root, 'CLAUDE.md'), '# p\n@./common.md\n');
    const f = layer('project').files[0];
    expect(f.imports).toHaveLength(1);
    expect(f.imports[0].exists).toBe(true);
    expect(f.imports[0].depth).toBe(1);
    expect(f.tokens).toBe(f.ownTokens + f.imports[0].tokens);
  });

  it('循環(経路に自分が居る)は cycle で打ち切る', () => {
    write(path.join(root, 'a.md'), '@./b.md');
    write(path.join(root, 'b.md'), '@./a.md');
    write(path.join(root, 'CLAUDE.md'), '@./a.md');
    const f = layer('project').files[0];
    const cyclic = f.imports.filter((im) => im.skipped === 'cycle');
    expect(cyclic).toHaveLength(1);
    expect(cyclic[0].tokens).toBe(0);
  });

  /*
   * 経路が違うのに同じファイルが再登場する形(ダイヤモンド参照)。二重計上はしないが
   * 循環ではないので、画面に「循環参照」と出さないよう別の印にする。
   */
  it('ダイヤモンド参照は duplicate で、cycle と言い分ける', () => {
    write(path.join(root, 'shared.md'), 'shared body');
    write(path.join(root, 'a.md'), '@./shared.md');
    write(path.join(root, 'b.md'), '@./shared.md');
    write(path.join(root, 'CLAUDE.md'), '@./a.md\n@./b.md');
    const f = layer('project').files[0];
    expect(f.imports.filter((im) => im.skipped === 'cycle')).toHaveLength(0);
    const dup = f.imports.filter((im) => im.skipped === 'duplicate');
    expect(dup).toHaveLength(1);
    expect(dup[0].tokens).toBe(0);
    // shared.md は 1 回だけ数える
    const counted = f.imports.filter((im) => im.tokens > 0 && im.path.endsWith('shared.md'));
    expect(counted).toHaveLength(1);
  });

  it('同じ参照を 2 行書いても 1 回だけ数える', () => {
    write(path.join(root, 'common.md'), 'body');
    write(path.join(root, 'CLAUDE.md'), '@./common.md\n@./common.md');
    const f = layer('project').files[0];
    expect(f.imports.filter((im) => im.tokens > 0)).toHaveLength(1);
    expect(f.imports.filter((im) => im.skipped === 'duplicate')).toHaveLength(1);
  });

  /* 公式仕様の 4 段。数値そのものを固定する(上限を減らしても落ちるように) */
  it('4 段まで展開し、5 段目で打ち切る', () => {
    for (let i = 1; i <= 6; i++) write(path.join(root, `l${i}.md`), `body ${i}\n@./l${i + 1}.md`);
    write(path.join(root, 'CLAUDE.md'), '@./l1.md');
    const f = layer('project').files[0];
    expect(f.imports.filter((im) => im.tokens > 0)).toHaveLength(4);
    const cut = f.imports.find((im) => im.skipped === 'depth')!;
    expect(cut.depth).toBe(5);
    // 打ち切った分はコストに混ざらない
    const sum = f.imports.reduce((n, im) => n + im.tokens, 0);
    expect(f.tokens).toBe(f.ownTokens + sum);
  });

  /*
   * 参照の末尾から句読点を落とす処理が正規表現(`[.,;:)\]]+$`)だと、長い「.」の連なりで
   * バックトラックして入力長の 2 乗になる。200KB の 1 行で 9 秒、待受スレッドが丸ごと止まり、
   * ページを開くたびに再発した(レビュー 2 周目の実測)。CLAUDE.md は clone してきた
   * リポジトリから来るので、この形は仕込める。
   */
  it('句読点の連なりで時間が爆発しない(入力長に線形)', () => {
    write(path.join(root, 'CLAUDE.md'), '@' + 'a'.repeat(100000) + '.'.repeat(100000) + 'b');
    const started = Date.now();
    const f = layer('project').files[0];
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(1000);
    // 長すぎる参照は解決にも行かない(realpath / stat を無駄に叩かない)
    expect(f.imports).toEqual([]);
  });

  /* 参照 1 件ごとに realpath + stat が走るので、扇形に広い CLAUDE.md で件数を打ち切る */
  it('1 ファイルから拾う参照は 200 件で打ち切る', () => {
    write(
      path.join(root, 'CLAUDE.md'),
      Array.from({ length: 500 }, (_, i) => `@./n${i}.md`).join('\n'),
    );
    const ims = layer('project').files[0].imports;
    expect(ims).toHaveLength(200);
    // 打ち切るのは末尾。先頭から順に拾うので、本文の印との対応がずれない
    expect(ims[0].ref).toBe('./n0.md');
    expect(ims[199].ref).toBe('./n199.md');
  });

  /*
   * 走査 1 回ぶんの総数の上限。ファイル単位の上限だけだと、rules 段が .claude/rules/*.md を
   * 件数の制限なく回すので「200 本 × 200 件」で元の木阿弥になる(レビュー 3 周目の実測:
   * 40,000 要素 / 8.6MB / 1.2 秒)。予算は段をまたいで共有する。
   */
  it('@import 行の総数は走査全体で 500 件に収まる(段をまたいで共有する)', () => {
    // rules 段に 200 本、それぞれ 200 参照。ファイル単位の上限だけなら 40,000 件になる
    for (let i = 0; i < 200; i++) {
      write(
        path.join(root, '.claude', 'rules', `r${i}.md`),
        Array.from({ length: 200 }, (_, j) => `@./miss${j}.md`).join('\n'),
      );
    }
    const scan = claudeMdLayers({ home, root, managedPath });
    const total = scan.layers.flatMap((l) => l.files).reduce((n, f) => n + f.imports.length, 0);
    expect(total).toBe(500);
  });

  it('存在しない参照は exists: false で残す(コストは 0)', () => {
    write(path.join(root, 'CLAUDE.md'), '@./missing.md');
    const f = layer('project').files[0];
    expect(f.imports[0].exists).toBe(false);
    expect(f.imports[0].tokens).toBe(0);
  });

  it('コードブロック内の @ は参照として拾わない', () => {
    write(path.join(root, 'other.md'), 'x');
    write(path.join(root, 'CLAUDE.md'), '```\n@./other.md\n```\n');
    expect(layer('project').files[0].imports).toEqual([]);
  });

  /*
   * CLAUDE.md は clone したリポジトリから来るファイルなので、@/etc/hosts のような参照を
   * 素直に読むと境界の外を読んだうえに存在とサイズをブラウザへ返してしまう。
   */
  it('プロジェクト配下と ~/.claude 配下の外は out-of-scope で読まない', () => {
    const outside = path.join(dir, 'elsewhere', 'secret.md');
    write(outside, 'private');
    write(path.join(root, 'CLAUDE.md'), `@${outside}`);
    const im = layer('project').files[0].imports[0];
    expect(im.skipped).toBe('out-of-scope');
    expect(im.tokens).toBe(0);
  });

  /*
   * 公式の除外規則はバッククォート(memory.md「writing `@README` keeps the text literal,
   * while @README outside backticks imports the file」)。拡張子もスラッシュも無い @README は
   * 参照として扱う ── ここを「パスに見えるものだけ」に狭めると公式が読むものを数え落とす。
   */
  it('拡張子もスラッシュも無い @README も参照として扱う', () => {
    write(path.join(root, 'README'), 'readme body');
    write(path.join(root, 'CLAUDE.md'), 'See @README for the overview.');
    const im = layer('project').files[0].imports[0];
    expect(im.ref).toBe('README');
    expect(im.exists).toBe(true);
    expect(im.tokens).toBeGreaterThan(0);
  });

  it('コードスパン(バッククォート)の中は参照として拾わない', () => {
    write(path.join(root, 'README'), 'readme body');
    write(path.join(root, 'CLAUDE.md'), 'Mention `@README` without importing it.');
    expect(layer('project').files[0].imports).toEqual([]);
  });

  it('散文の @名前 は解決に失敗して exists: false の行になる(境界の外は開かない)', () => {
    write(path.join(root, 'CLAUDE.md'), '@alice に聞く。');
    const im = layer('project').files[0].imports[0];
    expect(im.ref).toBe('alice');
    expect(im.exists).toBe(false);
    expect(im.tokens).toBe(0);
  });

  /*
   * 公式は 4 MiB 超の CLAUDE.md を読まない。viewer もそこに揃える。
   * 「超えたら読まない」だけでなく「未満なら読む」も見る ── 片側だけだと上限を
   * 小さくする退行(以前の 256KB に戻す等)が素通りする。
   */
  it('4 MiB を超える大きさは too-large で読まない', () => {
    write(path.join(root, 'big.md'), 'x'.repeat(4 * 1024 * 1024 + 16));
    write(path.join(root, 'CLAUDE.md'), '@./big.md');
    const im = layer('project').files[0].imports[0];
    expect(im.skipped).toBe('too-large');
    expect(im.tokens).toBe(0);
  });

  it('4 MiB 未満は上限に掛からず展開する(300KB)', () => {
    write(path.join(root, 'mid.md'), 'x'.repeat(300 * 1024));
    write(path.join(root, 'CLAUDE.md'), '@./mid.md');
    const im = layer('project').files[0].imports[0];
    expect(im.skipped).toBeUndefined();
    expect(im.tokens).toBeGreaterThan(0);
  });

  /*
   * 本体側にも同じ上限を掛ける(以前は @import 先にしか掛かっていなかった)。
   * ただし段から消してはいけない: claudeMdRefs は段の files から現在のキーを作るので、
   * 消すと差分追跡が「CLAUDE.md が消えた」と誤って出す。存在は残してコストだけ 0 にする。
   */
  it('本体が 4 MiB を超える段は読まないが、存在は残す(tok は 0)', () => {
    write(path.join(root, 'CLAUDE.md'), 'x'.repeat(4 * 1024 * 1024 + 16));
    const l = layer('project');
    expect(l.tokens).toBe(0);
    expect(l.files).toHaveLength(1);
    expect(l.files[0].tooLarge).toBe(true);
    expect(l.files[0].headings).toEqual([]);
    // 差分追跡のキーからも消えない
    const scan = claudeMdLayers({ home, root, managedPath });
    expect(claudeMdRefs(scan, home).map((r) => r.path)).toContain(path.join(root, 'CLAUDE.md'));
  });

  it('~ 始まりは home から解決する(~/.claude 配下は境界の中)', () => {
    write(path.join(home, '.claude', 'shared.md'), 'shared');
    write(path.join(root, 'CLAUDE.md'), '@~/.claude/shared.md');
    const f = layer('project').files[0];
    expect(f.imports[0].exists).toBe(true);
    expect(f.imports[0].path).toBe(fs.realpathSync(path.join(home, '.claude', 'shared.md')));
  });

  /* home 直下は ~/.claude の外。境界外は解決先の存在もフルパスも返さない(覗く材料にしない) */
  it('~ 始まりでも ~/.claude の外は out-of-scope、存在もパスも漏らさない', () => {
    const outside = path.join(home, 'private.md');
    write(outside, 'private');
    write(path.join(root, 'CLAUDE.md'), '@~/private.md');
    const im = layer('project').files[0].imports[0];
    expect(im.skipped).toBe('out-of-scope');
    expect(im.exists).toBe(false);
    expect(im.tokens).toBe(0);
    // 返すのは「要求されたパスを素直に解決した結果」であって symlink の先ではない。
    // realpathSync との比較は TMPDIR が symlink かどうかに依存するので使わない
    expect(im.path).toBe(path.join(home, 'private.md'));
  });

  /* 境界の中に置いた symlink が外を指す形。realpath 後の再判定で落ちる */
  it('プロジェクト内の symlink が外を指していても out-of-scope(リンク先のパスも返さない)', () => {
    const outside = path.join(dir, 'elsewhere', 'secret.md');
    write(outside, 'private');
    const link = path.join(root, 'aliased.md');
    fs.symlinkSync(outside, link);
    write(path.join(root, 'CLAUDE.md'), '@./aliased.md');
    const im = layer('project').files[0].imports[0];
    expect(im.skipped).toBe('out-of-scope');
    expect(im.exists).toBe(false);
    expect(im.path).toBe(link);
  });

  /* 名前だけを見ると .aws/credentials や .ssh/id_rsa が素通りする(レビュー 3 周目の指摘) */
  it('ドットで始まるディレクトリの配下も開かない', () => {
    write(path.join(root, '.aws', 'credentials'), 'aws_secret_access_key = x');
    write(path.join(root, '.ssh', 'id_rsa'), 'PRIVATE KEY');
    write(path.join(root, 'CLAUDE.md'), '@./.aws/credentials\n@./.ssh/id_rsa');
    for (const im of layer('project').files[0].imports) {
      expect(im.skipped).toBe('out-of-scope');
      expect(im.exists).toBe(false);
      expect(im.tokens).toBe(0);
    }
  });

  /* .claude は境界の定義に使うディレクトリなので、その配下の正当な参照は通す */
  it('.claude 配下の普通のファイルは開ける(境界そのもののディレクトリ)', () => {
    write(path.join(home, '.claude', 'rules', 'shared.md'), 'shared body');
    write(path.join(root, 'CLAUDE.md'), '@~/.claude/rules/shared.md');
    const im = layer('project').files[0].imports[0];
    expect(im.skipped).toBeUndefined();
    expect(im.tokens).toBeGreaterThan(0);
  });

  /* 境界の中でも秘密が入る場所は開かない(.git 配下・ドットで始まるファイル) */
  it('.git 配下とドットで始まるファイルは境界の中でも開かない', () => {
    write(path.join(root, '.git', 'config'), '[core]');
    write(path.join(root, '.env'), 'SECRET=1');
    write(path.join(home, '.claude', '.credentials.json'), '{"token":"x"}');
    write(path.join(root, 'CLAUDE.md'), '@./.git/config\n@./.env\n@~/.claude/.credentials.json');
    const ims = layer('project').files[0].imports;
    expect(ims).toHaveLength(3);
    for (const im of ims) {
      expect(im.skipped).toBe('out-of-scope');
      expect(im.exists).toBe(false);
      expect(im.tokens).toBe(0);
    }
  });
});

describe('親ディレクトリの段', () => {
  it('git root まで遡る(その間の CLAUDE.md を拾う)', () => {
    const repo = path.join(dir, 'repo');
    const sub = path.join(repo, 'packages', 'app');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(sub, { recursive: true });
    write(path.join(repo, 'CLAUDE.md'), '# repo root');
    write(path.join(repo, 'packages', 'CLAUDE.md'), '# packages');
    const l = layer('parent', { root: sub });
    expect(l.files.map((f) => path.dirname(f.path))).toEqual([path.join(repo, 'packages'), repo]);
  });

  /*
   * 最も普通の形(プロジェクトルート = git root)。以前はここで親を 1 件拾ってしまい、
   * 読み取り許可がリポジトリの外へ広がっていた(レビュー 2026-09-09 の指摘)。
   */
  it('root 自身が git root なら親は 1 件も拾わない', () => {
    const outside = path.join(dir, 'outside');
    const repo = path.join(outside, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    write(path.join(outside, 'CLAUDE.md'), '# 親(git root の外)');
    write(path.join(repo, 'CLAUDE.md'), '# repo');
    expect(layer('parent', { root: repo }).files).toEqual([]);
    // 許可リストにも入らない
    expect(claudeMdPaths({ home, root: repo })).toEqual([path.join(repo, 'CLAUDE.md')]);
  });

  it('git 管理外なら 1 つ上だけ見る', () => {
    const outer = path.join(dir, 'outer');
    const inner = path.join(outer, 'inner');
    fs.mkdirSync(inner, { recursive: true });
    write(path.join(outer, 'CLAUDE.md'), '# outer');
    write(path.join(dir, 'CLAUDE.md'), '# too far');
    const l = layer('parent', { root: inner });
    expect(l.files.map((f) => f.path)).toEqual([path.join(outer, 'CLAUDE.md')]);
  });

  it('ホームより上には出ない', () => {
    const inHome = path.join(home, 'proj');
    fs.mkdirSync(inHome, { recursive: true });
    write(path.join(home, 'CLAUDE.md'), '# home');
    expect(layer('parent', { root: inHome }).files).toEqual([]);
  });
});

describe('claudeMdRefs — 差分追跡へ渡す参照', () => {
  it('管理ポリシーは追跡しない(OS が配るもので利用者の変更対象ではない)', () => {
    const managed = path.join(dir, 'managed', 'CLAUDE.md');
    write(managed, '# managed');
    write(path.join(root, 'CLAUDE.md'), '# project');
    const refs = claudeMdRefs(claudeMdLayers({ home, root, managedPath: managed }), home);
    expect(refs.map((r) => r.path)).toEqual([path.join(root, 'CLAUDE.md')]);
  });

  it('~/.claude 配下は user、それ以外は project', () => {
    write(path.join(home, '.claude', 'CLAUDE.md'), '# user');
    write(path.join(root, 'CLAUDE.md'), '# project');
    const refs = claudeMdRefs(claudeMdLayers({ home, root, managedPath }), home);
    expect(refs.map((r) => r.source)).toEqual(['user', 'project']);
    expect(refs.every((r) => r.exists)).toBe(true);
  });

  it('遅延ロードの rules も追跡する(変わったら知りたい)', () => {
    write(path.join(root, '.claude', 'rules', 'lazy.md'), '---\npaths:\n  - "x"\n---\n本文');
    const refs = claudeMdRefs(claudeMdLayers({ home, root, managedPath }), home);
    expect(refs.map((r) => path.basename(r.path))).toEqual(['lazy.md']);
  });
});

/*
 * 読み取り許可の判定(read-access.ts)が使う軽い列挙。claudeMdLayers を呼ぶと
 * 1 リクエストごとに全文の読み取りと @import の展開が走るので、パスだけを返す道を持つ。
 */
describe('claudeMdPaths — 許可判定用のパス列挙', () => {
  it('存在するものだけを返し、管理ポリシーは含めない', () => {
    const managed = path.join(dir, 'managed', 'CLAUDE.md');
    write(managed, '# managed');
    write(path.join(home, '.claude', 'CLAUDE.md'), '# user');
    write(path.join(root, 'CLAUDE.md'), '# project');
    write(path.join(root, 'CLAUDE.local.md'), '# local');
    write(path.join(root, '.claude', 'rules', 'a.md'), '# rule');
    const got = claudeMdPaths({ home, root });
    expect(got).toEqual([
      path.join(home, '.claude', 'CLAUDE.md'),
      path.join(root, 'CLAUDE.md'),
      path.join(root, 'CLAUDE.local.md'),
      path.join(root, '.claude', 'rules', 'a.md'),
    ]);
    expect(got).not.toContain(managed);
  });

  it('1 枚も無ければ空', () => {
    expect(claudeMdPaths({ home, root })).toEqual([]);
  });

  it('claudeMdLayers が列挙したファイルと一致する(許可漏れ・過剰許可を防ぐ)', () => {
    write(path.join(home, '.claude', 'CLAUDE.md'), '# user');
    write(path.join(root, 'CLAUDE.md'), '# project');
    write(path.join(root, '.claude', 'CLAUDE.md'), '# project-dot');
    write(path.join(root, '.claude', 'rules', 'a.md'), '# rule');
    write(path.join(root, '.claude', 'rules', 'b.md'), '---\npaths:\n  - "x"\n---\n# lazy');
    const fromLayers = claudeMdLayers({ home, root, managedPath })
      .layers.filter((l) => l.kind !== 'managed')
      .flatMap((l) => l.files.map((f) => f.path));
    expect(claudeMdPaths({ home, root }).sort()).toEqual(fromLayers.sort());
  });

  it('親ディレクトリの探索範囲も layers と揃う(git root まで)', () => {
    const repo = path.join(dir, 'repo');
    const sub = path.join(repo, 'packages', 'app');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(sub, { recursive: true });
    write(path.join(repo, 'CLAUDE.md'), '# repo');
    write(path.join(dir, 'CLAUDE.md'), '# too far');
    const got = claudeMdPaths({ home, root: sub });
    expect(got).toContain(path.join(repo, 'CLAUDE.md'));
    expect(got).not.toContain(path.join(dir, 'CLAUDE.md'));
  });
});
