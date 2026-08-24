import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assertManagedPath, assertReadableMd, uniqueDest } from '../src/server/manage';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-manage-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function make(rel: string, content = 'x'): string {
  const fp = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content);
  return fp;
}

describe('assertManagedPath (コピー/削除のパス検証)', () => {
  it('skills / commands / agents 配下を kind 付きで許可する', () => {
    expect(assertManagedPath(make('p/.claude/skills/foo/SKILL.md')).kind).toBe('skill');
    expect(assertManagedPath(make('p/.claude/commands/bar.md')).kind).toBe('command');
    expect(assertManagedPath(make('p/.claude/agents/baz.md')).kind).toBe('agent');
  });

  it('.claude 外・plugin 配下はエラーコード付きで拒否する', () => {
    expect(() => assertManagedPath(make('p/outside.md'))).toThrow('not-managed-path');
    expect(() => assertManagedPath(make('h/.claude/plugins/x/skills/s/SKILL.md'))).toThrow(
      'plugin-managed',
    );
  });

  it('存在しないパスは not-found', () => {
    expect(() => assertManagedPath(path.join(tmp, 'no-such-file.md'))).toThrow('not-found');
  });
});

describe('assertReadableMd (md 読み取りの検証)', () => {
  it('.claude 配下の .md は plugin でも許可する', () => {
    const fp = make('h/.claude/plugins/x/skills/s2/SKILL.md');
    expect(assertReadableMd(fp)).toContain('SKILL.md');
  });

  it('.md 以外・.claude 外はエラーコード付きで拒否する', () => {
    expect(() => assertReadableMd(make('p/.claude/settings.json', '{}'))).toThrow('not-md');
    expect(() => assertReadableMd(make('p/free.md'))).toThrow('not-readable-path');
  });
});

/*
 * 計画 13 Phase D: autoMemoryDirectory で memory の置き場が .claude の外へ移った環境でも
 * 本文を読めること(読めないと一覧に出るのに fetchFile・棚卸しモーダル・エディタで開くが全滅する)。
 * 解決は cwd 側の settings.local.json を最優先に読むので、専用の cwd を作って設定を置く。
 */
describe('assertReadableMd (autoMemoryDirectory の置き場)', () => {
  const autoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-manage-automem-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-manage-cwd-'));
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
    const otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-manage-other-'));
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-manage-otherstore-'));
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

describe('uniqueDest (-copy サフィックス)', () => {
  it('空きがあればそのまま、既存なら -copy, -copy2 と採番する', () => {
    const base = path.join(tmp, 'dest', 'note.md');
    expect(uniqueDest(base, true)).toBe(base);
    make('dest/note.md');
    expect(uniqueDest(base, true)).toBe(path.join(tmp, 'dest', 'note-copy.md'));
    make('dest/note-copy.md');
    expect(uniqueDest(base, true)).toBe(path.join(tmp, 'dest', 'note-copy2.md'));
  });

  it('ディレクトリ(skill)にも同じ規則を適用する', () => {
    const dir = path.join(tmp, 'dest', 'myskill');
    fs.mkdirSync(dir, { recursive: true });
    expect(uniqueDest(dir, false)).toBe(path.join(tmp, 'dest', 'myskill-copy'));
  });
});
