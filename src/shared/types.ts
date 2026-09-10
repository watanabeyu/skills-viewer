/* server / web 共通の型定義(単一ソース) */

/*
 * 一覧に並ぶアイテムの種類。claude-md は SkillItem としては現れず、差分追跡(ChangeEntry)
 * だけで使う(CLAUDE.md は「呼び出す」ものではなく、毎セッション注入される文書のため)。
 */
export type ItemKind = 'skill' | 'command' | 'agent' | 'hook' | 'memory' | 'claude-md';
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
  /*
   * user scope の ~/.claude/CLAUDE.md へ。auto memory はリポジトリ単位でしか存在しないため、
   * プロジェクト横断で効かせたい user / feedback 型の置き場はここしかない(判断 11)。
   * 全プロジェクトの毎セッションに本文が乗るので、to-claude-md より適用は控えめに倒す
   */
  | 'to-user-claude-md'
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
  | 'body-over'
  /* 本文が別の登録プロジェクトの配下パスを指す(value = そのプロジェクトのフルパス。
   * 同名プロジェクトを区別するため basename にしない)。置き場所の誤りの機械的な根拠 */
  | 'other-project'
  /* AI が「索引行と本文が違うことを言っている」と答えた(診断時。value = description の冒頭) */
  | 'index-mismatch'
  /*
   * この索引行が MEMORY.md の読み込み上限(先頭 200 行 or 25KB、先に達した方)の外にある
   * (公式仕様。value = ファイル全体基準の行番号)。書いてあっても毎セッション注入されないため、
   * 常時コストには数えない(MemorySection.indexTokens は除外して合算する)
   */
  | 'index-beyond-limit';
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
  /* 索引行(description)と本文が同じことを言っているか(全件で AI に答えさせる。欠落は undefined) */
  indexMatchesBody?: boolean;
  /*
   * wrong-project の移動先プロジェクトのフルパス。AI には候補(other-project シグナルの値)からの
   * 「選択」だけをさせ、パスの文字列自体は書かせない(捏造した移動先を出させないため)
   */
  target?: string;
  /*
   * target の memory ディレクトリの絶対パス(<HOME>/.claude/projects/<slug>/memory)。
   * slug はリポジトリのルート基準で server がその都度算出する(キャッシュ値は使わない)
   */
  targetMemDir?: string;
  /*
   * verdict を keep へ格下げした記録(元の verdict を残す)。誤判定を握り潰さず「要確認」として
   * 観察を続けるためのもので、2 系統ある:
   *   - 機械シグナル(other-project)が無いのに wrong-project と答えた(判断 3)
   *   - 制限つきセクション(プロジェクト不明 / 共有ストア)で置き場所の判定(wrong-project /
   *     delete / to-*)を答えた(判断 5。帰属先が決まらず前提が成立しないため
   *     keep / shrink / update しか採用しない)
   * 型は実際に取り得る値だけに絞る: 格下げ先が keep なので keep は入らず、shrink / update は
   * 鮮度側の行き先でどちらのゲートも通過するため、格下げの記録として現れることがない
   */
  demoted?: Exclude<MemoryVerdict, 'keep' | 'shrink' | 'update'>;
  /*
   * 格下げの理由。環境条件が理由の 2 つは、条件が解消した件を再診断へ乗せ直す判定に使う:
   *   - 'orphan'     : セクションがプロジェクトへ逆引きできない(未マウント・登録抹消)
   *   - 'shared-env' : user scope の autoMemoryDirectory で全プロジェクトが 1 つの置き場を
   *                    共有している(共有ストアそのもの、および「別プロジェクトの memory dir へ
   *                    移す」という移動先の概念が成立しない環境)。設定を外せば帰属が戻るので、
   *                    そのときに再診断へ乗せる
   *   - 'no-signal'  : 内容側の理由(機械シグナルが無い、または候補と噛み合わない target を
   *                     返した)。内容が変わらない限り再診断しない
   */
  demotedBy?: 'orphan' | 'no-signal' | 'shared-env';
  /* AI 出力が採用できなかった件(verdict が不正・指示文欠落・返答なし)。UI は再診断を促す */
  error?: 'invalid-output';
  /* 生成日時(ISO)とモデル。詳細の診断見出しに「いつ・どのモデルが」を出すためだけの記録(判定には使わない) */
  generatedAt?: string;
  model?: AiModel;
}

