/*
 * 前回起動時のアイテム一覧スナップショット(~/.cache/skills-viewer/snapshot.json)と
 * 現在のスキャン結果との diff(追加・更新・削除)。「前回から何が変わったか」の基盤。
 * 追跡するのは skill / command / agent の実ファイル、memory の本文、CLAUDE.md 群。
 * - hook は同一 path・同一 name の複数定義があり識別子が安定しないため対象外
 * - built-in は実ファイルが無く description が表示言語依存のため対象外(path='' で除外される)
 * - MEMORY.md(索引)は scanMemory の時点で items から除かれている
 * スナップショットの更新はユーザーの「既読」操作時のみ(差分バナーはリロードしても消えない)。
 *
 * 変化した項目のうち project 出所のものには git の直近コミット(誰が・いつ)を付ける。
 * 「pull したら何が増えて、誰がいつ入れたのか」が受け取る人の入口だから。
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  ChangeEntry,
  ItemKind,
  MemorySection,
  Section,
  SnapshotChanges,
  Source,
} from '../shared/types';
import { isUnder, worktreeRootOf } from './memory';
import { userClaudeDir } from './claude-md';
import { contentHash } from './summary';

interface SnapEntry {
  name: string;
  kind: ItemKind;
  /* 出所。git 履歴を引く対象(project)を決めるのに使う */
  source: Source;
  hash: string | null;
}
/* key = `${kind}:${実ファイルパス}`(kind を前置するのは種類をまたいで同じパスが来ても分けるため) */
export type Snapshot = Record<string, SnapEntry>;

/*
 * ファイル形式。v1 はキーがフラットな実パスで source を持たないため、
 * 読み込み側は v !== 2 を「基準なし」に落とす(既存ユーザーは 1 回だけ差分が出ない)。
 */
const SNAPSHOT_VERSION = 2;
interface SnapshotFile {
  v: number;
  entries: Snapshot;
  /*
   * この基準を保存した時刻(ISO 8601)。ホーム ①(増えた・変わった)の
   * 「いつ既読にしてから」の起点として web に返す。v2 で足したので、
   * v2 のまま欠けている(この追加より前に保存された)ファイルもあり得る。
   */
  ackedAt?: string;
}

const SNAPSHOT_FILE = path.join(os.homedir(), '.cache', 'skills-viewer', 'snapshot.json');

/*
 * CLAUDE.md 群の受け口。走査そのものは Phase C2(src/server/claude-md.ts)の仕事なので、
 * ここでは「どのパスを追跡対象にするか」だけを受け取る。exists が false の階層はキーを作らない
 * (無い CLAUDE.md を「削除された」と数えないため)。
 */
export interface ClaudeMdRef {
  path: string;
  exists: boolean;
  /* 表示名。省略時はファイル名(CLAUDE.md / CLAUDE.local.md) */
  name?: string;
  /* 出所。省略時は ~/.claude 配下なら user、それ以外は project */
  source?: Source;
}

const key = (kind: ItemKind, fp: string) => `${kind}:${fp}`;

/* memory の出所: 共有ストア(user scope の autoMemoryDirectory)だけ user、他はプロジェクトのもの */
const memorySource = (sec: MemorySection): Source => (sec.sharedStore ? 'user' : 'project');

/* 出所の判定は isUnder に揃える(ケース非依存 FS で case-fold する。v0.8.1 の判断) */
const claudeMdSource = (fp: string): Source => (isUnder(fp, userClaudeDir()) ? 'user' : 'project');

export function buildSnapshot(
  sections: Section[],
  memory: MemorySection[] = [],
  claudeMd: ClaudeMdRef[] = [],
): Snapshot {
  const snap: Snapshot = {};
  for (const s of sections) {
    for (const it of s.items) {
      if (it.kind === 'hook' || !it.path) continue;
      snap[key(it.kind, it.path)] = {
        name: it.name,
        kind: it.kind,
        source: s.source,
        hash: contentHash(it.path),
      };
    }
  }
  for (const sec of memory) {
    for (const it of sec.items) {
      if (!it.path) continue;
      snap[key('memory', it.path)] = {
        name: it.name,
        kind: 'memory',
        source: memorySource(sec),
        hash: contentHash(it.path),
      };
    }
  }
  for (const c of claudeMd) {
    if (!c.exists || !c.path) continue;
    snap[key('claude-md', c.path)] = {
      name: c.name || path.basename(c.path),
      kind: 'claude-md',
      source: c.source || claudeMdSource(c.path),
      hash: contentHash(c.path),
    };
  }
  return snap;
}

/* file はテスト注入用(実環境の ~/.cache を書き換えずに検証するため) */
function loadSnapshot(file: string): { entries: Snapshot; ackedAt?: string } | null {
  try {
    const parsed: SnapshotFile = JSON.parse(fs.readFileSync(file, 'utf8'));
    // v1(フラットなパスキー・source 無し)は比較できないので基準なしに落とす
    if (!parsed || parsed.v !== SNAPSHOT_VERSION || !parsed.entries) return null;
    return { entries: parsed.entries, ...(parsed.ackedAt ? { ackedAt: parsed.ackedAt } : {}) };
  } catch {
    return null;
  }
}

function saveSnapshot(snap: Snapshot, file: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const out: SnapshotFile = {
      v: SNAPSHOT_VERSION,
      entries: snap,
      ackedAt: new Date().toISOString(),
    };
    fs.writeFileSync(file, JSON.stringify(out, null, 1));
  } catch {
    /* キャッシュが書けなくても本体機能には影響させない */
  }
}

