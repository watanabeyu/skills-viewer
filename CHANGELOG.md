# Changelog

All notable changes to this project are documented here, in English followed by Japanese.
このファイルには主要な変更を記録します(英語の後に日本語を併記)。

## [0.3.0] - 2026-07-10

### Added

- **Unused badge & filter** — items with no recorded use within the transcript retention window (`cleanupPeriodDays`, default 30 days) get an *unused* badge, with an unused-only toggle in the toolbar. Hidden entirely when no transcripts exist.
  **未使用バッジ・フィルタ** — トランスクリプト保持期間(既定30日)内に使用記録がないものに「未使用」バッジを表示し、ツールバーで絞り込み可能に。トランスクリプトが1件も無い環境では非表示。
- **Description lint** — static checks on frontmatter descriptions: missing / too short (< 30 chars) / too long (> 1024 chars) / no trigger condition ("Use when …", 日英対応; skills & agents only) / name-echo. Warnings appear as a ⚠ badge (top-right of the card) with a hover tooltip.
  **description リント** — frontmatter の description を静的チェック: 欠落 / 短すぎ(30字未満)/ 長すぎ(1024字超)/ 発動条件なし(skill・agent のみ)/ 名前の繰り返し。カード右上の ⚠ バッジと hover tooltip で表示。
- **Token cost estimates** — every name + description is injected into each session, so the estimated overhead is shown per item, per scope, and as a per-session total for the current project. New "Token cost" sort order — combine it with the unused filter to surface deletion candidates.
  **トークンコスト概算** — name + description は毎セッション注入されるため、その概算をカード・スコープ見出し・ヘッダ(現在プロジェクトのセッション合計)に表示。並び順「トークン量順」を追加。未使用フィルタと組み合わせると削除候補が上から並ぶ。

### Changed

- **Card layout** — row 1 is now name + version/⚠ (top-right) only; kind / invocation / unused chips moved to a second row so long names stay readable.
  **カードレイアウト** — 1行目は名前 + 右上(バージョン/⚠)のみに整理し、kind・起動経路・未使用のチップ類は2行目へ。長い名前でも読みやすく。

### Fixed

- **Hook list-reorder corruption** — multiple hooks sharing the same file and event name collided on the same React key, garbling the display order when toggling grouping or changing sort (present since 0.2.0). Hook keys now include the command string; same-name hooks also open their own detail page instead of the first match.
  **hook の並べ替え崩れ** — 同一ファイル・同一イベント名の hook が React key で衝突し、グループ化切替やソート変更時に表示順が壊れていた(0.2.0 から存在)。キーにコマンド文字列を含めて一意化。同名 hook の詳細画面が常に最初の1件を開く問題も解消。

## [0.2.0] - 2026-07-09

Initial public release. / 初回公開リリース。

### Added

- **All scopes in one view** — user / every project / plugins / built-ins, with search, sort and grouping.
  **全スコープ横断表示** — user・全プロジェクト・plugin・built-in を1画面で。検索・ソート・グループ化対応。
- **Usage stats** from Claude Code session transcripts (typed vs model-invoked, last used).
  **使用実績** — トランスクリプト由来(手動/自動の別・最終使用日)。
- **AI summaries** via `claude -p --model haiku`, cached by content hash.
  **AI 要約** — `claude -p --model haiku` で生成、content hash でキャッシュ。
- **Manage** — copy across scopes, delete to OS trash; SKILL.md rendering, same-name diff, open in editor (URL scheme).
  **管理機能** — スコープ間コピー・ゴミ箱行き削除、SKILL.md レンダリング、同名 diff、エディタで開く(URL スキーム)。
- **English / 日本語 UI** — auto-detected, switchable in settings; AI summaries generated in the selected language.
  **日英対応 UI** — ブラウザから自動判定・設定で切替。AI 要約も表示言語で生成。

### Security

- Binds to `127.0.0.1` only; per-run token for mutating APIs; Host header validation (DNS rebinding); AI summarization runs with tools disabled to contain prompt injection via SKILL.md.
  `127.0.0.1` バインド、mutation API の起動ごとトークン、Host ヘッダ検証(DNS rebinding 対策)、AI 要約はツール無効で実行し SKILL.md 経由のプロンプトインジェクションを封じ込め。
