/*
 * GET /api/diff?src= の実体。git 管理下のファイルについて HEAD 時点の内容を返し、
 * web はワーキングツリーの内容(GET /api/file)と並べて行 diff を描く
 * (行 diff の計算・描画は web/src/diff.ts。ここはサーバー側の取得だけ)。
 *
 * read-access.ts の assertReadableMd は使えない: realpath 解決を通すので
 * 「削除されたファイルの過去の内容」が取れない(差分の主役がまさにそれ)。
 * そのため存在に依存しない専用の検証をここに置く。
 *
 * 検証の順:
 *   1. path.resolve して .md 以外を弾く
 *   2. .git 配下を弾く(.git/config などを git show 経由で読ませない)
 *   3. user scope(~/.claude 配下)は共有の履歴を持たないので available: false
 *   4. root は src 自身の位置から求める(server の cwd に依存しない。Phase D で cwd 以外の
 *      プロジェクトを開いたときも同じ答えになるように)。使うのは repoRootOf ではなく
 *      worktreeRootOf: linked worktree の中のファイルは、そのワークツリーの HEAD と比べたい
 *      (repoRootOf はメインワークツリーを返すため、worktree 内のファイルが root の外に出る)
 *   5. root からの相対パスが `..` で始まらず絶対でもないことを確かめてから git に渡す
 */

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import type { DiffResponse } from '../shared/types';
import { ApiError } from './errors';
import { worktreeRootOf } from './memory';
import { userClaudeDir } from './claude-md';
import { allowedPath } from './read-access';

/* git show の出力上限。これを超える .md は差分表示の対象外(available: false に落ちる) */
const MAX_BUFFER = 4 << 20;

/*
 * 検証済みの (root, relPath)。rootOf はテスト注入用
 * (実在する git リポジトリを用意せずに `..` 脱出の防御を確かめられるように)。
 */
export function resolveDiffTarget(
  src: string,
  cwd: string = process.cwd(),
  rootOf: (dir: string) => string | null = worktreeRootOf,
): { root: string; relPath: string } | { reason: DiffResponse['reason'] } {
  const abs = path.resolve(src);
  if (!abs.endsWith('.md')) throw new ApiError('not-md', abs);
  // .git 配下は git show で読めてしまうので、リポジトリ判定より前に明示的に拒否する
  if (abs.split(path.sep).includes('.git')) throw new ApiError('not-readable-path', abs);
  /*
   * 読み取りの境界の外は返さない。ここが無いと「git 管理下ならどこの .md でも HEAD が読める」
   * ことになり、同じファイルに対して /api/file(assertReadableMd)と許可範囲が食い違う。
   * realpath は使えない(削除済みファイルの過去の内容を出すのがこの API の目的)ので、
   * path.resolve 後の前方一致で判定する。
   */
  if (!allowedPath(abs, cwd)) return { reason: 'out-of-scope' };
  // user scope(~/.claude)は全プロジェクトで共有され git 履歴を持たないので差分の対象外
  if (abs.startsWith(userClaudeDir() + path.sep)) return { reason: 'user-scope' };
  const root = rootOf(path.dirname(abs));
  if (!root) return { reason: 'not-git' };
  const rel = path.relative(root, abs);
  // root は abs の祖先として求めているので通常は起きない。git に `..` を渡さない最後の砦
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel))
    throw new ApiError('not-readable-path', abs);
  // git は常に POSIX 区切りの相対パスを期待する(Windows の \ をそのまま渡すと引けない)
  return { root, relPath: rel.split(path.sep).join('/') };
}

/* HEAD 時点の内容。非 git・履歴なし・user scope・git 失敗は available: false */
export function previousContent(
  src: string,
  cwd: string = process.cwd(),
  rootOf: (dir: string) => string | null = worktreeRootOf,
): DiffResponse {
  const target = resolveDiffTarget(src, cwd, rootOf);
  if ('reason' in target) return { available: false, reason: target.reason };
  try {
    const out = execFileSync('git', ['-C', target.root, 'show', `HEAD:${target.relPath}`], {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { available: true, previous: out };
  } catch (e) {
    // 上限超えは「履歴が無い」と切り分けたいので別の理由にする
    const code = (e as { code?: string }).code;
    if (code === 'ENOBUFS') return { available: false, reason: 'too-large' };
    // HEAD に無い(新規ファイル)・コミットが 1 つも無い・git が無い
    return { available: false, reason: 'no-history' };
  }
}
