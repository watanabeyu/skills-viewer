# Changelog

All notable changes to this project are documented here, in English followed by Japanese.
このファイルには主要な変更を記録します(英語の後に日本語を併記)。

## [0.5.0] - 2026-07-13

The view → diagnose → **fix** loop now closes inside the tool.
見る → 診断する → **直す** のループがツール内で完結するようになりました。

### Added

- **AI trigger diagnosis** — one click asks haiku whether the description is likely to trigger auto-invocation (the model only sees name + description when deciding), lists concrete issues, and proposes an improved description. Cached by content hash + language in `~/.cache/skills-viewer/diagnoses.json`.
  **AI 発動診断** — description が自動発動につながるか(モデルは name + description しか見ない)を haiku で診断し、問題点と改善版 description を提示。content hash + 言語で `~/.cache/skills-viewer/diagnoses.json` にキャッシュ。
- **One-click apply** — apply the suggested description directly; the frontmatter `description` (including block scalars) is rewritten safely and everything else is left untouched.
  **改善案のワンクリック適用** — 提案された description をそのまま適用。frontmatter の `description`(block scalar 含む)だけを安全に書き換え、他は一切触らない。
- **Edit in the browser** — the SKILL.md tab gets an inline editor for project / user scope items (plugins and built-ins stay read-only). Saves are guarded by mtime conflict detection (no overwriting external edits) and a one-generation backup in `~/.cache/skills-viewer/backups/`.
  **ブラウザ内編集** — SKILL.md タブに編集モードを追加(project / user スコープのみ。plugin・built-in は従来どおり読み取り専用)。mtime による競合検出(外部編集を上書きしない)と `~/.cache/skills-viewer/backups/` への1世代バックアップ付き。

### Security

- The new write APIs (`/api/save`, `/api/apply-description`) go through the same path validation as copy/delete (`.claude/skills|commands|agents` only, plugin dirs rejected) plus the per-run token; AI diagnosis runs claude with all tools disabled, same as summaries.
  新設の書き込み API(`/api/save`・`/api/apply-description`)はコピー/削除と同じパス検証(`.claude/skills|commands|agents` 限定・plugin 拒否)+ 起動ごとトークンを通過。AI 診断は要約と同様ツール全無効で claude を実行。

## [0.4.0] - 2026-07-10

### Added

- **What's Changed banner** — items added / updated / removed since your last launch are shown in a banner (click a name to open it). The baseline advances only when you press _Dismiss_, so the diff survives reloads. First launch just records the baseline. Hooks and built-ins are not tracked.
  **What's Changed バナー** — 前回起動からの追加・更新・削除をバナーで表示(名前クリックで詳細へ)。基準は「既読にする」を押したときだけ進むため、リロードしても差分は消えません。初回起動は基準の記録のみ。hook と built-in は対象外。
- **CLI startup summary** — `npx skills-viewer` now prints a one-line digest at startup: changes since last run, session token injection, and unused count. Useful even with `--no-open`.
  **CLI 起動サマリー** — 起動時に「前回からの差分 / セッション注入トークン / 未使用件数」を1〜2行で表示。`--no-open` 運用でも価値が出ます。
- **Usage sparkline** — the detail pane charts the last 30 days of per-day usage (inline SVG, hover a bar for the date and count).
  **使用スパークライン** — 詳細画面に直近30日の日別使用回数を棒グラフ表示(バーの hover で日付と回数)。

### Changed

- **Usage filter** — the unused-only toggle is now a three-state segment: all / used / unused (`?use=used|unused`; old `?unused=1` links still work).
  **使用実績フィルタ** — 「未使用」トグルを「すべて / 使用あり / 未使用」の3状態セグメントに変更(`?use=used|unused`。旧 `?unused=1` の URL も引き続き解釈)。

## [0.3.0] - 2026-07-10

### Added

- **Unused badge & filter** — items with no recorded use within the transcript retention window (`cleanupPeriodDays`, default 30 days) get an _unused_ badge, with an unused-only toggle in the toolbar. Hidden entirely when no transcripts exist.
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
