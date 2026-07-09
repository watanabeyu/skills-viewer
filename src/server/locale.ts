/*
 * CLI・サーバーコンソール出力の言語判定(環境変数ベース)。
 * web UI の言語はクライアント側(navigator.language + 設定)で独立に管理される。
 */

import type { Lang } from '../shared/types';

function detect(): Lang {
  const env = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '';
  return /^ja([-_]|$)/i.test(env) ? 'ja' : 'en';
}

export const serverLang: Lang = detect();

export const srvMsg = (ja: string, en: string): string => (serverLang === 'ja' ? ja : en);
