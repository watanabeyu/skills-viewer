/*
 * 理解画面(計画 15 Phase E1)の機械情報。AI 無しでも各ブロックが読めるように、
 * frontmatter・走査結果・差分(snapshot + git)だけから組み立てる純粋ロジック。
 * 描画は components/{FactsBand,InvokeBlock,TouchesBlock,HookView}.tsx。
 */

import type { RelationType, SkillItem, SkillRelation, SnapshotChanges } from './api';

/* ---- 触るもの(設計判断 #12): allowed-tools からの機械判定 ---- */

/* allowed-tools の要素からツール名を取る。`Bash(git *)` → `Bash` */
export const toolName = (spec: string) => spec.replace(/\(.*$/, '').trim();

/* 書き込み・外部呼び出しとみなすツール(計画 15 E1 の規則。ここ以外に増やさない) */
export const WRITE_TOOLS = ['Write', 'Edit'];
export const EXTERNAL_TOOLS = ['Bash', 'WebFetch'];

export interface Touches {
  /* allowed-tools の指定。無ければ null(= 全ツールが使える) */
  tools: string[] | null;
  /* 指定の中で書き込み系にあたるもの(ツール名で重複排除) */
  writes: string[];
  /* 指定の中で外部呼び出しにあたるもの */
  external: string[];
}

export function touchesOf(allowedTools?: string[]): Touches {
  if (!allowedTools?.length) return { tools: null, writes: [], external: [] };
  const names = [...new Set(allowedTools.map(toolName).filter(Boolean))];
  return {
    tools: allowedTools,
    writes: names.filter((n) => WRITE_TOOLS.includes(n)),
    external: names.filter((n) => EXTERNAL_TOOLS.includes(n)),
  };
}

/* ---- 委譲先: 本文からの静的抽出(refs)に AI 分類(aiRelations)を足す ---- */

export interface Delegate {
  name: string;
  /* AI 分類があればその関係タイプ。静的抽出だけなら references */
  type: RelationType;
  ai: boolean;
  note: string;
}

/* 同じ名前は 1 件に寄せ、AI の関係タイプがあればそれを採る(AI は追加であって上書きしない) */
export function delegatesOf(it: Pick<SkillItem, 'refs' | 'aiRelations'>): Delegate[] {
  const by = new Map<string, Delegate>();
  for (const name of it.refs || []) by.set(name, { name, type: 'references', ai: false, note: '' });
  for (const rel of (it.aiRelations || []) as SkillRelation[]) {
    by.set(rel.name, { name: rel.name, type: rel.type, ai: true, note: rel.note });
  }
  return [...by.values()];
}

/* ---- 事実の帯「追加・更新」: 差分(既読基準 + git)があればそれを、無ければ mtime だけ ---- */

export interface History {
  /* この項目が前回既読からの差分に載っているか(増えた / 変わった)。無ければ null */
  mark: 'add' | 'mod' | null;
  /* git から引けた author(project 出所かつ git 管理下のときだけ) */
  who?: string;
  /* author date(ms)。who とセット */
  when?: number;
  /* ファイルの mtime(ms)。built-in など無いものは undefined */
  updatedAt?: number;
}

export function historyOf(
  it: Pick<SkillItem, 'path' | 'kind' | 'updatedAt'>,
  changes: SnapshotChanges | null,
): History {
  const hit = (list: SnapshotChanges['added']) =>
    list.find((e) => e.path === it.path && e.kind === it.kind);
  const added = changes ? hit(changes.added) : undefined;
  const entry = added || (changes ? hit(changes.updated) : undefined);
  const when = entry?.authoredAt ? Date.parse(entry.authoredAt) : NaN;
  return {
    mark: entry ? (added ? 'add' : 'mod') : null,
    ...(entry?.author ? { who: entry.author } : {}),
    ...(Number.isFinite(when) ? { when } : {}),
    updatedAt: it.updatedAt,
  };
}

/* ---- hook: name は scan.ts が `event (matcher)` に組んでいるので、画面ではそれを戻す ---- */

export function hookParts(name: string): { event: string; matcher: string } {
  const m = name.match(/^(\S+?)(?: \((.*)\))?$/);
  return m ? { event: m[1], matcher: m[2] || '' } : { event: name, matcher: '' };
}

/* 事実の帯のパス表示。cwd 配下なら相対にして短く(同名プロジェクトの区別は帯の出所チップが担う) */
export function shortPath(p: string, cwd: string): string {
  if (!p) return '';
  const base = cwd.replace(/[\\/]+$/, '');
  if (base && (p.startsWith(base + '/') || p.startsWith(base + '\\'))) {
    return p.slice(base.length + 1);
  }
  return p;
}

/*
 * skill 名を既知アイテムに解決する(委譲先・フロー図の calls 用)。
 * 同一プロジェクト → user / plugin / built-in の順で、他プロジェクトの同名は対象外
 * (そのセッションからは呼べないため)。`plugin:name` 形式は短い名前でも当てる。
 */
export function makeResolve<T extends SkillItem & { secId: string; source: string }>(
  it: T,
  all: T[],
): (name: string) => T | undefined {
  return (name: string) => {
    const short = name.replace(/^\//, '');
    const hit = (pred: (x: T) => boolean) =>
      all.find((x) => pred(x) && (x.name === short || x.name.split(':').pop() === short));
    return hit((x) => x.secId === it.secId) || hit((x) => x.source !== 'project');
  };
}
