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
