import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  allowedPath,
  assertAiReadableMd,
  assertOpenablePath,
  assertReadableMd,
} from '../src/server/read-access';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-read-access-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function make(rel: string, content = 'x'): string {
  const fp = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content);
  return fp;
}

describe('assertReadableMd (md 読み取りの検証)', () => {
  it('.claude 配下の .md は plugin でも許可する', () => {
    const fp = make('h/.claude/plugins/x/skills/s2/SKILL.md');
    expect(assertReadableMd(fp)).toContain('SKILL.md');
  });

  it('.md 以外・.claude 外はエラーコード付きで拒否する', () => {
    expect(() => assertReadableMd(make('p/.claude/settings.json', '{}'))).toThrow('not-md');
    expect(() => assertReadableMd(make('p/free.md'))).toThrow('not-readable-path');
  });

  it('存在しないパスは not-found', () => {
    expect(() => assertReadableMd(path.join(tmp, 'no-such-file.md'))).toThrow('not-found');
  });
});

/*
 * 計画 13 Phase D: autoMemoryDirectory で memory の置き場が .claude の外へ移った環境でも
 * 本文を読めること(読めないと一覧に出るのに fetchFile・棚卸しモーダル・エディタで開くが全滅する)。
 * 解決は cwd 側の settings.local.json を最優先に読むので、専用の cwd を作って設定を置く。
 */
describe('assertReadableMd (autoMemoryDirectory の置き場)', () => {
  const autoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-read-access-automem-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-read-access-cwd-'));
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, '.claude', 'settings.local.json'),
    JSON.stringify({ autoMemoryDirectory: autoDir }),
  );
  afterAll(() => {
    fs.rmSync(autoDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('置き場配下の .md は .claude の外でも読める', () => {
    const fp = path.join(autoDir, 'handoff.md');
    fs.writeFileSync(fp, '---\nname: handoff\n---\n本文');
    // realpath 前方一致(temp は symlink 経由のことがある)で許可されること
    expect(assertReadableMd(fp, cwd)).toBe(fs.realpathSync(fp));
  });

  it('置き場の外(.claude 配下でもない)は従来どおり拒否する', () => {
    const outside = make('automem-outside/free.md');
    expect(() => assertReadableMd(outside, cwd)).toThrow('not-readable-path');
    // 兄弟ディレクトリ(<dir> と前方一致するが区切りが無い)も拒否する
    const sibling = autoDir + '-other';
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, 'x.md'), 'x');
    expect(() => assertReadableMd(path.join(sibling, 'x.md'), cwd)).toThrow('not-readable-path');
    fs.rmSync(sibling, { recursive: true, force: true });
  });

  it('別の置き場を指す cwd では、この置き場配下でも拒否する(許可は解決結果に紐づく)', () => {
    const otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-read-access-other-'));
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-read-access-otherstore-'));
    fs.mkdirSync(path.join(otherCwd, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(otherCwd, '.claude', 'settings.local.json'),
      JSON.stringify({ autoMemoryDirectory: otherDir }),
    );
    const fp = path.join(autoDir, 'handoff.md');
    expect(() => assertReadableMd(fp, otherCwd)).toThrow('not-readable-path');
    fs.rmSync(otherCwd, { recursive: true, force: true });
    fs.rmSync(otherDir, { recursive: true, force: true });
  });
});

/*
 * 計画 15 Phase E2: CLAUDE.md 画面は <project>/CLAUDE.md・CLAUDE.local.md・親ディレクトリの CLAUDE.md の
 * 本文も /api/file で読む。これらは .claude の外にあるので、走査(claude-md.ts)が列挙したファイルに限って
 * 許可する。同じディレクトリの他の .md や、走査に載らない名前は従来どおり拒否する。
 */
