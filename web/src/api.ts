/* API クライアント。型は server と共通の src/shared/types.ts が単一ソース */

import type { SkillItem, SkillsData, SummaryJob } from '../../src/shared/types';

export type {
  ItemKind,
  Invocation,
  RelationType,
  SkillRelation,
  SkillItem,
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
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body as T;
}

export async function initToken(): Promise<void> {
  token = (await req<{ token: string }>('/api/token')).token;
}

export const fetchSkills = () => req<SkillsData>('/api/skills');
export const fetchFile = (src: string) =>
  req<{ content: string }>('/api/file?src=' + encodeURIComponent(src)).then((r) => r.content);
export const fetchSummaryStatus = () => req<SummaryJob>('/api/summary-status');

function mutate<T>(path: string, payload: unknown): Promise<T> {
  return req<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csb-token': token },
    body: JSON.stringify(payload),
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

/* ---- item key / URL id ---- */

export const itemKey = (it: SkillItem) => it.path + '#' + it.name;

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
