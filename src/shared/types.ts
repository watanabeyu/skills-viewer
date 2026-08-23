/* server / web 共通の型定義(単一ソース) */

export type ItemKind = 'skill' | 'command' | 'agent' | 'hook' | 'memory';
export type Source = 'built-in' | 'user' | 'project' | 'plugin';
/*
 * 自動メモリ(~/.claude/projects/<encoded>/memory/*.md)の frontmatter type。
 * user はスコープではなく「人物像」という内容分類なので、表示ラベルは web 側で意訳する。
 */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';
export type Invocation = 'human' | 'agent' | 'both';
export type Lang = 'ja' | 'en';
/* AI 機能(要約/診断/グルーピング)に使う claude CLI のモデルエイリアス */
export type AiModel = 'haiku' | 'sonnet' | 'opus';
/* 言語非依存のキー。表示ラベルは web 側の辞書で解決する */
export type RelationType = 'invokes' | 'delegates' | 'called-by' | 'references';
/* description の静的リント警告(言語非依存キー。表示ラベルは web 側の辞書で解決する) */
export type LintCode =
  'no-description' | 'short-description' | 'long-description' | 'no-trigger' | 'name-echo';

export interface SkillRelation {
  name: string;
  type: RelationType;
  note: string;
}

/* AI 発動診断の結果(claude CLI / haiku で生成、content hash + lang でキャッシュ) */
export interface SkillDiagnosis {
  verdict: 'good' | 'weak';
  issues: string[];
  improved: string;
}

/*
 * AI 棚卸し診断(memory)の行き先。あくまで仮説で、採否は「指示文を貼るかどうか」で人間が決める
 * (viewer は選択状態を持たず、実行もしない)。
 */
export type MemoryVerdict =
  | 'keep'
  | 'shrink'
  | 'to-claude-md'
  | 'to-docs'
  | 'delete'
  | 'wrong-project'
  /* 特定の skill / command の挙動への好み。SKILL.md へ書けば全プロジェクトで効き、memory 自体が不要になる */
  | 'to-skill'
  /* 骨子は生きているが一部(日付・パス・手順・type)が古い。書き直せば使える(索引は ±0) */
  | 'update';

/*
 * 鮮度(state)。「何の情報か」(type)とは別の軸で、AI が根拠つきで判定する。
 * 行き先(verdict)は type × state の対応表から導く(プロンプト側に固定)。
 *   current    = 今も正しい。恒久的
 *   outdated   = 骨子は生きているが一部が古い → update
 *   historical = 過去の事実としては正しいが現在値ではない。記録価値はある → to-docs
 *   obsolete   = 役目を終えた。記録価値もない → delete
 */
export type MemoryState = 'current' | 'outdated' | 'historical' | 'obsolete';

/*
 * 鮮度の機械シグナル(事実のみ。行き先は決めない)。value は言語非依存の生値で、表示は web が解決する。
 *   date           = 本文中の最新の絶対日付(value = YYYY-MM-DD、days = 経過日)
 *   path-missing   = 本文が参照するパスが存在しない(value = そのパス)
 *   done-words     = 完了・廃止を表す語が本文にある(value = 見つかった語、カンマ区切り)
 *   branch-merged  = 本文に出るブランチがマージ済み(value = ブランチ名)
 *   branch-missing = 本文に出るブランチがローカルにもリモートにも無い(value = ブランチ名)
 * date / path-missing / done-words はスキャン時(SkillItem.signals)、branch-* は診断時(MemoryTriage.signals)
 */
export type MemorySignalKind =
  | 'date'
  | 'path-missing'
  | 'done-words'
  | 'branch-merged'
  | 'branch-missing'
  /* ---- feedback / user 型の本文構造(1 行目 / **Why:** / **How to apply:**)から拾う事実 ---- */
  /* How to apply が description の再掲(value = 2-gram Dice 類似度 %) */
  | 'how-restates'
  /* Why にブランチ名 / #番号 / 日付 / 「ユーザーが指摘」などエピソード固有の語(value = その語) */
  | 'why-episodic'
  /* 本文に例外・但し書きがある(value = その行の冒頭) */
  | 'has-exception'
  /* 本文 1 行目が description の再掲(value = 類似度 %。正常な形) */
  | 'first-line-restates'
  /* feedback として本文が長い(value = tok) */
  | 'body-over';