describe('assertReadableMd (CLAUDE.md 群)', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-read-access-claudemd-'));
  afterAll(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const make2 = (rel: string, content = 'x') => {
    const fp = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content);
    return fp;
  };

  it('走査に載る <project>/CLAUDE.md と CLAUDE.local.md は読める', () => {
    const root = make2('CLAUDE.md', '# root');
    const local = make2('CLAUDE.local.md', '# local');
    expect(assertReadableMd(root, cwd)).toBe(fs.realpathSync(root));
    expect(assertReadableMd(local, cwd)).toBe(fs.realpathSync(local));
  });

  it('同じディレクトリでも走査に載らない .md は拒否する', () => {
    expect(() => assertReadableMd(make2('README.md'), cwd)).toThrow('not-readable-path');
    expect(() => assertReadableMd(make2('docs/CLAUDE.md'), cwd)).toThrow('not-readable-path');
  });

  it('別の cwd から見た <project>/CLAUDE.md は拒否する(許可は走査結果に紐づく)', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-read-access-claudemd-other-'));
    const fp = path.join(cwd, 'CLAUDE.md');
    expect(() => assertReadableMd(fp, other)).toThrow('not-readable-path');
    fs.rmSync(other, { recursive: true, force: true });
  });
});

/*
 * AI に本文を送ってよい範囲(assertAiReadableMd)は、表示のための読み取りより狭い。
 * CLAUDE.local.md は通常 gitignore される私的なファイルなので、画面には出しても claude CLI には
 * 渡さない ── README Security の約束をここで固定する(レビュー 2 周目の指摘。実装を
 * 表示用と同じ広さに戻しても全テストが緑のままだった)。
 */
describe('assertAiReadableMd (AI に送ってよい範囲は表示より狭い)', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-ai-readable-'));
  const autoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-ai-readable-automem-'));
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, '.claude', 'settings.local.json'),
    JSON.stringify({ autoMemoryDirectory: autoDir }),
  );
  const put = (rel: string, content = 'x') => {
    const fp = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content);
    return fp;
  };
  afterAll(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(autoDir, { recursive: true, force: true });
  });

  it('.claude 配下の定義本文は送ってよい', () => {
    const fp = put('.claude/skills/x/SKILL.md', '---\nname: x\n---\n本文');
    expect(assertAiReadableMd(fp, cwd)).toBe(fs.realpathSync(fp));
  });

  it('autoMemoryDirectory 配下の memory も送ってよい(棚卸しが読む)', () => {
    const fp = path.join(autoDir, 'note.md');
    fs.writeFileSync(fp, '本文');
    expect(assertAiReadableMd(fp, cwd)).toBe(fs.realpathSync(fp));
  });

  it('CLAUDE.md 群は表示できても送らない(CLAUDE.local.md は私的なファイル)', () => {
    const root = put('CLAUDE.md', '# root');
    const local = put('CLAUDE.local.md', '# local');
    // 表示は通る
    expect(assertReadableMd(root, cwd)).toBe(fs.realpathSync(root));
    expect(assertReadableMd(local, cwd)).toBe(fs.realpathSync(local));
    // AI には渡らない
    expect(() => assertAiReadableMd(root, cwd)).toThrow('not-readable-path');
    expect(() => assertAiReadableMd(local, cwd)).toThrow('not-readable-path');
  });

  it('.md 以外は not-md', () => {
    expect(() => assertAiReadableMd(path.join(cwd, '.claude', 'settings.local.json'), cwd)).toThrow(
      'not-md',
    );
  });
});

/*
 * allowedPath は GET /api/diff の境界判定。削除済みファイルの過去の内容を出すのが目的なので
 * 実在を前提にできないが、実在するなら解決後のパスで見る ── 字句一致だけで通すと、
 * 経路に .claude を含む symlink が別の場所を指しているとき /api/file と許可範囲が食い違う。
 */