/*
 * feedback 本文の分類。ルール行(1 行目)は常に残すのでフィールドを持たない。
 *   why: keep = そのまま / generalize = 固有名詞・日付を落とした 1 文(whyRewrite)に / drop = 削除
 *   how: keep = そのまま / keep-lines-only = 例外・境界(keepLines)だけ残す / drop = description の再掲なので削除
 *   keepLines: 本文からの抜粋(生成ではない。server で実在を検証済み)。例外(〜なら除く)と境界(どこまで進めてよいか)
 *   index: keep = 索引行はそのまま / rewrite = description が本文と食い違うので indexRewrite に書き換える
 */
export type FeedbackWhyPlan = 'keep' | 'generalize' | 'drop';
export type FeedbackHowPlan = 'keep' | 'keep-lines-only' | 'drop';
/* align = AI が索引と本文の食い違いを認めたのに書き換え案を出さなかった。どちらが正しいか確認して揃える(server が付ける) */
export type FeedbackIndexPlan = 'keep' | 'rewrite' | 'align';
export interface FeedbackBodyPlan {
  why: FeedbackWhyPlan;
  whyRewrite?: string;
  how: FeedbackHowPlan;
  keepLines: string[];
  index: FeedbackIndexPlan;
  indexRewrite?: string;
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
  /*
   * frontmatter の disable-model-invocation: true。モデルからは呼べず、description が
   * 一覧に載らないので毎セッションのコストに数えない(公式仕様)。
   */
  hidden?: boolean;
  /* frontmatter の allowed-tools(カンマ区切り)。「何に触るか」を AI 無しで出す一次情報 */
  allowedTools?: string[];
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
  /* MEMORY.md の索引行そのもの(診断キャッシュの hash に含める。索引に無ければ省略) */
  indexLine?: string;
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
  /* この索引行が MEMORY.md の読み込み上限(200 行 / 25KB)の外にあるか。無ければ省略(= 上限内) */
  indexBeyondLimit?: boolean;
}

/*
 * 1 プロジェクト分の自動メモリ。skill の Section とは別配列で配送する
 * (memory は「呼び出す」ものではなく、Section.source に置き場が無いため)。
 */
export interface MemorySection {
  /*
   * ~/.claude/projects 配下のエンコード済みディレクトリ名。
   * autoMemoryDirectory の置き場は `auto-` + 置き場パスのエンコード名(slug との衝突回避)
   */
  id: string;
  /* 逆引きできたプロジェクトの実パス。プロジェクト不明(逆引き不可)は null */
  projectPath: string | null;
  /* 表示名。プロジェクト不明はエンコード名そのまま(エンコードは非可逆的に情報が落ちるため、逆引きできない場合はそのまま表示する) */
  projectName: string;
  /* memory ディレクトリの実パス */
  note: string;
  isCurrent?: boolean;
  orphan?: boolean;
  /* settings の autoMemoryDirectory が指す置き場のセクション(~/.claude/projects 配下ではない) */
  autoDir?: true;
  /*
   * user scope の autoMemoryDirectory による「全プロジェクト共有の置き場」か。
   * どのプロジェクトの memory かを特定できないため projectPath は null になり、棚卸しは
   * orphan と同じ制限(keep / shrink / update のみ)に乗る。逆引き失敗ではないので orphan にはしない。
   * Read / Write 実績は全プロジェクトの transcript を横断して file_path で拾うので測れる
   * (usageAvailable は全体の transcript の有無で決まり、回数は全プロジェクト合算)
   */
  sharedStore?: true;
  /*
   * usageAvailable(そのプロジェクトの transcript があるか)の判定に使う slug。
   * 既定セクションは id 自身が slug なので持たず、autoDir セクションだけが持つ
   * (置き場のパスと transcript のディレクトリ名は無関係なため)。
   * 共有ストア(sharedStore)は transcript の帰属が決まらないため持たず、判定は全体の
   * transcript の有無で行う(実績は全プロジェクト合算)。
   * サーバー内部用。web に参照が無いので /api/skills 応答からは落とす(publicMemory)
   */
  transcriptSlug?: string;
  usageAvailable: boolean;
  /*
   * items の indexTokens 合計(= このプロジェクトで毎セッション注入される索引の量)。
   * 読み込み上限(200 行 / 25KB)の外にある索引行は数えない(indexBeyondLimit の件を除外)
   */
  indexTokens: number;
  /* 読み込み上限の外にある索引行の件数。無ければ省略(コストバーの「上限外 n 件」表示に使う) */
  indexBeyondCount?: number;
  /*
   * other-project シグナルの判定に使った「別の登録プロジェクト」候補(フルパス)。
   * wrong-project の移動先を AI に選ばせるときの候補集合でもあるので、計算元(scanMemory)から
   * そのまま運ぶ(同じ除外規則を 2 箇所で書かない)。候補が無ければ省略。
   * サーバー内部用。web に参照が無く payload だけ増えるので /api/skills 応答からは落とす
   */
  otherProjects?: string[];
  items: SkillItem[];
}

