/*
 * 依存ゼロの最小 i18n。en をキーの単一ソースとし、ja は全キー必須(型で担保)。
 * 言語は localStorage(csb-lang)→ navigator.language の順で決まり、設定モーダルで切替可能。
 * テスト(Node 環境)からも import されるため、ブラウザ API へのアクセスは必ずガードする。
 */

import type { Lang, LintCode, RelationType } from '../../src/shared/types';

export type { Lang };

const en = {
  'app.subtitle': 'skills · commands · agents · hooks — installed on this machine',
  'app.count': '{shown} / {total} items',
  'app.searchPlaceholder': 'Search by name or description…',
  'app.grouped': 'Group by source',
  'app.settings': 'Settings',
  'app.loadFailed': 'Failed to load: {msg}',

  'sort.title': 'Sort order',
  'sort.name': 'Name',
  'sort.uses': 'Most used',
  'sort.recent': 'Recently used',
  'sort.updated': 'Recently updated',
  'sort.tokens': 'Token cost',
  'kind.all': 'All',
  'filter.used': 'Used',
  'filter.usedTitle':
    'Show only items with recorded use in the transcript retention window (default 30 days)',
  'filter.unused': 'Unused',
  'filter.unusedTitle':
    'Show only items with no recorded use in the transcript retention window (default 30 days)',

  'ai.button': 'AI summaries',
  'ai.progress': 'Summarizing {done}/{total}',
  'ai.stale': 'AI summaries ({n} pending)',
  'ai.done': 'AI summaries ✓',
  'ai.buttonTitle':
    'Summarize each SKILL.md via claude CLI (haiku). Only changed ones are regenerated',
  'ai.confirmForce':
    'All summaries are up to date. Force-regenerate all {n} items? (claude CLI / haiku)',
  'ai.confirmRun': 'Summarize {n} SKILL.md files via claude CLI (haiku)?',
  'ai.finishedErrors': 'Summarization finished ({n} errors):',
  'ai.startFailed': 'Failed to start: {msg}',

  'list.empty': 'No skills match the filters',
  'card.uses': 'Used {n}× · last {date}',
  'card.noUses': 'No recorded use',
  'card.updated': 'Updated {date}',
  'card.tokens': '~{n} tok',
  'badge.unused': 'unused',
  'badge.unusedTitle':
    'No recorded use within the transcript retention window (default 30 days). Older use is not visible.',
  'badge.warnTitle': 'Description issues:',
  'sec.tokens': '≈{n} tok/session',
  'app.tokens': '≈{n} tokens/session',
  'app.tokensTitle':
    'Approx. tokens injected into every session in the current project (name + description of built-ins, plugins, user scope and the current project)',

  'detail.back': '← Back to list',
  'detail.lastUpdated': 'Last updated {date}',
  'detail.openEditor': 'Open in editor',
  'detail.copy': 'Copy ▾',
  'detail.resummarize': 'Refresh AI summary',
  'detail.summarizing': 'Summarizing…',
  'detail.delete': 'Delete',
  'tab.overview': 'Overview',
  'detail.aiSummary': 'AI summary',
  'detail.description': 'Description',
  'detail.usage': 'Usage',
  'detail.usageStats': 'Usage stats',
  'detail.usageDetail': 'Typed by human {typed}× · invoked by agent {auto}×',
  'detail.usageLast': ' · last {date}',
  'detail.relations': 'Related skills',
  'detail.notInstalled': 'not installed',
  'detail.files': 'Bundled files',
  'detail.path': 'Path',
  'detail.location': 'Location',
  'detail.builtinLocation': 'Bundled with Claude Code',
  'detail.sameName': 'Same-name definitions ({n})',
  'detail.open': 'Open',
  'detail.diff': 'diff',
  'detail.diffClose': 'Close diff',
  'changes.title': 'Since last launch:',
  'changes.added': '{n} added',
  'changes.updated': '{n} updated',
  'changes.removed': '{n} removed',
  'changes.more': '+{n} more',
  'changes.ack': 'Dismiss',
  'changes.ackTitle': 'Use the current state as the baseline for the next comparison',
  'alert.ackFailed': 'Failed to dismiss: {msg}',

  'detail.spark': 'Last 30 days',
  'detail.diagnostics': 'Diagnostics',
  'diag.run': 'AI trigger diagnosis',
  'diag.rerun': 'Re-diagnose',
  'diag.running': 'Diagnosing…',
  'diag.runTitle':
    'Analyze via claude CLI (haiku) whether the description is likely to trigger auto-invocation, and propose an improved version',
  'diag.verdict.good': '✓ Trigger condition looks clear',
  'diag.verdict.weak': '△ Auto-invocation unlikely as written',
  'diag.improved': 'Suggested description',
  'diag.apply': 'Apply this suggestion',
  'diag.applying': 'Applying…',
  'alert.diagnoseFailed': 'Diagnosis failed: {msg}',
  'alert.applyFailed': 'Failed to apply: {msg}',

  'edit.button': 'Edit',
  'edit.save': 'Save',
  'edit.saving': 'Saving…',
  'edit.noFrontmatter': 'No frontmatter (--- block) found. Save anyway?',
  'alert.saveFailed': 'Save failed: {msg}',
  'detail.tokenCost':
    'Session overhead: ~{n} tokens (name + description are injected into every session; approx.)',
  'lint.no-description':
    'No description in frontmatter — the model has no basis to decide when to use this',
  'lint.short-description':
    'Description is very short (under 30 chars) — likely too little for the model to pick it',
  'lint.long-description': 'Description is very long (over 1024 chars) — it inflates every session',
  'lint.no-trigger':
    'No trigger condition (e.g. "Use when …") in the description — auto-invocation is unlikely',
  'lint.name-echo': 'Description merely repeats the name — it adds no signal',

  'diff.thisDef': '− {label} (this one)',
  'diff.identical': 'Contents are identical',
  'diff.changed': '{n} changed lines',
  'diff.skip': '… {n} identical lines …',
  'diff.failed': 'Failed to load diff: {msg}',
  'common.loading': 'Loading…',
  'common.cancel': 'Cancel',

  'alert.copyFailed': 'Copy failed: {msg}',
  'alert.deleteFailed': 'Delete failed: {msg}',
  'alert.trashed': 'Moved to trash:\n{path}',
  'alert.openFailed': 'Could not open in editor: {msg}',
  'alert.summarizeFailed': 'Summarization failed: {msg}',

  'delete.title': 'Delete {name}?',
  'delete.body': 'Moves SKILL.md and its bundled files to the trash (restorable later).',
  'delete.confirm': 'Delete',

  'copy.header': 'Copy to',

  'settings.title': 'Settings',
  'settings.language': 'Language',
  'settings.width': 'Layout width',
  'settings.widthFull': 'Full width',
  'settings.widthFullNote': '4–5 columns on wide screens',
  'settings.widthFixed': 'Fixed width (1200px)',
  'settings.widthFixedNote': 'Centered, always 3 columns',
  'settings.editor': 'Editor used by "Open in editor"',
  'settings.customScheme': 'Custom URL scheme',
  'settings.osDefault': 'OS default',
  'settings.osDefaultNote': 'Opened server-side (default app for the file type)',
  'settings.save': 'Save',
  'settings.customNeedsPath':
    'A custom scheme must contain {path} (e.g. myeditor://open?file={path})',

  'invocation.human': 'Human',
  'invocation.agent': 'Agent',
  'invocation.both': 'Both',
  'invocation.measured': 'Measured: typed {typed}× / auto {auto}×',
  'invocation.ai': 'AI verdict: {label}',

  'rel.invokes': 'invokes',
  'rel.delegates': 'delegates',
  'rel.called-by': 'called by',
  'rel.references': 'references',

  'apiError.not-found': 'File not found: {detail}',
  'apiError.not-managed-path': 'Path is not managed here: {detail}',
  'apiError.plugin-managed': 'Plugin files are managed via the /plugin command',
  'apiError.not-md': 'Not a .md file: {detail}',
  'apiError.not-readable-path': 'Path is not readable here: {detail}',
  'apiError.not-openable-path': 'Path cannot be opened: {detail}',
  'apiError.unknown-copy-target': 'Unknown copy target: {detail}',
  'apiError.no-free-name': 'No free name for the copy',
  'apiError.unexpected-skill-dir': 'Unexpected skill directory layout: {detail}',
  'apiError.edit-conflict': 'The file was changed outside this app — reload the page and try again',
  'apiError.empty-content': 'Content is empty',
  'apiError.content-too-large': 'Content is too large to save',
  'apiError.bad-origin': 'Request rejected: bad origin',
  'apiError.bad-token': 'Bad token — reload the page (the server may have restarted)',
  'apiError.bad-json': 'Malformed request',
  'apiError.unknown-endpoint': 'Unknown API endpoint: {detail}',
  'apiError.internal': 'Server error: {detail}',
} as const;

