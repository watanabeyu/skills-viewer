/* API クライアント。型は server と共通の src/shared/types.ts が単一ソース */

import type { SkillItem, SkillsData, SummaryJob } from '../../src/shared/types';
import { apiErrorMessage, getLang } from './i18n';

export type {
  ChangeEntry,
  ItemKind,
  Invocation,
  Lang,
  RelationType,
  SkillRelation,
  SkillItem,
  SnapshotChanges,
  Source,
  Section,
  CopyTarget,
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

/* mutation は表示言語も送る(AI 要約の生成言語・builtin 説明の解決に使われる) */
function mutate<T>(path: string, payload: Record<string, unknown>): Promise<T> {
  return req<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csb-token': token },
    body: JSON.stringify({ ...payload, lang: getLang() }),
  });
}

export const copySkill = (src: string, target: string) =>
  mutate<{ ok: true; dest: string; destMd: string; destName: string }>('/api/copy', {
    src,
    target,
  });
export const deleteSkill = (src: string) =>
  mutate<{ ok: true; trashedTo: string }>('/api/delete', { src });
export const openSkill = (src: string) =>
  mutate<{ ok: true; editor: string }>('/api/open', { src });
export const summarizeSkill = (src: string, name: string) =>
  mutate<{ ok: true; summary: string }>('/api/summarize', { src, name });
export const summarizeAll = (force = false) => mutate<SummaryJob>('/api/summarize-all', { force });
/* What's Changed の「既読にする」: 現在の状態を次回比較の基準として保存 */
export const ackChanges = () => mutate<{ ok: true }>('/api/changes-ack', {});

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