describe('allowedPath (実在すれば realpath で、消えていれば字句で)', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-allowed-path-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-allowed-path-outside-'));
  afterAll(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('.claude 配下の実在ファイルは許可する', () => {
    const fp = path.join(cwd, '.claude', 'skills', 'x', 'SKILL.md');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, 'x');
    expect(allowedPath(fp, cwd)).toBe(true);
  });

  it('消えていても .claude 配下のパスなら許可する(差分の主役)', () => {
    expect(allowedPath(path.join(cwd, '.claude', 'skills', 'gone', 'SKILL.md'), cwd)).toBe(true);
  });

  it('消えていて境界の外なら許可しない', () => {
    expect(allowedPath(path.join(cwd, 'docs', 'gone.md'), cwd)).toBe(false);
  });

  it('境界の外を指す symlink が .claude 配下にあっても許可しない', () => {
    fs.writeFileSync(path.join(outside, 'private.md'), 'CONFIDENTIAL');
    const link = path.join(cwd, '.claude', 'link');
    fs.symlinkSync(outside, link);
    expect(allowedPath(path.join(link, 'private.md'), cwd)).toBe(false);
  });

  it('境界の中を指す symlink は外から来ていても許可する(/api/file と同じ広さ)', () => {
    const real = path.join(cwd, '.claude', 'skills', 'y', 'SKILL.md');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, 'x');
    const link = path.join(outside, 'alias.md');
    fs.symlinkSync(real, link);
    expect(allowedPath(link, cwd)).toBe(true);
  });
});

/*
 * 消えた CLAUDE.md の扱い。走査(claudeMdPaths)は existsSync で絞るので、消えたパスは
 * 許可の対象にならない。`.claude` 配下は字句で通るので、同じ「消えた CLAUDE.md」でも
 * 置き場所で差分の可否が変わる ── その非対称をここに固定しておく(直すなら走査側に
 * 「存在で絞らない列挙」を足す必要があり、許可の広がりを伴う)。
 */
describe('allowedPath (消えた CLAUDE.md の非対称)', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-gone-claudemd-'));
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  afterAll(() => fs.rmSync(cwd, { recursive: true, force: true }));

  it('.claude 配下なら消えていても許可する(差分が取れる)', () => {
    expect(allowedPath(path.join(cwd, '.claude', 'CLAUDE.md'), cwd)).toBe(true);
    expect(allowedPath(path.join(cwd, '.claude', 'rules', 'gone.md'), cwd)).toBe(true);
  });

  it('.claude の外(<project>/CLAUDE.md・CLAUDE.local.md)は消えると許可されない', () => {
    expect(allowedPath(path.join(cwd, 'CLAUDE.md'), cwd)).toBe(false);
    expect(allowedPath(path.join(cwd, 'CLAUDE.local.md'), cwd)).toBe(false);
  });

  it('存在していれば <project>/CLAUDE.md は許可される(走査が列挙するため)', () => {
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '# root');
    expect(allowedPath(path.join(cwd, 'CLAUDE.md'), cwd)).toBe(true);
  });
});

/*
 * assertOpenablePath は openInEditor の入口だが、エディタを実起動するので openInEditor 経由では
 * テストできない。assertReadableMd と違って拡張子を問わない(settings.json も開ける)のが要点で、
 * ここを壊すと「.md しか開けなくなる」か「境界の外まで開けてしまう」のどちらかに倒れる。
 * 判断: production の非公開関数を export した(read-access.ts、report 参照)。ロジックは変えていない。
 */
describe('assertOpenablePath (エディタで開ける範囲は拡張子を問わない)', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-openable-'));
  afterAll(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const put = (rel: string, content = 'x') => {
    const fp = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content);
    return fp;
  };

  it('.claude 配下は .md 以外(settings.json)も開ける', () => {
    const fp = put('.claude/settings.json', '{}');
    expect(assertOpenablePath(fp, cwd)).toBe(fs.realpathSync(fp));
  });

  it('autoMemoryDirectory 配下も開ける', () => {
    const autoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-openable-automem-'));
    const memCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-openable-memcwd-'));
    fs.mkdirSync(path.join(memCwd, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(memCwd, '.claude', 'settings.local.json'),
      JSON.stringify({ autoMemoryDirectory: autoDir }),
    );
    const fp = path.join(autoDir, 'handoff.md');
    fs.writeFileSync(fp, '本文');
    expect(assertOpenablePath(fp, memCwd)).toBe(fs.realpathSync(fp));
    fs.rmSync(autoDir, { recursive: true, force: true });
    fs.rmSync(memCwd, { recursive: true, force: true });
  });

  it('境界の外は not-openable-path で拒否する', () => {
    const fp = put('free.txt');
    expect(() => assertOpenablePath(fp, cwd)).toThrow('not-openable-path');
  });

  it('存在しないパスは not-found', () => {
    expect(() => assertOpenablePath(path.join(cwd, '.claude', 'no-such.json'), cwd)).toThrow(
      'not-found',
    );
  });
});