export type MsgKey = keyof typeof en;

const ja: Record<MsgKey, string> = {
  'app.subtitle': 'skills · commands · agents · hooks — このPCにインストール済み',
  'app.count': '{shown} / {total} 件',
  'app.searchPlaceholder': 'スキル名や説明で検索…',
  'app.grouped': 'グループ化',
  'app.settings': '設定',
  'app.loadFailed': '読み込みに失敗しました: {msg}',

  'sort.title': '並び順',
  'sort.name': '名前順',
  'sort.uses': '使用回数順',
  'sort.recent': '最近使った順',
  'sort.updated': '更新日順',
  'sort.tokens': 'トークン量順',
  'kind.all': 'すべて',
  'filter.used': '使用あり',
  'filter.usedTitle': '保持期間内(既定30日)のトランスクリプトに使用記録があるものだけ表示',
  'filter.unused': '未使用',
  'filter.unusedTitle': '保持期間内(既定30日)のトランスクリプトに使用記録がないものだけ表示',

  'ai.button': 'AI要約',
  'ai.progress': '要約中 {done}/{total}',
  'ai.stale': 'AI要約 (未生成 {n})',
  'ai.done': 'AI要約 ✓',
  'ai.buttonTitle': 'claude CLI (haiku) で各 SKILL.md を要約。内容が変わったものだけ再生成',
  'ai.confirmForce':
    '全 skill の要約は最新です。全 {n} 件を強制再生成しますか?(claude CLI / haiku)',
  'ai.confirmRun': '{n} 件の SKILL.md を claude CLI (haiku) で要約します。よろしいですか?',
  'ai.finishedErrors': '要約完了(エラー {n}件):',
  'ai.startFailed': '開始に失敗: {msg}',

  'list.empty': '条件に一致するスキルがありません',
  'card.uses': '使用 {n}回 · 最終 {date}',
  'card.noUses': '使用記録なし',
  'card.updated': '{date} 更新',
  'card.tokens': '約{n}tok',
  'badge.unused': '未使用',
  'badge.unusedTitle':
    'トランスクリプト保持期間内(既定30日)に使用記録がありません。それ以前の使用は集計できません',
  'badge.warnTitle': 'description の問題:',
  'sec.tokens': '≈{n}tok/セッション',
  'app.tokens': '≈{n}トークン/セッション',
  'app.tokensTitle':
    '現在のプロジェクトでのセッションごとに注入されるトークンの概算(built-in・plugin・user・現在プロジェクトの name + description)',

  'detail.back': '← 一覧に戻る',
  'detail.lastUpdated': '最終更新 {date}',
  'detail.openEditor': 'エディタで開く',
  'detail.copy': 'コピー ▾',
  'detail.resummarize': 'AI要約更新',
  'detail.summarizing': '要約中…',
  'detail.delete': '削除',
  'tab.overview': '概要',
  'detail.aiSummary': 'AI 要約',
  'detail.description': '説明',
  'detail.usage': '使い方',
  'detail.usageStats': '使用実績',
  'detail.usageDetail': '手動(人間がタイプ) {typed}回 · 自動(エージェント呼び出し) {auto}回',
  'detail.usageLast': ' · 最終 {date}',
  'detail.relations': '関連スキル',
  'detail.notInstalled': '未インストール',
  'detail.files': '含まれるファイル',
  'detail.path': 'パス',
  'detail.location': '場所',
  'detail.builtinLocation': 'Claude Code 本体に同梱',
  'detail.sameName': '同名の定義 ({n})',
  'detail.open': '開く',
  'detail.diff': 'diff',
  'detail.diffClose': 'diff を閉じる',
  'changes.title': '前回の起動から:',
  'changes.added': '追加 {n}',
  'changes.updated': '更新 {n}',
  'changes.removed': '削除 {n}',
  'changes.more': '他 {n} 件',
  'changes.ack': '既読にする',
  'changes.ackTitle': '現在の状態を次回比較の基準として保存します',
  'alert.ackFailed': '既読化に失敗: {msg}',

  'detail.spark': '直近30日',
  'detail.diagnostics': '診断',
  'diag.run': 'AI 発動診断',
  'diag.rerun': '再診断',
  'diag.running': '診断中…',
  'diag.runTitle':
    'description が自動発動につながるかを claude CLI (haiku) で分析し、改善案を提案します',
  'diag.verdict.good': '✓ 発動条件は明確です',
  'diag.verdict.weak': '△ このままでは自動発動されにくい可能性',
  'diag.improved': '改善案',
  'diag.apply': 'この案を適用',
  'diag.applying': '適用中…',
  'alert.diagnoseFailed': '診断に失敗: {msg}',
  'alert.applyFailed': '適用に失敗: {msg}',

  'edit.button': '編集',
  'edit.save': '保存',
  'edit.saving': '保存中…',
  'edit.noFrontmatter': 'frontmatter(--- ブロック)がありません。このまま保存しますか?',
  'alert.saveFailed': '保存に失敗: {msg}',
  'detail.tokenCost':
    'セッションあたりの負荷: 約{n}トークン(name + description は毎セッション注入されます。概算)',
  'lint.no-description':
    'frontmatter に description がありません — モデルが使いどきを判断する材料がありません',
  'lint.short-description':
    'description が短すぎます(30文字未満)— モデルが選ぶ手掛かりとして不足しがちです',
  'lint.long-description': 'description が長すぎます(1024文字超)— 毎セッションの負荷になります',
  'lint.no-trigger':
    'description に発動条件(「〜のときに使用」等)がありません — 自動発動されにくくなります',
  'lint.name-echo': 'description が名前の繰り返しになっています — 情報が増えていません',

  'diff.thisDef': '− {label}(この定義)',
  'diff.identical': '内容は同一です',
  'diff.changed': '差分 {n} 行',
  'diff.skip': '… {n} 行同一 …',
  'diff.failed': 'diff の取得に失敗しました: {msg}',
  'common.loading': '読み込み中…',
  'common.cancel': 'キャンセル',

  'alert.copyFailed': 'コピーに失敗: {msg}',
  'alert.deleteFailed': '削除に失敗: {msg}',
  'alert.trashed': 'ゴミ箱に移動しました:\n{path}',
  'alert.openFailed': 'エディタで開けませんでした: {msg}',
  'alert.summarizeFailed': '要約に失敗: {msg}',

  'delete.title': '{name} を削除しますか?',
  'delete.body': 'SKILL.md と関連ファイルをゴミ箱に移動します(あとで復元できます)。',
  'delete.confirm': '削除する',

  'copy.header': 'コピー先のリスト',

  'settings.title': '設定',
  'settings.language': '言語',
  'settings.width': '表示幅',
  'settings.widthFull': 'フル幅',
  'settings.widthFullNote': '広い画面では 4〜5 カラム',
  'settings.widthFixed': '固定幅 (1200px)',
  'settings.widthFixedNote': '中央寄せ・常に 3 カラム',
  'settings.editor': '「エディタで開く」で使うエディタ',
  'settings.customScheme': 'カスタム URL スキーム',
  'settings.osDefault': 'OS デフォルト',
  'settings.osDefaultNote': 'サーバー側で開く(拡張子の既定アプリ)',
  'settings.save': '保存',
  'settings.customNeedsPath':
    'カスタムスキームには {path} を含めてください(例: myeditor://open?file={path})',

  'invocation.human': '人間起点',
  'invocation.agent': 'エージェント',
  'invocation.both': '両方',
  'invocation.measured': '実測: 手動 {typed}回 / 自動 {auto}回',
  'invocation.ai': 'AI判定: {label}',

  'rel.invokes': '起動',
  'rel.delegates': '委譲',
  'rel.called-by': '呼ばれる側',
  'rel.references': '参照',

  'apiError.not-found': 'ファイルが見つかりません: {detail}',
  'apiError.not-managed-path': '管理対象外のパスです: {detail}',
  'apiError.plugin-managed': 'plugin 配下は /plugin コマンドで管理してください',
  'apiError.not-md': 'md ファイルではありません: {detail}',
  'apiError.not-readable-path': '読み取り対象外のパスです: {detail}',
  'apiError.not-openable-path': '対象外のパスです: {detail}',
  'apiError.unknown-copy-target': '未知のコピー先です: {detail}',
  'apiError.no-free-name': 'コピー先の空き名が見つかりません',
  'apiError.unexpected-skill-dir': 'skill ディレクトリ構造が想定外です: {detail}',
  'apiError.edit-conflict':
    'ファイルが外部で変更されています。ページを再読み込みしてからやり直してください',
  'apiError.empty-content': '内容が空です',
  'apiError.content-too-large': '内容が大きすぎて保存できません',
  'apiError.bad-origin': '不正なオリジンからのアクセスです',
  'apiError.bad-token':
    'トークンが不正です。ページを再読み込みしてください(サーバー再起動の可能性)',
  'apiError.bad-json': '不正なリクエストです',
  'apiError.unknown-endpoint': '不明な API です: {detail}',
  'apiError.internal': 'サーバーエラー: {detail}',
};

