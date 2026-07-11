/* server / web 共通の型定義(単一ソース) */

export type ItemKind = 'skill' | 'command' | 'agent' | 'hook';
export type Source = 'built-in' | 'user' | 'project' | 'plugin';
export type Invocation = 'human' | 'agent' | 'both';
export type Lang = 'ja' | 'en';
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
  /* name + description が毎セッション注入される分のトークン概算(hook は対象外) */
  tokens?: number;
  useCount?: number;
  typedCount?: number;
  autoCount?: number;
  lastUsed?: number;
  /* 日別使用回数(YYYY-MM-DD → 回数、ローカルタイムゾーン)。未使用なら省略 */
  dailyUse?: Record<string, number>;
  aiSummary?: string;
  aiInvocation?: Invocation;
  aiInvocationReason?: string;
  aiRelations?: SkillRelation[];
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
