import { describe, expect, it } from 'vitest';
import {
  delegatesOf,
  historyOf,
  hookParts,
  makeResolve,
  shortPath,
  toolName,
  touchesOf,
} from '../web/src/detail';
import type { SkillItem, SnapshotChanges } from '../src/shared/types';

describe('touchesOf (allowed-tools からの機械判定)', () => {
  it('指定が無ければ全ツール(null)で、書き込みも外部も判定しない', () => {
    expect(touchesOf(undefined)).toEqual({ tools: null, writes: [], external: [] });
    expect(touchesOf([])).toEqual({ tools: null, writes: [], external: [] });
  });

  it('Write / Edit は書き込み、Bash / WebFetch は外部。括弧付きの制限は名前で見る', () => {
    const t = touchesOf(['Read', 'Edit', 'Write', 'Bash(git *)', 'Bash(pnpm *)', 'WebFetch']);
    expect(t.tools).toHaveLength(6);
    expect(t.writes).toEqual(['Edit', 'Write']);
    // Bash(git *) と Bash(pnpm *) は 1 つの Bash に寄せる
    expect(t.external).toEqual(['Bash', 'WebFetch']);
  });

  it('読み取りだけの指定は書き込みも外部も空', () => {
    const t = touchesOf(['Read', 'Grep', 'Glob']);
    expect(t.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(t.writes).toEqual([]);
    expect(t.external).toEqual([]);
  });

  it('toolName は括弧より前を取る', () => {
    expect(toolName('Bash(git *)')).toBe('Bash');
    expect(toolName(' Read ')).toBe('Read');
  });
});

describe('delegatesOf (refs + aiRelations)', () => {
  it('静的抽出だけなら references、AI 分類があれば同名はそちらの型に寄せる', () => {
    const d = delegatesOf({
      refs: ['a', 'b'],
      aiRelations: [
        { name: 'b', type: 'delegates', note: 'n' },
        { name: 'c', type: 'invokes', note: '' },
      ],
    });
    expect(d).toEqual([
      { name: 'a', type: 'references', ai: false, note: '' },
      { name: 'b', type: 'delegates', ai: true, note: 'n' },
      { name: 'c', type: 'invokes', ai: true, note: '' },
    ]);
  });
  it('どちらも無ければ空', () => {
    expect(delegatesOf({})).toEqual([]);
  });
});

describe('historyOf (事実の帯「追加・更新」)', () => {
  const it0 = { path: '/p/.claude/skills/x/SKILL.md', kind: 'skill' as const, updatedAt: 1000 };
  const changes: SnapshotChanges = {
    added: [
      {
        name: 'x',
        kind: 'skill',
        path: it0.path,
        source: 'project',
        author: 'alice',
        authoredAt: '2026-09-01T00:00:00Z',
      },
    ],
    updated: [
      { name: 'y', kind: 'skill', path: '/p/.claude/skills/y/SKILL.md', source: 'project' },
    ],
    removed: [],
  };

  it('差分に載っていれば誰が・いつを付ける', () => {
    expect(historyOf(it0, changes)).toEqual({
      mark: 'add',
      who: 'alice',
      when: Date.parse('2026-09-01T00:00:00Z'),
      updatedAt: 1000,
    });
  });

  it('git が引けなかった変化は印だけで、誰が・いつは付かない(非 git / user scope)', () => {
    expect(historyOf({ ...it0, path: '/p/.claude/skills/y/SKILL.md' }, changes)).toEqual({
      mark: 'mod',
      updatedAt: 1000,
    });
  });

  it('差分に無い項目・差分そのものが無い初回は mtime だけ', () => {
    expect(historyOf({ ...it0, path: '/elsewhere.md' }, changes)).toEqual({
      mark: null,
      updatedAt: 1000,
    });
    expect(historyOf(it0, null)).toEqual({ mark: null, updatedAt: 1000 });
  });

  it('同じパスでも kind が違えば別物(memory と skill の取り違え防止)', () => {
    expect(historyOf({ ...it0, kind: 'memory' }, changes).mark).toBeNull();
  });
});

describe('hookParts / shortPath', () => {
  it('hook の name をイベントと matcher に戻す', () => {
    expect(hookParts('PreToolUse (Bash)')).toEqual({ event: 'PreToolUse', matcher: 'Bash' });
    expect(hookParts('SessionStart')).toEqual({ event: 'SessionStart', matcher: '' });
    expect(hookParts('PreToolUse (Edit|Write)')).toEqual({
      event: 'PreToolUse',
      matcher: 'Edit|Write',
    });
  });

  it('cwd 配下のパスは相対にし、外はそのまま', () => {
    expect(shortPath('/w/p/.claude/skills/x/SKILL.md', '/w/p')).toBe('.claude/skills/x/SKILL.md');
    expect(shortPath('/w/p/.claude/skills/x/SKILL.md', '/w/p/')).toBe('.claude/skills/x/SKILL.md');
    expect(shortPath('/home/u/.claude/skills/x/SKILL.md', '/w/p')).toBe(
      '/home/u/.claude/skills/x/SKILL.md',
    );
    // 名前が前方一致するだけの別ディレクトリは剥がさない
    expect(shortPath('/w/p2/a.md', '/w/p')).toBe('/w/p2/a.md');
    expect(shortPath('', '/w/p')).toBe('');
  });
});

/*
 * makeResolve: skill 名を既知アイテムに解決する(委譲先・フロー図の calls 用)。
 * 「他プロジェクトの同名を拾わない」が壊れると、そのセッションから実際には呼べない
 * 別プロジェクトの同名 skill にリンクが張られてしまう(誤誘導)。
 */
type ResolveItem = SkillItem & { secId: string; source: string };
const ritem = (over: Partial<ResolveItem>): ResolveItem => ({
  name: 'foo',
  description: '',
  argumentHint: '',
  version: '',
  kind: 'skill',
  path: '/p.md',
  files: [],
  secId: 'proj-a',
  source: 'project',
  ...over,
});

describe('makeResolve (skill 名 → 既知アイテムの解決)', () => {
  it('同一プロジェクト内の同名を最優先で当てる', () => {
    const self = ritem({ name: 'x', secId: 'proj-a', source: 'project' });
    const sameProj = ritem({ name: 'foo', secId: 'proj-a', source: 'project' });
    const user = ritem({ name: 'foo', secId: 'user', source: 'user' });
    const resolve = makeResolve(self, [self, sameProj, user]);
    expect(resolve('foo')).toBe(sameProj);
  });

  it('他プロジェクトの同名は対象外(そのセッションからは呼べない)', () => {
    const self = ritem({ name: 'x', secId: 'proj-a', source: 'project' });
    const otherProj = ritem({ name: 'foo', secId: 'proj-b', source: 'project' });
    const resolve = makeResolve(self, [self, otherProj]);
    expect(resolve('foo')).toBeUndefined();
  });

  it('同一プロジェクトに無ければ user / plugin / built-in を当てる', () => {
    const self = ritem({ name: 'x', secId: 'proj-a', source: 'project' });
    const otherProj = ritem({ name: 'foo', secId: 'proj-b', source: 'project' });
    const user = ritem({ name: 'foo', secId: 'user', source: 'user' });
    const resolve = makeResolve(self, [self, otherProj, user]);
    expect(resolve('foo')).toBe(user);
  });

  it('`plugin:name` 形式は短い名前でも当たる', () => {
    const self = ritem({ name: 'x', secId: 'proj-a', source: 'project' });
    const plug = ritem({ name: 'myplugin:foo', secId: 'plugin', source: 'plugin' });
    const resolve = makeResolve(self, [self, plug]);
    expect(resolve('foo')).toBe(plug);
  });

  it('先頭の / は剥がして探す', () => {
    const self = ritem({ name: 'x', secId: 'proj-a', source: 'project' });
    const sameProj = ritem({ name: 'foo', secId: 'proj-a', source: 'project' });
    const resolve = makeResolve(self, [self, sameProj]);
    expect(resolve('/foo')).toBe(sameProj);
  });

  it('どこにも見つからなければ undefined', () => {
    const self = ritem({ name: 'x', secId: 'proj-a', source: 'project' });
    const resolve = makeResolve(self, [self]);
    expect(resolve('nope')).toBeUndefined();
  });
});
