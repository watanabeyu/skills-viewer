# Changelog

All notable changes to this project are documented here, in English followed by Japanese.
このファイルには主要な変更を記録します(英語の後に日本語を併記)。

## [0.8.0] - 2026-08-24

Your auto memory now has a place to be seen — and a way to get smaller.
自動メモリを「見える」ようにし、「減らす」動線をつけました。

### Added

- **Memory view** — a fourth view axis, _Memory_, lists Claude Code's auto memory (`~/.claude/projects/<project>/memory/*.md`) per project, independent of skills. Each project gets a cost bar that splits the context cost into the always-on part (the `MEMORY.md` index line injected into every session, ≈40 tok per memory) and the pay-per-use part (the body, charged only when Read), the per-memory average, and a comparison against the tokens your plugins and user-scope skills inject. Cards show the frontmatter type, whether the body was Read within the transcript retention window, and the two costs; the detail pane adds Read / Write counts, the originating session, outgoing links, backlinks, unresolved `[[link]]`s and the raw frontmatter. Memory is read-only in the viewer. Orphan memory directories (projects no longer registered) are listed too.
  **Memory ビュー** — 表示軸に「メモリ」を追加し、Claude Code の自動メモリ(`~/.claude/projects/<project>/memory/*.md`)を skill とは独立にプロジェクト単位で一覧します。プロジェクトごとのコストバーは、コンテキストコストを常時コスト(`MEMORY.md` の索引行。毎セッション注入され 1 件 ≈40 tok)と従量コスト(本文。Read されたときだけ)に分け、1 件あたりの平均と、plugin・user scope の skill が注入するトークンとの比較を出します。カードには frontmatter の type、保持期間内に本文が Read されたか、2 種類のコストを表示し、詳細では Read / Write 回数・生成元セッション・発リンク・被リンク・リンク切れ・frontmatter 原文を確認できます。viewer から memory への書き込みはしません。登録が消えたプロジェクトの memory も「プロジェクト不明」として列挙します。
- **AI memory triage** — the claude CLI reads every memory of a project (one call, split into a few for very large projects; only the ones whose body changed since the last run, cached per memory by content hash + language) and proposes a destination for each: keep / shrink / move to CLAUDE.md / move to docs / move to a skill / delete / wrong project, with the reasoning, the facts behind it, a static token estimate, and a paste-ready instruction for Claude Code that is asked to always cover removing the `MEMORY.md` index line, re-pointing `[[link]]`s, and the cost warning when a move to CLAUDE.md would turn one index line into a full-body injection. The prompt also carries the headings of the project's `CLAUDE.md` and the names + descriptions of its skills, so rules that already live there are flagged for deletion and skill-specific preferences are promoted to the skill instead of staying in memory. Copied instructions start with a "inspect first, ask when unsure, execute after approval" preamble. Three entry points: the cost bar, the detail pane (single memory) and the ✦ AI menu.
  **AI memory 棚卸し** — プロジェクトの memory 全件(前回から本文が変わった件だけ。結果は本文 hash + 言語で件単位キャッシュ)を claude CLI で読み(通常 1 回、件数が非常に多いときは数回に分割)、1 件ごとに行き先 — このまま / 本文を縮める / CLAUDE.md へ / docs へ / skill へ / 削除 / 別プロジェクト — と理由・根拠・削減試算・**Claude Code に貼れる指示文**を提案します。指示文には `MEMORY.md` の索引行の削除・`[[link]]` の張り替え・CLAUDE.md 行きで全文注入に変わるときのコスト警告を必ず含めるよう指示しています。プロンプトにはプロジェクトの `CLAUDE.md` の見出しと skill の name + description も渡すので、既に書いてあるルールは削除、特定 skill に関する好みはその skill へ昇格、と判断されます。コピーした指示文には「まず確認 → 判断が要る点は質問 → 承認後に実行」の前置きが付きます。入口はコストバー・詳細(1 件)・✦ AI メニューの 3 つです。
- **Memory Read / Write tracking** — transcripts are scanned for Read / Write / Edit tool calls on memory files in the same pass that already collects skill usage, attributed by file path so that sessions running in git worktrees count toward their parent repository's memory.
  **memory の Read / Write 集計** — skill の使用実績を集める transcript の 1 パスで memory ファイルへの Read / Write / Edit も拾い、ファイルパスで集計するため、git worktree で動いたセッションの参照も親リポジトリの memory に寄ります。

