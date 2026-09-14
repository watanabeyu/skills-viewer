/*
 * cleanupLegacyBackups(v0.8 の控えの掃除)が起動時に 1 回だけ呼ばれること。
 *
 * かつてこの処理は summary.ts のトップレベル副作用として書かれており、`pnpm test` を回した
 * だけで実行者の実 HOME の backups が消える事故が起きた(README Security / tests/cleanup-backups.test.ts
 * のコメント参照)。今は src/server/index.ts の start() の listen コールバックからしか呼ばない構造
 * になっているが、これまで「呼べば消える」ことしかテストされておらず、「import しただけでは
 * 走らない」ことは担保されていなかった ── 誰かが再びトップレベルに書き戻しても、他のテストは
 * 落ちない。
 *
 * 検証は HOME を一時ディレクトリに見せかけて行う(tests/scan.test.ts の前例と同じ手段: 動的 import の
 * 前に vi.stubEnv('HOME', tmp) を置く)。実 HOME には一切触れない。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-cleanup-import-'));
const home = path.join(tmp, 'home');
const backups = path.join(home, '.cache', 'skills-viewer', 'backups');

beforeAll(() => {
  fs.mkdirSync(backups, { recursive: true });
  fs.writeFileSync(path.join(backups, 'old.md'), 'old');
  vi.stubEnv('HOME', home);
});
afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('cleanupLegacyBackups は import の副作用ではない', () => {
  it('summary.ts を import しただけでは backups は消えずに残る', async () => {
    await import('../src/server/summary');
    expect(fs.existsSync(backups)).toBe(true);
  });

  it('index.ts(start() を含むモジュール)を import しただけでも backups は残る(start() は呼んでいない)', async () => {
    await import('../src/server/index');
    expect(fs.existsSync(backups)).toBe(true);
  });

  /*
   * 上の 2 件だけだと、HOME の差し替えが効いていない場合も「消えていない」で通ってしまう
   * (実 HOME を見ていて、そこに backups が無いだけ、という状態と区別が付かない)。
   * 引数なしで呼ぶと既定のキャッシュ置き場 = 差し替えた HOME 配下を消すはずなので、
   * ここで実際に消えることを見て、上の 2 件が本物の検証だったことを示す。
   */
  it('引数なしで呼べば差し替えた HOME 配下が消える(上の 2 件が空振りでない証拠)', async () => {
    const { cleanupLegacyBackups } = await import('../src/server/summary');
    expect(fs.existsSync(backups)).toBe(true);
    expect(cleanupLegacyBackups()).toBe(true);
    expect(fs.existsSync(backups)).toBe(false);
  });
});