export interface MemorySignal {
  kind: MemorySignalKind;
  value: string;
  days?: number;
}

/* 1 memory 分の棚卸し診断。instruction は Claude Code に貼る指示文(keep なら空) */
export interface MemoryTriage {
  verdict: MemoryVerdict;
  /* 鮮度。出力不正の件と旧形式のキャッシュには無い(旧形式は次の差分診断で置き換わる) */
  state?: MemoryState;
  reason: string;
  issues: string[];
  instruction: string;
  /* 診断時に集めた git 層のシグナル(ブランチのマージ状況)。スキャン時の SkillItem.signals とは別 */
  signals?: MemorySignal[];
  /*
   * feedback / user 型で verdict が shrink / update のときの「残す / 削る」分類。
   * 散文の instruction の代わりに web がテンプレートで指示文を組む(モデル非依存)。無ければ instruction にフォールバック
   */
  body?: FeedbackBodyPlan;
  /* AI 出力が採用できなかった件(verdict が不正・指示文欠落・返答なし)。UI は再診断を促す */
  error?: 'invalid-output';
}

/*
 * feedback 本文の分類。ルール行(1 行目)は常に残すのでフィールドを持たない。
 *   why: keep = そのまま / generalize = 固有名詞・日付を落とした 1 文(whyRewrite)に / drop = 削除
 *   how: keep = そのまま / keep-exceptions-only = 例外(exceptions)だけ残す / drop = description の再掲なので削除
 *   exceptions: 本文からの抜粋(生成ではない。server で実在を検証済み)
 */
export type FeedbackWhyPlan = 'keep' | 'generalize' | 'drop';
export type FeedbackHowPlan = 'keep' | 'keep-exceptions-only' | 'drop';
export interface FeedbackBodyPlan {
  why: FeedbackWhyPlan;
  whyRewrite?: string;
  how: FeedbackHowPlan;
  exceptions: string[];
}

/* AI グルーピングの1グループ。id は言語非依存スラッグ、label は表示言語で生成 */
export interface SkillGroup {
  id: string;
  label: string;
  emoji?: string;
}

/* AI フロー図解: SKILL.md から抽出した処理フロー(直列 + 分岐注記に制約) */
export interface SkillFlowBranch {
  when: string;
  then: string;
  /* 分岐の行き先ステップ番号(1 始まり)。後方=ループ/リトライ、前方=スキップ。中断・終了は省略 */
  to?: number;
}
export interface SkillFlowStep {
  title: string;
  detail: string;
  /* このステップで起動/委譲する他 skill・外部ツール名 */
  calls: string[];
  /* human = 人間の確認/承認を待つステップ(UI で強調) */
  gate: 'human' | 'auto' | null;
  branches: SkillFlowBranch[];
}
export interface SkillFlow {
  steps: SkillFlowStep[];
}

