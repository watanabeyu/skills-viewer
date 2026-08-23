/*
 * AI 機能のキャッシュ(~/.cache/skills-viewer/*.json)の共通処理。
 * どのキャッシュも「実パス → エントリ」の形なので、掃除の規則を 1 箇所に置く。
 */

import * as fs from 'node:fs';

/*
 * 消えたファイル(削除・リネーム・別プロジェクトの撤去)のエントリを落とす。
 * 呼ぶのは保存時だけにする — GET(読み取り API)で書き込みを発生させないため。
 */
export function pruneMissing<T>(store: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(store)) {
    if (fs.existsSync(key)) out[key] = value;
  }
  return out;
}
