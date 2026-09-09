/* API クライアント。型は server と共通の src/shared/types.ts が単一ソース */

import type { DiffResponse, SkillItem, SkillsData, SummaryJob } from '../../src/shared/types';
import { apiErrorMessage, getLang } from './i18n';
import { loadAiModel } from './settings';

export type {
  ChangeEntry,
  ClaudeMdScan,
  DiffResponse,
  FeedbackBodyPlan,
  ItemKind,
  Invocation,
  Lang,
  MemorySection,
  MemorySignal,
  MemoryState,
  MemoryTriage,
  MemoryType,
  MemoryVerdict,
  RelationType,
  SkillDiagnosis,
  SkillFlow,
  SkillFlowStep,
  SkillGroup,
  SkillRelation,
  SkillItem,
  SnapshotChanges,
  Source,
  Section,
  SkillsData,
  SummaryJob,
} from '../../src/shared/types';

let token = '';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json();
  if (!res.ok) throw new Error(apiErrorMessage(body, res.status));
  return body as T;
}

export async function initToken(): Promise<void> {
  token = (await req<{ token: string }>('/api/token')).token;
}

export const fetchSkills = () => req<SkillsData>('/api/skills?lang=' + getLang());
export const fetchFile = (src: string) =>
  req<{ content: string }>('/api/file?src=' + encodeURIComponent(src)).then((r) => r.content);
export const fetchSummaryStatus = () => req<SummaryJob>('/api/summary-status');
/*
 * 前版(HEAD)の内容。git 管理外・履歴なし・user scope は { available: false } で返り、
 * 理解画面はそのとき「前版との diff」ボタンを出さない(計画 15 C1 / E1)
 */
export const fetchDiff = (src: string) =>
  req<DiffResponse>('/api/diff?src=' + encodeURIComponent(src));

/*
 * mutation は表示言語と AI モデル設定も送る(言語は AI 生成・builtin 説明の解決、
 * モデルは要約/診断/グルーピングの claude 呼び出しに使われる。AI を使わない
 * エンドポイントではサーバー側で無視される)
 */
function mutate<T>(path: string, payload: Record<string, unknown>): Promise<T> {
  return req<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csb-token': token },
    body: JSON.stringify({ ...payload, lang: getLang(), model: loadAiModel() }),
  });
}

export const openSkill = (src: string) =>
  mutate<{ ok: true; editor: string }>('/api/open', { src });
export const summarizeSkill = (src: string, name: string) =>
  mutate<{ ok: true; summary: string }>('/api/summarize', { src, name });
export const summarizeAll = (force = false) => mutate<SummaryJob>('/api/summarize-all', { force });
/* 用途グループの生成/再生成(環境全体で 1 回の haiku 呼び出し。完了までブロック) */
export const generateGroups = () => mutate<{ ok: true }>('/api/group-generate', {});
/*
 * memory の棚卸し診断(project = MemorySection.id)。未診断の件だけをまとめて 1 回の
 * claude 呼び出しで診断する(files 指定で 1 件だけ / force で全件再診断)。
 * 結果はサーバー側の件単位キャッシュに載るので、呼び出し側は再取得して aiTriage を読む。
 */
export const triageMemory = (project: string, files?: string[], force = false) =>
  mutate<{ ok: true }>('/api/memory-triage', { project, files, force });
/* What's Changed の「既読にする」: 現在の状態を次回比較の基準として保存 */
export const ackChanges = () => mutate<{ ok: true }>('/api/changes-ack', {});
export const diagnoseSkill = (src: string, name: string) =>
  mutate<{ ok: true } & import('../../src/shared/types').SkillDiagnosis>('/api/diagnose', {
    src,
    name,
  });
export const flowSkill = (src: string, name: string) =>
  mutate<{ ok: true } & import('../../src/shared/types').SkillFlow>('/api/flow', { src, name });

/* ---- item key / URL id ---- */

/*
 * React key・URL id・検索に使う一意キー。hook は同一ファイル・同一イベント名で複数
 * 存在し得る(path#name が重複する)ため、コマンド文字列(description)まで含める。
 * 重複キーのままだとソート変更・グループ化切替の並べ替えで React が DOM を正しく
 * 再配置できず、表示順が壊れる。
 */
export const itemKey = (it: SkillItem) =>
  it.kind === 'hook' ? it.path + '#' + it.name + '#' + it.description : it.path + '#' + it.name;

export const toId = (key: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(key)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export const fromId = (id: string) => {
  try {
    const b64 = id.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return '';
  }
};
