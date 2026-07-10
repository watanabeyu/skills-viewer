/*
 * description の静的リントと、セッション注入トークン量の概算。
 * Claude Code はスキル選択のために frontmatter の name + description を毎セッション
 * コンテキストへ注入する。lint は「モデルが発動判断に使える description か」の観点で、
 * frontmatter の meta(本文フォールバック前)に対して行う。
 */

import type { ItemKind, LintCode } from '../shared/types';

/*
 * トークン数の概算(厳密なトークナイザは依存が重いので入れない)。
 * 目安: ASCII ≈ 4 文字/トークン、非 ASCII(日本語等)≈ 1.5 文字/トークン。
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4 + other / 1.5);
}

/*
 * 発動条件らしい語句。en は "use when/for …"・条件節、ja は「〜のときに使用」系。
 * command は人間が明示的に打つ起点なので発動条件は要求しない(呼び出し側で除外)。
 */
const TRIGGER_RE =
  /\b(use|when|whenever|if|for|before|after|trigger|invoke)\b|使用|使う|使って|用い|とき|時に|場合|際|なら|向け/i;

const SHORT_LIMIT = 30;
const LONG_LIMIT = 1024;

/*
 * meta: frontmatter のパース結果。name はフォールバック解決後の表示名。
 * 戻り値は言語非依存のコード(表示ラベルは web の i18n で解決)。
 */
export function lintItem(meta: Record<string, string>, name: string, kind: ItemKind): LintCode[] {
  if (kind === 'hook') return [];
  const warnings: LintCode[] = [];
  const desc = (meta.description || '').trim();
  if (!desc) return ['no-description'];
  if (desc.length < SHORT_LIMIT) warnings.push('short-description');
  if (desc.length > LONG_LIMIT) warnings.push('long-description');
  // 記号を除いて比較し、name をほぼ繰り返しただけの description を検出
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9ぁ-んァ-ン一-龠]/g, '');
  if (norm(desc) === norm(name)) warnings.push('name-echo');
  // skill / agent はモデルが description を見て自動発動するため、発動条件の記述を求める
  if ((kind === 'skill' || kind === 'agent') && !TRIGGER_RE.test(desc)) {
    warnings.push('no-trigger');
  }
  return warnings;
}