export interface SkillItem {
  name: string;
  description: string;
  argumentHint: string;
  version: string;
  kind: ItemKind;
  path: string;
  updatedAt?: number;
  files: string[];
  refs?: string[];
  /* 静的リント警告(無警告のときは省略) */
  lint?: LintCode[];
  /* frontmatter の category(手動グループ指定。AI 分類より優先され、AI 分類の対象外) */
  category?: string;
  /* AI 分類による所属グループ(SkillsData.groups の id)。name 単位の割当 */
  aiGroup?: string;
  /* name + description が毎セッション注入される分のトークン概算(hook は対象外) */
  tokens?: number;
  useCount?: number;
  typedCount?: number;
  autoCount?: number;
  lastUsed?: number;
  /* 日別使用回数(YYYY-MM-DD → 回数、ローカルタイムゾーン)。未使用なら省略 */
  dailyUse?: Record<string, number>;
  aiSummary?: string;
  aiDiagnosis?: SkillDiagnosis;
  /* キャッシュ済みの AI フロー図解(未生成なら省略。生成はオンデマンド) */
  aiFlow?: SkillFlow;
  aiInvocation?: Invocation;
  aiInvocationReason?: string;
  aiRelations?: SkillRelation[];
  /* ---- kind === 'memory' のみ ---- */
  /* frontmatter の type(トップレベル / metadata: 配下のどちらでも受ける)。未指定なら省略 */
  memoryType?: MemoryType;
  /* MEMORY.md の索引行の概算トークン(毎セッション注入される分)。索引に無ければ 0 */
  indexTokens?: number;
  /* 本文全体の概算トークン(Read されたときだけかかる分) */
  bodyTokens?: number;
  /* 本文中の [[x]] 参照(重複排除。解決は web 側で行う) */
  links?: string[];
  /* このメモリを書いたセッションの id(frontmatter 由来) */
  originSessionId?: string;
  /* Write / Edit の回数(作成・更新)。参照回数は useCount 側。0 回なら省略 */
  writeCount?: number;
  /* 鮮度の機械シグナル(テキスト / fs 層。スキャン時に算出)。無ければ省略 */
  signals?: MemorySignal[];
  /* キャッシュ済みの AI 棚卸し診断(未診断なら省略。生成はオンデマンド) */
  aiTriage?: MemoryTriage;
}

/*
 * 1 プロジェクト分の自動メモリ。skill の Section とは別配列で配送する
 * (memory は「呼び出す」ものではなく、Section.source に置き場が無いため)。
 */
export interface MemorySection {
  /* ~/.claude/projects 配下のエンコード済みディレクトリ名 */
  id: string;
  /* 逆引きできたプロジェクトの実パス。孤児(逆引き不可)は null */
  projectPath: string | null;
  /* 表示名。孤児はエンコード名そのまま(エンコードは不可逆で復元できない) */
  projectName: string;
  /* memory ディレクトリの実パス */
  note: string;
  isCurrent?: boolean;
  orphan?: boolean;
  usageAvailable: boolean;
  /* items の indexTokens 合計(= このプロジェクトで毎セッション注入される索引の量) */
  indexTokens: number;
  items: SkillItem[];
}

/* 前回起動(スナップショット)からの変化1件分 */
export interface ChangeEntry {
  name: string;
  kind: ItemKind;
  path: string;
}

/* 前回起動からの差分。hook(識別子が不安定)と built-in(実ファイル無し)は対象外 */
export interface SnapshotChanges {
  added: ChangeEntry[];
  updated: ChangeEntry[];
  removed: ChangeEntry[];
}

export interface Section {
  id: string;
  source: Source;
  /* source === 'project' のみ。見出し文字列はクライアント側で組み立てる */
  projectName?: string;
  isCurrent?: boolean;
  /* セクションの実体パス(built-in は '') */
  note: string;
  manage?: boolean;
  items: SkillItem[];
}

export interface CopyTarget {
  label: string;
  sub: string;
  path: string;
}

export interface SkillsData {
  generatedAt: string;
  cwd: string;
  sections: Section[];
  targets: CopyTarget[];
  aiStale: number;
  /* トランスクリプトが1件でもあるか。false なら「未使用」表示は無意味なので出さない */
  usageAvailable: boolean;
  /* 前回起動からの差分。初回起動・差分なし・既読済みは null */
  changes: SnapshotChanges | null;
  /* AI グルーピングの結果(表示順)。未生成なら省略 */
  groups?: SkillGroup[];
  /* グループ生成後にアイテム構成(name + description)が変わったか(再分類を促す) */
  groupsStale?: boolean;
  /* 自動メモリ(読み取り専用)。1 件も無ければ省略 */
  memory?: MemorySection[];
}

export interface SummaryJob {
  finished: boolean;
  total: number;
  done: number;
  current?: string;
  errors: string[];
}

export interface SkillAnalysis {
  summary: string;
  invocation: Invocation | null;
  invocationReason: string;
  relations: SkillRelation[];
}