const DICTS: Record<Lang, Record<MsgKey, string>> = { en, ja };

/* ---- 言語の状態 ---- */

const LS_KEY = 'csb-lang';

function detectLang(): Lang {
  try {
    const stored = localStorage.getItem(LS_KEY);
    if (stored === 'ja' || stored === 'en') return stored;
    return /^ja/i.test(navigator.language) ? 'ja' : 'en';
  } catch {
    return 'en'; // ブラウザ外(テスト等)
  }
}

let current: Lang = detectLang();

export const getLang = (): Lang => current;

export function setLang(l: Lang): void {
  current = l;
  try {
    localStorage.setItem(LS_KEY, l);
    document.documentElement.lang = l;
  } catch {
    /* ブラウザ外では何もしない */
  }
}

/* ---- 変換 ---- */

/* {name} を params の値で置換。params に無いプレースホルダはそのまま残す */
export function t(key: MsgKey, params?: Record<string, string | number>): string {
  let s: string = DICTS[current][key];
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.replaceAll('{' + k + '}', String(v));
  }
  return s;
}

export const relTypeLabel = (type: RelationType): string => t(`rel.${type}`);

export const lintLabel = (code: LintCode): string => t(`lint.${code}`);

/* API エラー {error: code, detail} を表示文言に変換。未知コードは code: detail をそのまま出す */
export function apiErrorMessage(body: unknown, status: number): string {
  const b = (body || {}) as { error?: unknown; detail?: unknown };
  const code = typeof b.error === 'string' ? b.error : '';
  const detail = typeof b.detail === 'string' ? b.detail : '';
  const key = ('apiError.' + code) as MsgKey;
  if (code && key in en) return t(key, { detail });
  if (code) return detail ? `${code}: ${detail}` : code;
  return 'HTTP ' + status;
}
