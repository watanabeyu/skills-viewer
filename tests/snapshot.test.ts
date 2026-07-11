import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Section } from '../src/shared/types';
import { buildSnapshot, diffSnapshot } from '../src/server/snapshot';
import { dayKey } from '../src/server/usage';

const sec = (items: Section['items']): Section => ({
  id: 'user',
  source: 'user',
  note: '',
  items,
});

const item = (over: Partial<Section['items'][number]>): Section['items'][number] => ({
  name: 'foo',
  description: 'd',
  argumentHint: '',
  version: '',
  kind: 'skill',
  path: '/p/SKILL.md',
  files: [],
  ...over,
});

describe('buildSnapshot', () => {
  it('hook と built-in(path 無し)は対象外', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-'));
    const fp = path.join(dir, 'SKILL.md');
    fs.writeFileSync(fp, 'body');
    const snap = buildSnapshot([
      sec([
        item({ path: fp }),
        item({ name: 'PostToolUse', kind: 'hook', path: '/s.json' }),
        item({ name: 'builtin', path: '' }),
      ]),
    ]);
    expect(Object.keys(snap)).toEqual([fp]);
    expect(snap[fp].hash).toBeTruthy();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('diffSnapshot', () => {
  const e = (name: string, hash: string | null) => ({ name, kind: 'skill' as const, hash });
  it('追加・更新・削除を検出する', () => {
    const prev = { '/a': e('a', 'h1'), '/b': e('b', 'h2'), '/c': e('c', 'h3') };
    const cur = { '/a': e('a', 'h1'), '/b': e('b', 'CHANGED'), '/d': e('d', 'h4') };
    const d = diffSnapshot(prev, cur);
    expect(d.added.map((x) => x.name)).toEqual(['d']);
    expect(d.updated.map((x) => x.name)).toEqual(['b']);
    expect(d.removed.map((x) => x.name)).toEqual(['c']);
  });
  it('変化がなければ全カテゴリ空', () => {
    const snap = { '/a': e('a', 'h1') };
    const d = diffSnapshot(snap, { ...snap });
    expect(d.added.length + d.updated.length + d.removed.length).toBe(0);
  });
});

describe('dayKey', () => {
  it('ローカルタイムゾーンの YYYY-MM-DD を返す', () => {
    const ts = new Date(2026, 6, 10, 23, 59).getTime(); // 2026-07-10 local
    expect(dayKey(ts)).toBe('2026-07-10');
  });
});