- **Freshness (state) and machine signals** — before picking a destination, the triage now judges whether each memory is still true — _current / outdated / historical / obsolete_ — from facts, and derives the verdict from a fixed type × state table; a new verdict, _rewrite the body_ (`update`), covers memories whose gist holds but whose paths, dates or index line went stale. Mechanical signals feed that judgment and are quoted as evidence: the latest date in the body, referenced paths that no longer exist, completion words, branches already merged or gone (from local `git`, no network), and bodies that point at another registered project. The model is also asked whether the `MEMORY.md` index line still says the same thing as the body; when it does not, a warning is shown regardless of the verdict and the instruction includes rewriting the index line. For feedback memories, "what to keep and what to cut" comes back as a small classification (Why: keep / generalize / drop; How to apply: keep / exceptions and boundaries only / drop; index line: keep / rewrite) and the paste-ready instruction is assembled from a fixed template, so it reads the same whether the model is haiku, sonnet or opus. Clicking a memory name in the triage view opens its body in a modal.
  **鮮度(state)と機械シグナル** — 棚卸し診断は行き先を決める前に、各 memory が**まだ正しいか**(current / outdated / historical / obsolete)を事実から判定し、verdict は type × state の固定表から導くようになりました。骨子は生きているがパス・日付・索引行が古い memory には、新しい verdict「本文を書き直す」(`update`)が付きます。判定の材料として機械シグナル — 本文の最新日付、存在しない参照パス、完了語、マージ済み / 消えたブランチ(ローカル `git`。ネットワーク不使用)、別の登録プロジェクトを指す本文 — を渡し、根拠として引用させます。`MEMORY.md` の索引行が本文と同じことを言っているかも毎回答えさせ、食い違っていれば verdict に関わらず注意を表示し、指示文に索引行の書き換えを含めます。feedback 型では「何を残して何を削るか」を小さな分類(Why: そのまま / 一般化 / 削除、How to apply: そのまま / 例外と境界だけ / 削除、索引行: そのまま / 書き換え)として返させ、貼る指示文は固定テンプレートで組むので、haiku / sonnet / opus のどれでも同じ文面になります。棚卸し画面で memory 名をクリックすると本文がモーダルで開きます。

### Changed

- The _unused_ badge and filter are now worded _no recent use_ / _recent use_ — the data only covers the transcript retention window (`cleanupPeriodDays`, default 30 days), so "unused" was a claim the tool could not back. The CLI startup summary follows suit.
  「未使用」バッジとフィルタを「直近未使用 / 直近使用あり」に改めました。データは transcript の保持期間(`cleanupPeriodDays`、既定 30 日)の範囲しか無いので、「未使用」は言い切りすぎでした。CLI の起動サマリも同様です。
- Frontmatter parsing now understands one level of nesting (`metadata:` blocks), which Claude Code uses in memory files. Existing skill / command / agent parsing is unchanged.
  frontmatter のパーサが 1 段のネスト(memory ファイルで使われる `metadata:` ブロック)を読めるようになりました。既存の skill / command / agent の解釈は変わりません。
- When run from a git worktree, the parent repository is now treated as the current project for memory (memory lives per repository, not per worktree).
  git worktree から起動したとき、memory については親リポジトリを現在のプロジェクトとして扱います(memory は worktree ごとではなくリポジトリ単位にあるため)。
- AI caches keyed by file path (summaries / diagnoses / flows / memory triage) drop entries for files that no longer exist when they are saved.
  ファイルパスをキーにする AI キャッシュ(要約 / 診断 / フロー / memory 棚卸し)は、保存時に存在しないファイルのエントリを捨てるようになりました。

## [0.7.0] - 2026-08-09

### Changed

- **Flow diagram, flowchart-style** — the AI flow diagram now renders decision nodes for branches, loop arrows for retries (a branch that points back to an earlier step), skip arrows for forward jumps, and terminal capsules for aborts / completion. The extracted flow carries a `branches.to` step index so the diagram can draw the actual control flow instead of annotating branches as text.
  **フロー図解をフローチャート型に一新** — AI フロー図解が、分岐を判断ノード、リトライ(前のステップへ戻る分岐)をループ矢印、先へ飛ぶ分岐をスキップ矢印、中断・完了を終端カプセルとして描くようになりました。抽出結果に `branches.to`(分岐先のステップ番号)を持たせ、分岐を注記で済ませず実際の制御フローとして描画します。

## [0.6.0] - 2026-07-28

Skills now group by _when you use them_, not just where they live.
スキルを「どこにあるか」だけでなく「いつ使うか」でも眺められるようになりました。

### Added

