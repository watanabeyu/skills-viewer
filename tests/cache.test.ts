import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { pruneMissing } from '../src/server/cache';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-cache-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('pruneMissing (キャッシュの死にエントリ掃除)', () => {
  const alive = path.join(tmp, 'alive.md');
  const gone = path.join(tmp, 'gone.md');
  fs.writeFileSync(alive, 'x');

  it('存在するパスのエントリだけを残す', () => {
    const store = { [alive]: { summary: 'a' }, [gone]: { summary: 'b' } };
    expect(pruneMissing(store)).toEqual({ [alive]: { summary: 'a' } });
  });

  it('元のオブジェクトは書き換えない(新しいオブジェクトを返す)', () => {
    const store = { [alive]: 1, [gone]: 2 };
    const pruned = pruneMissing(store);
    expect(pruned).not.toBe(store);
    expect(Object.keys(store)).toHaveLength(2);
  });

  it('空の store は空のまま', () => {
    expect(pruneMissing({})).toEqual({});
  });
});
