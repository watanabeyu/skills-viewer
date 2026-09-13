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

import { execFile, execFileSync } from 'node:child_process';
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

type AuthorInfo = { author: string; authoredAt: string } | null;

function gitAuthor(fp: string): AuthorInfo {
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
// export はテスト用(件数上限を固定するテストが値をハードコードしないため)。値は変えていない
export const GIT_AUTHOR_MAX = 40;
/* 全体の時間上限。巨大リポジトリやネットワーク FS で 1 件が遅いときに待受を止めないため */
const GIT_AUTHOR_BUDGET_MS = 600;

/*
 * project 出所の変化項目にだけ git 履歴を付ける(user / plugin / built-in は共有の履歴を持たない)。
 * removed を先に回す: 消えたファイルは mtime が残っておらず、git が唯一の情報源なので、
 * 上限に当たったときに真っ先に落ちるのが一番惜しい。
 */
/* gitAuthor の非同期版(起動時の先読み用)。argv・timeout・失敗時の扱いは同期版と同じ */
function gitAuthorAsync(fp: string): Promise<AuthorInfo> {
  const root = rootOfDir(path.dirname(fp));
  if (!root) return Promise.resolve(null);
  const rel = path.relative(root, fp);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', root, 'log', '-1', '--format=%an%x09%aI', '--', rel.split(path.sep).join('/')],
      { encoding: 'utf8', timeout: 3000 },
      (err, out) => {
        if (err) return resolve(null);
        const [author, authoredAt] = String(out).trim().split('\t');
        resolve(author && authoredAt ? { author, authoredAt } : null);
      },
    );
  });
}

/*
 * 起動時の先読み: 待受を止めずに、未読の変化項目の「誰が・いつ」を控えに入れておく。
 * ブラウザが開いて最初の /api/skills が来る頃には埋まっているので、最初の応答が git を待たない
 * (来る前に届いた分は同期側が上限の中で引く)。同時実行 4、件数は上限つき
 */
const PREWARM_MAX = 400;
const PREWARM_CONCURRENCY = 4;
/*
 * 先読み中は同期側が git を起動しない(控えの分だけ付ける)。起動直後の 1 秒に来た要求が
 * 先読みと同じファイルを二重に引いて、両方とも遅くなるのを避ける。その要求には author の
 * 無い項目が混じるが、次の再読み込みで揃う(先読みは 100 件で 0.5 秒程度)
 */
let prewarming = false;
export function prewarmGitAuthors(
  changes: SnapshotChanges,
  hashOf: (e: ChangeEntry) => string,
): Promise<void> {
  const todo = [...changes.removed, ...changes.added, ...changes.updated]
    .filter((e) => e.source === 'project')
    .filter((e) => !authorMemo.has(`${e.path}\0${hashOf(e)}`))
    .slice(0, PREWARM_MAX);
  let i = 0;
  prewarming = true;
  const worker = async (): Promise<void> => {
    for (;;) {
      const e = todo[i++];
      if (!e) return;
      const memoKey = `${e.path}\0${hashOf(e)}`;
      const info = await gitAuthorAsync(e.path);
      if (authorMemo.size >= AUTHOR_MEMO_MAX) authorMemo.clear();
      authorMemo.set(memoKey, { info, at: Date.now() });
    }
  };
  return Promise.all(Array.from({ length: PREWARM_CONCURRENCY }, worker)).then(() => {
    prewarming = false;
  });
}

/*
 * 引いた「誰が・いつ」の控え。鍵は path + 内容 hash なので、内容が変われば引き直し、変わらなければ
 * git を呼ばない。差分は既読にするまで消えないので、これが無いと **リクエストごとに** 上限まで git が
 * 走る(v0.9.0 のリリース判定で実測: 未読 98 件の環境で 1 リクエストあたり git 25 回・700 ms。
 * 16 で CLAUDE.md の追跡を全プロジェクトに広げて件数が増えた)。既読(ackChanges)で捨てる。
 * null(未コミット・非 git)は短命にする: コミットした直後に author が出ないまま固まらないように
 */
const authorMemo = new Map<string, { info: AuthorInfo; at: number }>();
const AUTHOR_MEMO_MAX = 4000;
const AUTHOR_NULL_TTL_MS = 60_000;

/* export はテスト用(メモが test をまたいで残らないように) */
export function clearGitAuthorMemo(): void {
  authorMemo.clear();
}

// export はテスト用(git を実プロセスとして起動するので execFileSync をモックして検証する)
export function attachGitAuthors(
  changes: SnapshotChanges,
  /* 項目の内容 hash(メモの鍵)。省略時は path だけで控える */
  hashOf: (e: ChangeEntry) => string = () => '',
): void {
  rootMemo.clear();
  const started = Date.now();
  let calls = 0;
  let exhausted = prewarming;
  for (const list of [changes.removed, changes.added, changes.updated]) {
    for (const e of list) {
      if (e.source !== 'project') continue;
      const memoKey = `${e.path}\0${hashOf(e)}`;
      const hit = authorMemo.get(memoKey);
      let info: AuthorInfo | undefined =
        hit && (hit.info || Date.now() - hit.at < AUTHOR_NULL_TTL_MS) ? hit.info : undefined;
      if (info === undefined) {
        // 上限に当たっても控えのある項目には付け続ける(return で打ち切らない)
        if (exhausted) continue;
        if (calls >= GIT_AUTHOR_MAX || Date.now() - started > GIT_AUTHOR_BUDGET_MS) {
          exhausted = true;
          continue;
        }
        calls++;
        info = gitAuthor(e.path);
        if (authorMemo.size >= AUTHOR_MEMO_MAX) authorMemo.clear();
        authorMemo.set(memoKey, { info, at: Date.now() });
      }
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
  /*
   * 誰が・いつの付け方。sync = この場で引く(応答に載せる)。prewarm = 付けずに先読みだけ始める
   * (起動時サマリ用。件数しか出さないので待つ理由が無く、待受前に git を回すと起動が遅れる)
   */
  authors: 'sync' | 'prewarm' = 'sync',
): SnapshotChanges | null {
  const cur = buildSnapshot(sections, memory, claudeMd);
  const prev = loadSnapshot(file);
  if (!prev) {
    saveSnapshot(cur, file);
    return null;
  }
  const d = diffSnapshot(prev.entries, cur);
  if (!d.added.length && !d.updated.length && !d.removed.length) return null;
  // メモの鍵は現在の hash(消えた項目は前回の hash)。内容が同じ限り git は 1 回しか走らない
  const hashOf = (e: ChangeEntry): string =>
    (cur[key(e.kind, e.path)] ?? prev.entries[key(e.kind, e.path)])?.hash ?? '';
  if (authors === 'prewarm') void prewarmGitAuthors(d, hashOf);
  else attachGitAuthors(d, hashOf);
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
  // 既読で差分が消えるので控えも要らない(次に差分が出るのは内容が変わったとき = 鍵も変わる)
  authorMemo.clear();
}