- **Purpose grouping (AI)** — a single `claude -p` (haiku) call reads every installed item (name + description, deduplicated by name so same-name items across scopes land in the same group) and proposes 4–8 purpose groups generated for _your_ environment, assigning each item to one. The prompt only carries a role-agnostic workflow axis (planning / building / review / release / research / operations) as a granularity guide — group names themselves are not baked into the product, so non-engineering skill sets get fitting groups too. Cached per language in `~/.cache/skills-viewer/groups.json`; when items change afterwards, the view shows a _reclassify_ hint instead of silently re-running AI.
  **用途グルーピング (AI)** — `claude -p`(haiku)の1回の呼び出しでインストール済み全アイテム(name + description。name で重複排除するので、スコープ違いの同名定義は同じグループに落ちる)を読み、その環境に合わせた 4〜8 個の用途グループを生成して各アイテムを割り当てます。プロンプトに渡すのは職種非依存の工程軸(企画・要件 / 制作・実装 / レビュー・検証 / リリース・共有 / 調査・分析 / 記録・運用)という粒度ガイドだけで、グループ名はプロダクトに焼き込みません — エンジニア以外のスキル群にもその分野のグループが生えます。言語ごとに `~/.cache/skills-viewer/groups.json` へキャッシュし、その後アイテム構成が変わったら AI を勝手に再実行せず「再分類」の導線を表示します。
- **View axis** — the list switches between _By source_ / _By purpose_ / _Flat_ (`?view=group|flat`; old `?grouped=0` links are still interpreted as flat). The by-purpose view keeps the source sections (each repository / user / plugins / built-ins) and subdivides each of them by purpose, so you can see e.g. one repository's own planning / review / release breakdown. The detail pane's left column follows the same axis, and the item's group shows as a badge in the detail header.
  **表示軸** — 一覧を「ソース別 / 用途別 / フラット」で切替(`?view=group|flat`。旧 `?grouped=0` の URL はフラットとして解釈)。用途別はソースセクション(各リポジトリ / user / plugin / built-in)の枠を保ったまま、その中を用途グループで小分けします — リポジトリごとの企画・要件 / レビュー / リリースの内訳がそのまま見えます。詳細画面の左カラムも同じ軸に追従し、所属グループは詳細ヘッダにバッジ表示されます。
- **Manual `category`** — a `category:` field in the frontmatter pins the item to that group (shown with a _manual_ badge), takes precedence over AI grouping, and is excluded from AI classification. The value is not normalized: the same string means the same group, so teams can standardize via convention.
  **手動 `category`** — frontmatter の `category:` でグループを固定(「手動」バッジ付き)。AI 分類より優先され、AI 分類の対象からも外れます。値は正規化しません(同じ文字列 = 同じグループ)。チームで揃えたい場合は文字列の運用で統一してください。
- **AI flow diagram** — a new _Flow_ tab in the detail pane (Overview | Flow | SKILL.md; marked ✦ once generated, and the selected tab sticks while browsing items). For orchestration-style skills (e.g. a kickoff command that checks readiness, creates a worktree, delegates to another skill and waits for approval), one click extracts the processing flow from the definition body and renders it as a vertical step diagram: steps, abort/fallback branches, delegated skills as clickable chips, and highlighted _human gates_. On-demand per item, cached by content hash + language. Rendered with plain CSS — no diagram library, zero runtime dependencies kept.
  **AI フロー図解** — 詳細画面に「フロー」タブを新設(概要 | フロー | SKILL.md。生成済みは ✦ 付き、選択タブはアイテムを切り替えても維持)。オーケストレーション型の skill(ready 判定 → worktree 作成 → 他 skill へ委譲 → 承認待ち、のような kickoff 系)について、定義本文から処理フローをワンクリックで抽出し縦型ステップ図として表示します: ステップ・中断/フォールバック分岐・委譲先スキル(クリックで遷移)・**人間ゲート**の強調表示。アイテムごとのオンデマンド実行で content hash + 言語でキャッシュ。描画は CSS のみで図ライブラリ不使用(zero runtime dependency を維持)。
- **AI model selection** — Settings now offers the model used by all AI features (summaries / trigger diagnosis / purpose grouping): `haiku` (default), `sonnet`, or `opus`, passed to the claude CLI as an alias and resolved by your installed CLI. Switching applies to new generations only; caches are kept (force-regenerate to replace) and record which model produced them.
  **AI モデル選択** — AI 機能(要約 / 発動診断 / 用途グルーピング)に使うモデルを設定で選べるようになりました: `haiku`(既定)/ `sonnet` / `opus`。claude CLI にエイリアスとして渡され、実体は手元の CLI が解決します。切替は次回の生成から適用され、生成済みキャッシュは維持されます(置き換えは強制再生成。どのモデルで生成したかはキャッシュに記録)。

### Changed

- The _Group by source_ checkbox is replaced by the three-way view segment above.
  「グループ化」チェックボックスは上記の3状態セグメントに置き換えました。
- **Header cleanup** — the kind and usage filters turned from button segments into compact selects (highlighted while a filter is active), and the AI actions (summaries + purpose grouping) are consolidated into a single _✦ AI_ menu on the right. The view segment stays as the primary control.
  **ヘッダー整理** — 種類・使用実績フィルタをボタン群からコンパクトな select に変更(絞り込み中は強調表示)。AI 操作(要約 + 用途グルーピング)は右端の「✦ AI」メニューに集約しました。表示軸セグメントは主要操作としてそのまま残しています。

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