const entryOf = (e: SnapEntry, k: string): ChangeEntry => ({
  name: e.name,
  kind: e.kind,
  // key は `${kind}:${path}` なので最初の : までを落とす(パスに : が含まれても壊れない)
  path: k.slice(k.indexOf(':') + 1),
  source: e.source,
});

export function diffSnapshot(prev: Snapshot, cur: Snapshot): SnapshotChanges {
  const added: ChangeEntry[] = [];
  const updated: ChangeEntry[] = [];
  const removed: ChangeEntry[] = [];
  for (const [k, e] of Object.entries(cur)) {
    const old = prev[k];
    if (!old) added.push(entryOf(e, k));
    else if (old.hash !== e.hash) updated.push(entryOf(e, k));
  }
  for (const [k, e] of Object.entries(prev)) {
    if (!cur[k]) removed.push(entryOf(e, k));
  }
  return { added, updated, removed };
}

/*
 * 変化した項目の「誰が・いつ」。root はファイル自身の位置から求める(server の cwd に依存しない。
 * autoMemoryDirectory がプロジェクト内を指す場合など、置き場とプロジェクトが一致しない形があるため)。
 * repoRootOf ではなく worktreeRootOf を使う: linked worktree の中のファイルは、その
 * ワークツリー側の履歴を見たい(メインワークツリーを root にすると相対パスが外へ出てしまう)。
 * 非 git・リポジトリ外・履歴なし・git 失敗はすべて「付けない」に倒す(差分表示を止めない)。
 */
/*
 * worktreeRootOf は existsSync でディレクトリを遡るので、同じディレクトリの項目が並ぶ差分では
 * 何度も同じ探索を繰り返す。1 回の差分計算の中でメモ化する。
 */
const rootMemo = new Map<string, string | null>();
function rootOfDir(dir: string): string | null {
  const hit = rootMemo.get(dir);
  if (hit !== undefined) return hit;
  const root = worktreeRootOf(dir);
  rootMemo.set(dir, root);
  return root;
}

function gitAuthor(fp: string): { author: string; authoredAt: string } | null {
  const root = rootOfDir(path.dirname(fp));
  if (!root) return null;
  const rel = path.relative(root, fp);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try {
    const out = execFileSync(
      'git',
      ['-C', root, 'log', '-1', '--format=%an%x09%aI', '--', rel.split(path.sep).join('/')],
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (!out) return null; // 未コミット(追加されたばかり)のファイル
    const [author, authoredAt] = out.split('\t');
    if (!author || !authoredAt) return null;
    return { author, authoredAt };
  } catch {
    return null; // git が無い / リポジトリが壊れている / タイムアウト
  }
}

/*
 * git 履歴を引く上限。1 件 20ms 前後の同期実行(execFileSync)なので、件数が増えると
 * GET /api/skills がその分ブロックする。差分は既読にするまで消えないため、大きな pull の直後は
 * リロードごとに同じコストが乗る ── そこが一番速くあってほしい場面なので上限を置く。
 * 超えた分は author を付けない(README 6.3 の「無ければ更新日だけ」に自然に縮退する)。
 */
const GIT_AUTHOR_MAX = 40;
/* 全体の時間上限。巨大リポジトリやネットワーク FS で 1 件が遅いときに待受を止めないため */
const GIT_AUTHOR_BUDGET_MS = 600;

/*
 * project 出所の変化項目にだけ git 履歴を付ける(user / plugin / built-in は共有の履歴を持たない)。
 * removed を先に回す: 消えたファイルは mtime が残っておらず、git が唯一の情報源なので、
 * 上限に当たったときに真っ先に落ちるのが一番惜しい。
 */
function attachGitAuthors(changes: SnapshotChanges): void {
  rootMemo.clear();
  const started = Date.now();
  let calls = 0;
  for (const list of [changes.removed, changes.added, changes.updated]) {
    for (const e of list) {
      if (e.source !== 'project') continue;
      if (calls >= GIT_AUTHOR_MAX || Date.now() - started > GIT_AUTHOR_BUDGET_MS) return;
      calls++;
      const info = gitAuthor(e.path);
      if (!info) continue;
      e.author = info.author;
      e.authoredAt = info.authoredAt;
    }
  }
}

/*
 * 現在のスキャン結果と前回スナップショットの差分。
 * 初回(スナップショット無し・旧形式)は全件が「追加」になってしまうため、基準だけ保存して null。
 */
export function computeChanges(
  sections: Section[],
  memory: MemorySection[] = [],
  claudeMd: ClaudeMdRef[] = [],
  file: string = SNAPSHOT_FILE,
): SnapshotChanges | null {
  const cur = buildSnapshot(sections, memory, claudeMd);
  const prev = loadSnapshot(file);
  if (!prev) {
    saveSnapshot(cur, file);
    return null;
  }
  const d = diffSnapshot(prev.entries, cur);
  if (!d.added.length && !d.updated.length && !d.removed.length) return null;
  attachGitAuthors(d);
  // 「いつ既読にしてから」の起点。この追加より前に保存された基準には無いので省略する
  return prev.ackedAt ? { ...d, since: prev.ackedAt } : d;
}

/* 「既読にする」: 現在の状態を新しい基準として保存する */
export function ackChanges(
  sections: Section[],
  memory: MemorySection[] = [],
  claudeMd: ClaudeMdRef[] = [],
  file: string = SNAPSHOT_FILE,
): void {
  saveSnapshot(buildSnapshot(sections, memory, claudeMd), file);
}