/*
 * 計画 16 判断 4(レビュー 1 周目で縮めた): 許可の母集団は cwd と「選んだプロジェクト」の 2 つだけ。
 * 選んだプロジェクトの CLAUDE.md と自動メモリはホーム ② が見せるので読めなければならないが、
 * 選んでいないプロジェクトの設定に許可を握らせてはいけない ── autoMemoryDirectory は
 * commit 済みの .claude/settings.json からも読むため、登録簿全体を母集団にすると
 * 「clone しただけのリポジトリ」がホーム直下の別ディレクトリを許可範囲に足せる。
 * scan.ts は HOME を import 時に固定するので、環境を差し替えてから動的 import する。
 */
describe('読み取り許可の母集団(cwd と選んだプロジェクトだけ)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-read-access-registry-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'alpha');
  const other = path.join(root, 'beta');
  const store = path.join(root, 'beta-memory'); // beta の autoMemoryDirectory
  const unregistered = path.join(root, 'gamma');
  let mod: typeof import('../src/server/read-access');

  beforeAll(async () => {
    for (const d of [home, cwd, other, store, unregistered]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ projects: { [cwd]: {}, [other]: {} } }),
    );
    fs.mkdirSync(path.join(other, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(other, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryDirectory: store }),
    );
    fs.writeFileSync(path.join(other, 'CLAUDE.md'), '# beta');
    fs.writeFileSync(path.join(other, 'CLAUDE.local.md'), '# beta local');
    fs.writeFileSync(path.join(store, 'note.md'), '本文');
    fs.writeFileSync(path.join(unregistered, 'CLAUDE.md'), '# gamma');
    fs.writeFileSync(path.join(unregistered, 'free.md'), 'x');
    vi.resetModules();
    vi.stubEnv('HOME', home);
    mod = await import('../src/server/read-access');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('選んだプロジェクトの CLAUDE.md は読める(cwd でなくても)', () => {
    const fp = path.join(other, 'CLAUDE.md');
    expect(mod.assertReadableMd(fp, cwd, other)).toBe(fs.realpathSync(fp));
    expect(mod.allowedPath(fp, cwd, other)).toBe(true);
    expect(mod.assertOpenablePath(fp, cwd, other)).toBe(fs.realpathSync(fp));
  });

  it('選んだプロジェクトが設定した置き場の memory も読める', () => {
    const fp = path.join(store, 'note.md');
    expect(mod.assertReadableMd(fp, cwd, other)).toBe(fs.realpathSync(fp));
  });

  /*
   * ここが縮めた分の要。登録済みでも「選んでいない」プロジェクトの CLAUDE.md と
   * その settings が指す置き場は、許可されない(実装を登録簿全体に戻すとここが落ちる)。
   */
  it('登録済みでも選んでいないプロジェクトのものは読めない', () => {
    for (const fp of [path.join(other, 'CLAUDE.md'), path.join(store, 'note.md')]) {
      expect(() => mod.assertReadableMd(fp, cwd)).toThrow('not-readable-path');
      expect(mod.allowedPath(fp, cwd)).toBe(false);
      expect(() => mod.assertOpenablePath(fp, cwd)).toThrow('not-openable-path');
    }
    // 別のプロジェクト(cwd 自身)を選んでいる場合も同じ
    expect(() => mod.assertReadableMd(path.join(other, 'CLAUDE.md'), cwd, cwd)).toThrow(
      'not-readable-path',
    );
  });

  it('未登録のプロジェクトのパスは CLAUDE.md でも拒む', () => {
    expect(() => mod.assertReadableMd(path.join(unregistered, 'CLAUDE.md'), cwd)).toThrow(
      'not-readable-path',
    );
    expect(() => mod.assertReadableMd(path.join(unregistered, 'free.md'), cwd)).toThrow(
      'not-readable-path',
    );
    // 選んでいるプロジェクトでも、走査に載らない名前は従来どおり通さない
    fs.writeFileSync(path.join(other, 'README.md'), '# readme');
    expect(() => mod.assertReadableMd(path.join(other, 'README.md'), cwd, other)).toThrow(
      'not-readable-path',
    );
  });

  /*
   * AI 送信用の集合は広げ方が違う: 置き場だけを「選んだプロジェクト」まで広げ、CLAUDE.md 群は
   * 入れない(表示のみ。README Security の約束)。実装を表示用と同じ広さに戻すとここが落ちる。
   */
  it('assertAiReadableMd は置き場だけ広げ、CLAUDE.md 群は通さない', () => {
    const mem = path.join(store, 'note.md');
    expect(mod.assertAiReadableMd(mem, cwd, other)).toBe(fs.realpathSync(mem));
    expect(() => mod.assertAiReadableMd(mem, cwd)).toThrow('not-readable-path');
    for (const name of ['CLAUDE.md', 'CLAUDE.local.md']) {
      const fp = path.join(other, name);
      // 表示は通るのに AI には渡らない、という非対称をここで固定する
      expect(mod.assertReadableMd(fp, cwd, other)).toBe(fs.realpathSync(fp));
      expect(() => mod.assertAiReadableMd(fp, cwd, other)).toThrow('not-readable-path');
    }
  });
});

