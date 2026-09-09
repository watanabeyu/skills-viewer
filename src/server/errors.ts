/*
 * API エラーは言語非依存のコードで表現し、表示文言はクライアント側の辞書で解決する。
 * message は code(+detail)そのままなので、curl 等の直接利用でも意味が取れる。
 */

/*
 * 書き込み系の 4 API(保存 / description 適用 / コピー / 削除)は v0.9.0 で廃止したので、
 * それらだけが投げていたコード(not-managed-path / plugin-managed / unknown-copy-target /
 * no-free-name / unexpected-skill-dir / edit-conflict / empty-content / content-too-large)も消えた。
 */
export type ApiErrorCode =
  | 'not-found'
  | 'not-md'
  | 'not-readable-path'
  | 'not-openable-path'
  | 'bad-origin'
  | 'bad-token'
  | 'bad-json'
  | 'unknown-endpoint'
  | 'internal';

export class ApiError extends Error {
  constructor(
    public code: ApiErrorCode,
    public detail = '',
  ) {
    super(detail ? code + ': ' + detail : code);
  }
}

/* handleApi の catch で使う共通整形 */
export function toErrorBody(e: unknown): { error: string; detail: string } {
  if (e instanceof ApiError) return { error: e.code, detail: e.detail };
  return { error: 'internal', detail: e instanceof Error ? e.message : String(e) };
}