/* 前回起動(スナップショット)からの変化1件分 */
export interface ChangeEntry {
  name: string;
  kind: ItemKind;
  path: string;
  /* 出所。誰が・いつ(git)を引く対象は project のものだけ */
  source: Source;
  /* このファイルを最後に触ったコミットの author 名。project 出所かつ git 管理下のときだけ */
  author?: string;
  /* 同コミットの author date(ISO 8601)。author とセットで付く */
  authoredAt?: string;
}

/*
 * GET /api/diff の応答。available: false は「前版を出せない」(非 git / 履歴なし /
 * user scope)を意味し、web は diff ボタン自体を出さない。エラーではないので 200 で返す。
 */
export interface DiffResponse {
  available: boolean;
  /* HEAD 時点の内容(available: true のときだけ)。現在の内容は /api/file 側で取る */
  previous?: string;
  /*
   * not-git = git 管理下でない / no-history = HEAD に無い(新規ファイル等)
   * user-scope = ~/.claude 配下(全プロジェクト共有で git 履歴を持たない)
   * out-of-scope = 読み取りの境界の外 / too-large = 上限を超えて取得できなかった
   */
  reason?: 'not-git' | 'no-history' | 'user-scope' | 'out-of-scope' | 'too-large';
}

/* 前回起動からの差分。hook(識別子が不安定)と built-in(実ファイル無し)は対象外 */
export interface SnapshotChanges {
  added: ChangeEntry[];
  updated: ChangeEntry[];
  removed: ChangeEntry[];
  /*
   * この差分の起点(前回「既読にする」を押した時刻。ISO 8601)。
   * ホーム ① の「いつ既読にしてから」に使う。起点を持たない古い基準では省略される。
   */
  since?: string;
}

export interface Section {
  id: string;
  source: Source;
  /* source === 'project' のみ。見出し文字列はクライアント側で組み立てる */
  projectName?: string;
  isCurrent?: boolean;
  /* セクションの実体パス(built-in は '') */
  note: string;
  items: SkillItem[];
}

/* ---- CLAUDE.md 群(毎セッションの最初に読まれる指示) ---- */

/* 注入順の段。managed は OS が配る管理ポリシー、project-dot は <project>/.claude/CLAUDE.md */
export type ClaudeMdLayerKind =
  'managed' | 'user' | 'project' | 'project-dot' | 'local' | 'rules' | 'parent';

/* @import の展開結果。skipped が付いているものは中身を数えていない */
export interface ClaudeMdImport {
  /* 記述されていた参照(@ の後ろ) */
  ref: string;
  path: string;
  exists: boolean;
  /* 1 が直接の @import。公式仕様の上限は 4 段 */
  depth: number;
  tokens: number;
  /*
   * cycle = 展開の経路に自分が居る(本当の循環)
   * duplicate = 経路は違うが既に数えた(ダイヤモンド参照。二重計上を避けただけ)
   * depth = 4 段を超えた / too-large = 読み取り上限を超えた
   * out-of-scope = 読み取りの境界(プロジェクト配下・~/.claude 配下)の外
   */
  skipped?: 'cycle' | 'duplicate' | 'depth' | 'too-large' | 'out-of-scope';
}

export interface ClaudeMdFile {
  path: string;
  /* 本文だけの概算 */
  ownTokens: number;
  /* 本文 + 展開した @import の合計 */
  tokens: number;
  updatedAt: string;
  headings: { text: string; tokens: number }[];
  imports: ClaudeMdImport[];
  /* rules 段で frontmatter に paths: があり、常時ではなく遅延ロードされるもの */
  lazy?: boolean;
  /* 本文を返さない段(管理ポリシー)。存在と概算だけ扱う */
  bodyWithheld?: boolean;
  /*
   * 4 MiB を超えるため読まなかった。Claude Code 自身も読み飛ばすので毎回のコストは 0 だが、
   * 「無い」とは違う。段から消すと差分追跡で「消えた」と誤って出る
   */
  tooLarge?: boolean;
}

export interface ClaudeMdLayer {
  kind: ClaudeMdLayerKind;
  /* どこを見たか。ファイルが無い段でも「なし」の行を出せるように残す */
  label: string;
  files: ClaudeMdFile[];
  /* この段が毎セッション持ち込む概算(lazy は除く) */
  tokens: number;
}

