/* server / web 共通の型定義(単一ソース) */

export type ItemKind = 'skill' | 'command' | 'agent' | 'hook';
export type Source = 'built-in' | 'user' | 'project' | 'plugin';
export type Invocation = 'human' | 'agent' | 'both';
export type RelationType = '起動' | '委譲' | '呼ばれる側' | '参照';

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
  useCount?: number;
  typedCount?: number;
  autoCount?: number;
  lastUsed?: number;
  aiSummary?: string;
  aiInvocation?: Invocation;
  aiInvocationReason?: string;
  aiRelations?: SkillRelation[];
}

export interface Section {
  id: string;
  source: Source;
  heading: string;
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
