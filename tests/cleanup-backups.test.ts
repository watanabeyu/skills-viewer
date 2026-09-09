/*
 * v0.8 のインライン編集が残した 1 世代バックアップの掃除(src/server/summary.ts)。
 *
 * これは利用者のファイルのコピーを消す唯一の処理なので、(a) 消すのは backups だけ、
 * (b) 他のキャッシュ資産に触らない、(c) 無くても落ちない、を固定する。
 * かつてモジュール先頭の副作用として書かれており、`pnpm test` を回しただけで実行者の
 * HOME の控えが消えていた(レビュー 2 周目の指摘)。呼ばれる場所を起動時に限ったので、
 * ここでは一時ディレクトリを渡して振る舞いだけを見る。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupLegacyBackups } from '../src/server/summary';

const dirs: string[] = [];
const mkTmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-cleanup-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('cleanupLegacyBackups', () => {
  it('backups を中身ごと消し、他のキャッシュ資産は残す', () => {
    const cache = mkTmp();
    fs.mkdirSync(path.join(cache, 'backups', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(cache, 'backups', 'a.md'), 'old');
    fs.writeFileSync(path.join(cache, 'backups', 'nested', 'b.md'), 'old');
    fs.writeFileSync(path.join(cache, 'summaries.json'), '{}');
    fs.writeFileSync(path.join(cache, 'snapshot.json'), '{}');

    expect(cleanupLegacyBackups(cache)).toBe(true);
    expect(fs.existsSync(path.join(cache, 'backups'))).toBe(false);
    expect(fs.existsSync(path.join(cache, 'summaries.json'))).toBe(true);
    expect(fs.existsSync(path.join(cache, 'snapshot.json'))).toBe(true);
  });

  it('backups が無ければ false を返し、何もしない(起動のたびに 1 行出さない)', () => {
    const cache = mkTmp();
    fs.writeFileSync(path.join(cache, 'summaries.json'), '{}');
    expect(cleanupLegacyBackups(cache)).toBe(false);
    expect(fs.existsSync(path.join(cache, 'summaries.json'))).toBe(true);
  });

  it('キャッシュディレクトリ自体が無くても落ちない', () => {
    expect(cleanupLegacyBackups(path.join(mkTmp(), 'no-such-dir'))).toBe(false);
  });

  /* backups が symlink なら link だけを外し、リンク先の中身は消さない */
  it('backups が symlink でもリンク先は消さない', () => {
    const cache = mkTmp();
    const real = mkTmp();
    fs.writeFileSync(path.join(real, 'keep.md'), 'keep');
    fs.symlinkSync(real, path.join(cache, 'backups'));

    expect(cleanupLegacyBackups(cache)).toBe(true);
    expect(fs.existsSync(path.join(cache, 'backups'))).toBe(false);
    expect(fs.readFileSync(path.join(real, 'keep.md'), 'utf8')).toBe('keep');
  });
});