/*
 * clone しただけのリポジトリが HOME 直下の別ディレクトリを許可範囲に足せないこと
 * (レビュー 1 周目の実測。母集団を登録簿全体にしていた版はここが素通りした)。
 *
 * `.claude/settings.json` は commit 済み = clone に含まれるファイルなので、その中の
 * autoMemoryDirectory は「利用者が設定した値」とは限らない。~/Documents のような HOME 直下の
 * 兄弟は下限ガード(ルート / HOME 自身 / HOME の祖先)では弾けないので、母集団の側で閉じる。
 */
describe('clone した悪意あるリポジトリが許可範囲を広げられない', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-read-access-evil-'));
  const home = path.join(root, 'home');
  const docs = path.join(home, 'Documents'); // HOME 直下の兄弟(下限ガードは通る)
  const benign = path.join(root, 'work', 'benign');
  const evil = path.join(root, 'work', 'evil');
  const secret = path.join(docs, 'tax-notes.md');
  let mod: typeof import('../src/server/read-access');

  beforeAll(async () => {
    for (const d of [
      home,
      docs,
      path.join(benign, '.claude', 'skills', 'a'),
      path.join(evil, '.claude'),
    ])
      fs.mkdirSync(d, { recursive: true });
    // evil は登録簿に載っているだけ(cwd でも選択でもない)
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ projects: { [benign]: {}, [evil]: {} } }),
    );
    fs.writeFileSync(
      path.join(evil, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryDirectory: docs }),
    );
    fs.writeFileSync(secret, '# Tax notes\nbank account 1234\n');
    vi.resetModules();
    vi.stubEnv('HOME', home);
    mod = await import('../src/server/read-access');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('登録簿にあるだけの settings は許可を広げない(表示・AI・エディタとも)', () => {
    expect(() => mod.assertReadableMd(secret, benign)).toThrow('not-readable-path');
    expect(() => mod.assertAiReadableMd(secret, benign)).toThrow('not-readable-path');
    expect(() => mod.assertOpenablePath(secret, benign)).toThrow('not-openable-path');
    expect(mod.allowedPath(secret, benign)).toBe(false);
  });

  it('そのプロジェクトを選んだときだけ開く(意図「選べるものは読める」は保つ)', () => {
    expect(mod.assertReadableMd(secret, benign, evil)).toBe(fs.realpathSync(secret));
    expect(mod.assertAiReadableMd(secret, benign, evil)).toBe(fs.realpathSync(secret));
  });
});
