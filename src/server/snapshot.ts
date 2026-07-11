/*
 * 前回起動時のアイテム一覧スナップショット(~/.cache/skills-viewer/snapshot.json)と
 * 現在のスキャン結果との diff(追加・更新・削除)。「前回から何が変わったか」の基盤。
 * - hook は同一 path・同一 name の複数定義があり識別子が安定しないため対象外
 * - built-in は実ファイルが無く description が表示言語依存のため対象外(path='' で除外される)
 * スナップショットの更新はユーザーの「既読」操作時のみ(差分バナーはリロードしても消えない)。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChangeEntry, ItemKind, Section, SnapshotChanges } from '../shared/types';
import { contentHash } from './summary';

interface SnapEntry {
  name: string;
  kind: ItemKind;
  hash: string | null;
}
/* key = アイテムの実ファイルパス(hook 以外は一意) */
export type Snapshot = Record<string, SnapEntry>;

const SNAPSHOT_FILE = path.join(os.homedir(), '.cache', 'skills-viewer', 'snapshot.json');

export function buildSnapshot(sections: Section[]): Snapshot {
  const snap: Snapshot = {};
  for (const s of sections) {
    for (const it of s.items) {
      if (it.kind === 'hook' || !it.path) continue;
      snap[it.path] = { name: it.name, kind: it.kind, hash: contentHash(it.path) };
    }
  }
  return snap;
}

function loadSnapshot(): Snapshot | null {
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveSnapshot(snap: Snapshot): void {
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snap, null, 1));
  } catch {
    /* キャッシュが書けなくても本体機能には影響させない */
  }
}

export function diffSnapshot(prev: Snapshot, cur: Snapshot): SnapshotChanges {
  const added: ChangeEntry[] = [];
  const updated: ChangeEntry[] = [];
  const removed: ChangeEntry[] = [];
  for (const [p, e] of Object.entries(cur)) {
    const old = prev[p];
    if (!old) added.push({ name: e.name, kind: e.kind, path: p });
    else if (old.hash !== e.hash) updated.push({ name: e.name, kind: e.kind, path: p });
  }
  for (const [p, e] of Object.entries(prev)) {
    if (!cur[p]) removed.push({ name: e.name, kind: e.kind, path: p });
  }
  return { added, updated, removed };
}

/*
 * 現在のスキャン結果と前回スナップショットの差分。
 * 初回(スナップショット無し)は全件が「追加」になってしまうため、基準だけ保存して null。
 */
export function computeChanges(sections: Section[]): SnapshotChanges | null {
  const cur = buildSnapshot(sections);
  const prev = loadSnapshot();
  if (!prev) {
    saveSnapshot(cur);
    return null;
  }
  const d = diffSnapshot(prev, cur);
  return d.added.length || d.updated.length || d.removed.length ? d : null;
}

/* 「既読にする」: 現在の状態を新しい基準として保存する */
export function ackChanges(sections: Section[]): void {
  saveSnapshot(buildSnapshot(sections));
}