export interface ClaudeMdScan {
  /* 注入順。無い段も files: [] で残る */
  layers: ClaudeMdLayer[];
  tokens: number;
  /*
   * @import の件数の上限(1 ファイル 200 件 / 走査全体 500 件)で展開を止めたときだけ立つ。
   * 打ち切った先の @import は要素自体を作らないので、tokens が理由不明のまま小さく出る。
   * 「常時コストを正しく出す」のが売りの画面が黙って数字を削らないよう、印を返して画面に出す。
   * どちらの上限かは分けない ── 利用者が取る行動(参照を減らす)は同じで、上限の値は README にある。
   */
  importsTruncated?: true;
}

/*
 * 毎セッションの最初に読まれるものの内訳。viewer から見えないもの
 * (システムプロンプト・MCP・hook の出力)は含まない。
 */
export interface SessionContext {
  claudeMd: { tok: number };
  /* MEMORY.md の索引。上限は公式仕様(先頭 200 行 or 25KB の先に達した方) */
  memoryIndex: { tok: number; lines: number; limitLines: number; limitBytes: number };
  /* skill / command / agent の name + description。hidden は注入されないので除く */
  descriptions: { tok: number; count: number; hiddenCount: number; limit: number };
}

/*
 * description の予算。公式は「コンテキスト窓の 1%」で、200k 窓なら 2,000。
 * settings.json に相当するキーは無い(2026-09-08 確認)ので source は default 固定。
 */
export interface DescriptionBudget {
  used: number;
  limit: number;
  source: 'default';
}

/*
 * サーバーが「どのプロジェクトの文脈(claudeMd / context / budget / memory の isCurrent)を
 * 計算したか」。?project=<id> の id はサーバー側で登録済みプロジェクトと照合され、
 * 未知の id や省略時は cwd に落ちるので、web は要求ではなく結果のこれを見る(計画 16 判断 3)。
 */
export interface SelectedProject {
  /* Section.id と同じ規則(projectSectionId)。0 件で Section が無いプロジェクトでも値は付く */
  id: string;
  path: string;
  /* path の basename(表示用) */
  name: string;
  /* 起動ディレクトリそのものか。既定の選択がこれ */
  isCwd: boolean;
  /*
   * 選んだものが linked worktree のとき、その本体(メインワークツリー)のパス。
   * skill は worktree 自身の .claude、メモリは本体に収束する ── なぜそうなるかを
   * 画面に 1 行で言うために持つ(計画 16 Phase C)。worktree でなければ付かない。
   */
  mainPath?: string;
  /* mainPath の id(Section.id と同じ規則)。本体へ戻る選択肢を web が組めるように付ける */
  mainId?: string;
}

/* 本体から列挙した linked worktree(計画 16 判断 5)。登録の有無に依らず切替の候補になる */
export interface Worktree {
  /* Section.id と同じ規則。id は必ずサーバーが作る(web でパスから組み立てない = 判断 2) */
  id: string;
  path: string;
  /* path の basename(表示用) */
  name: string;
  /* チェックアウト中のブランチ。detached HEAD では付かない */
  branch?: string;
  /* この worktree の本体(メインワークツリー)のパス。切替はこの本体の 1 行に畳む */
  mainPath: string;
  /*
   * mainPath の id(Section.id と同じ規則)。本体は定義 0 件・未登録で Section を持たないことが
   * あり、そのとき web には本体を指す id が無かった ── 逆引きした本体も候補に入れたので、
   * 「本体の行 / 本体の選択肢」を選べるように id もサーバーが作る(判断 2)。
   */
  mainId: string;
}

export interface SkillsData {
  generatedAt: string;
  cwd: string;
  /* この応答の ② を計算した対象。cwd は既定の選択にすぎない(計画 16) */
  selected: SelectedProject;
  /*
   * 登録済みプロジェクトの本体から列挙した linked worktree。1 件も無ければ省略。
   * sections は変えない(worktree の Section はそのまま)。切替が path で突き合わせて
   * 本体の 1 行に畳むので、同じプロジェクトが 2 か所に出ることはない(計画 16 判断 6)。
   */
  worktrees?: Worktree[];
  sections: Section[];
  aiStale: number;
  /*
   * claude CLI が使えるか(サーバー起動時に `claude --version` を 1 回実行した結果)。
   * false なら web は AI 生成のボタンを無効化する。起動後に CLI を入れても再起動まで変わらない。
   */
  aiAvailable: boolean;
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
  /* CLAUDE.md 群(注入順。無い段も残る) */
  claudeMd: ClaudeMdScan;
  /* description の常時コストと予算 */
  budget: DescriptionBudget;
  /* 毎セッションの最初に読まれるものの内訳 */
  context: SessionContext;
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
