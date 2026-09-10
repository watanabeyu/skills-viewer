/*
 * HTTP サーバー: /api/* の JSON API + dist/ (SPA) の静的配信。
 * セキュリティ: 127.0.0.1 バインド + 起動ごとのトークン(/api/token で同一オリジンにのみ配布。
 * mutation 系はトークン必須。SOP により他オリジンのページはトークンを読めない)。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';

import type {
  ClaudeMdScan,
  DescriptionBudget,
  Lang,
  MemorySection,
  Section,
  SelectedProject,
  SessionContext,
  SkillsData,
  Worktree,
} from '../shared/types';
import { REGISTRY_FILE, listProjects, projectSectionId, scanSections } from './scan';
import { scanUsageByDir, scanMemoryUsage, encodeProjectPath, setMemoryRoots } from './usage';
import {
  publicMemory,
  realDir,
  repoRootsOf,
  resolveAutoMemoryDir,
  scanMemory,
  usageAvailableFor,
  worktreesForProjects,
} from './memory';
import {
  cleanupLegacyBackups,
  loadSummaries,
  contentHash,
  modelOf,
  summarizeOne,
  saveSummary,
  staleItems,
  startSummarizeAll,
  summaryStatus,
} from './summary';
import { assertAiReadableMd, assertReadableMd, openInEditor } from './read-access';
import { attachDiagnoses, diagnoseOne } from './diagnose';
import { attachFlows, flowOne } from './flow';
import { attachGroups, generateGroups } from './groups';
import { attachMemoryTriage, triageProject } from './memory-triage';
import { ackChanges, computeChanges } from './snapshot';
import type { ClaudeMdRef } from './snapshot';
import { claudeMdLayers, claudeMdRefsOf } from './claude-md';
import { previousContent } from './diff';
import { ApiError, toErrorBody } from './errors';
import { serverLang, srvMsg } from './locale';

/*
 * この起動限りの mutation トークン(/api/token で同一オリジンにだけ配る)。
 * export はテスト用(tests/handle-api.test.ts が handleApi を 1 往復させるのに要る)。
 * 値は起動ごとの乱数で、外に配る経路は /api/token のままなので許可の範囲は変わらない。
 */
export const TOKEN = crypto.randomBytes(16).toString('hex');

/*
 * claude CLI があるか(AI 機能の可否)。起動時に 1 回だけ `claude --version` を実行して覚える。
 * リクエストごとに spawn すると /api/skills が毎回 CLI 起動を待つことになるため。
 * 起動後に CLI を入れても、再起動するまでこの値は変わらない(既知の制約。UI にもそう書く)。
 * 実行は runClaude(summary.ts)と同じ流儀で shell を使わず argv 配列 + タイムアウト。
 * spawnSync なのは listen より前に確定させるため(最初の /api/skills が false を返す競合を避ける)。
 */
let aiAvailable = false;
let aiChecked = false;
function detectAi(): void {
  if (aiChecked) return;
  aiChecked = true;
  try {
    const r = spawnSync('claude', ['--version'], { stdio: 'ignore', timeout: 5000 });
    // 未インストール(ENOENT)は error 付きで status: null になるので status で判定する
    aiAvailable = r.status === 0;
  } catch {
    aiAvailable = false;
  }
}

const DIST = path.join(__dirname, '..', '..', 'dist');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

/*
 * 使用実績を「正しい定義」に帰属させる。
 * 呼び出し元プロジェクト(トランスクリプトのディレクトリ)を特定し、そのプロジェクトの
 * skill → user → plugin → built-in の解決優先順で1つの定義にだけ加算する。
 * 呼び出し元が未知(worktree・削除済みプロジェクト等)の場合は user 以降にフォールバック。
 * 戻り値はトランスクリプトが1件でも存在したか(false なら「未使用」判定は無意味)。
 */
function attributeUsage(sections: Section[]): boolean {
  const byDir = scanUsageByDir();
  const lookupBySec = new Map<string, Map<string, Section['items'][number]>>();
  for (const s of sections) {
    const m = new Map<string, Section['items'][number]>();
    for (const it of s.items) {
      m.set(it.name, it);
      const short = it.name.split(':').pop();
      if (short && !m.has(short)) m.set(short, it);
    }
    lookupBySec.set(s.id, m);
  }
  const dirToProjSec = new Map<string, Section>();
  for (const s of sections) {
    if (s.source === 'project') dirToProjSec.set(encodeProjectPath(s.note), s);
  }
  const globalOrder = ['user', 'plugin', 'builtin']
    .map((id) => sections.find((s) => s.id === id))
    .filter((s): s is Section => Boolean(s));

  // worktree(例: monorepo-feat-847-…)は親プロジェクトのエンコード名 + '-' で始まるので、
  // 完全一致しない場合は最長プレフィックス一致で親プロジェクトに帰属させる
  const resolveProjSec = (dirName: string): Section | null => {
    if (dirToProjSec.has(dirName)) return dirToProjSec.get(dirName)!;
    let best: Section | null = null,
      bestLen = 0;
    for (const [enc, sec] of dirToProjSec) {
      if (dirName.startsWith(enc + '-') && enc.length > bestLen) {
        best = sec;
        bestLen = enc.length;
      }
    }
    return best;
  };

  for (const [dirName, names] of Object.entries(byDir)) {
    const projSec = resolveProjSec(dirName);
    const order = projSec ? [projSec, ...globalOrder] : globalOrder;
    for (const [name, u] of Object.entries(names)) {
      let target: Section['items'][number] | undefined;
      for (const sec of order) {
        target = lookupBySec.get(sec.id)?.get(name);
        if (target) break;
      }
      if (!target) continue; // 既知の skill に該当しない(builtin CLI コマンド等)
      target.typedCount = (target.typedCount || 0) + u.typed;
      target.autoCount = (target.autoCount || 0) + u.auto;
      target.useCount = (target.useCount || 0) + u.typed + u.auto;
      target.lastUsed = Math.max(target.lastUsed || 0, u.last);
      if (u.daily) {
        const du = target.dailyUse || (target.dailyUse = {});
        for (const [day, n] of Object.entries(u.daily)) du[day] = (du[day] || 0) + n;
      }
    }
  }
  return Object.keys(byDir).length > 0;
}

/*
 * memory の Read(参照)/ Write・Edit(作成・更新)実績を付与する。
 * skill と違って帰属先の解決は不要で、Read の file_path がそのまま実ファイルを指す。
 * usageAvailable は「そのプロジェクトのトランスクリプトがあるか」= エンコード名で始まる
 * ディレクトリ(worktree 分を含む)に jsonl が 1 件以上あるか。false なら Read 列は出さない。
 * 判定そのもの(共有ストアの扱いを含む)は usageAvailableFor に集約している。
 */
function attributeMemoryUsage(memory: MemorySection[]): void {
  if (!memory.length) return;
  const { byPath, dirsWithTranscripts } = scanMemoryUsage();
  for (const sec of memory) {
    // autoMemoryDirectory の置き場は id が置き場のパス由来なので、transcript の
    // ディレクトリ名(現在のプロジェクトの slug)を別に持っている
    sec.usageAvailable = usageAvailableFor(sec, dirsWithTranscripts);
    for (const it of sec.items) {
      const u = byPath[it.path];
      if (!u) continue;
      if (u.reads > 0) {
        it.useCount = u.reads;
        it.lastUsed = u.lastRead;
        it.dailyUse = u.daily;
      }
      if (u.writes > 0) it.writeCount = u.writes;
    }
  }
}

/*
 * 実績付きの memory セクション一覧。/api/skills だけでなく /api/memory-triage からも
 * 同じ事実(Read / W-E / usageAvailable)をプロンプトに載せる必要があるので共通化する。
 */
/*
 * description の常時コストと、一覧の上限の目安。
 * Claude Code は skill の一覧(name + description)を文字数の予算で切る。予算はコンテキスト窓の 2%
 * (CHANGELOG 2.1.32「Skill character budget now scales with context window (2% of context)」)。
 * viewer は文字数でなくトークンの概算を持っているので、200k 窓 × 2% = 4,000 tok を目安にする
 * (ASCII ≈ 4 文字/tok で、旧来の固定 15,000 文字ともほぼ一致する)。計画 15 当時の「1% = 2,000」は
 * 古かった(2026-09-11 に CHANGELOG で確認)。窓の大きさは viewer から分からないので 200k 固定。
 * 実際に切られたかどうかは Claude Code の /doctor が答える(2.1.144)ので、画面は「見込み」と言う。
 */
const DESCRIPTION_BUDGET = 4000;

/*
 * そのセッションに注入される母集団。scanSections は登録済みの全プロジェクトを返すので、
 * 選んだプロジェクト以外の project セクションを外さないと、複数プロジェクトを登録した環境で
 * description の合計が数倍になり、予算超過の警告が常時出る。
 * 起動時サマリ(printStartupSummary)と同じ式を 1 か所に寄せる。
 *
 * 絞り込みは isCurrent(= cwd)ではなく選んだプロジェクトの id で見る(計画 16 判断 1):
 * 答えるのは「選んだプロジェクトで claude を起動したら何が注入されるか」で、cwd はその既定値。
 * 選んだプロジェクトの定義が 0 件なら Section 自体が無いので、project 段は空になる。
 */
export function sessionScope(sections: Section[], selectedId: string): Section[] {
  return sections.filter((s) => s.source !== 'project' || s.id === selectedId);
}

export function descriptionBudget(sections: Section[], selectedId: string): DescriptionBudget {
  let used = 0;
  for (const s of sessionScope(sections, selectedId))
    for (const it of s.items) used += it.tokens || 0;
  return { used, limit: DESCRIPTION_BUDGET, source: 'default' };
}

/*
 * 毎セッションの最初に読まれるものの内訳。viewer から見えないもの
 * (システムプロンプト・MCP・hook の出力)は含まない ── 画面にもそう明記する。
 */
export function sessionContext(
  sections: Section[],
  memory: MemorySection[],
  claudeMd: ClaudeMdScan,
  selectedId: string,
): SessionContext {
  let count = 0;
  let hiddenCount = 0;
  for (const s of sessionScope(sections, selectedId)) {
    for (const it of s.items) {
      if (it.kind === 'hook') continue;
      if (it.hidden) hiddenCount++;
      else count++;
    }
  }
  /*
   * 索引のコストは memory 側が上限(200 行 / 25KB)の外を除いて計算済みなので、それを足す。
   * 母集団は sessionScope と同じ「選んだプロジェクトだけ」── memory は選んだプロジェクトを
   * 起点に走査しているので、その isCurrent がそのまま選択と一致する。選んだプロジェクトに
   * memory が無ければ 0 行になり、画面はこの行を出さない。全プロジェクトを合算する
   * フォールバックは置かない(description は user だけに縮むのに索引だけ全件になり、
   * 3 つの内訳の母集団がずれる)。
   */
  const target = memory.filter((m) => m.isCurrent);
  return {
    claudeMd: { tok: claudeMd.tokens },
    memoryIndex: {
      tok: target.reduce((n, m) => n + m.indexTokens, 0),
      lines: target.reduce((n, m) => n + m.items.length, 0),
      limitLines: 200,
      limitBytes: 25 * 1024,
    },
    descriptions: {
      tok: descriptionBudget(sections, selectedId).used,
      count,
      hiddenCount,
      limit: DESCRIPTION_BUDGET,
    },
  };
}

function memorySections(cwd: string): MemorySection[] {
  primeMemoryRoots(cwd);
  const memory = scanMemory(cwd);
  attributeMemoryUsage(memory);
  return memory;
}

/*
 * この環境の自動メモリ置き場(autoMemoryDirectory)を usage 集計の許可ルートに設定する。
 * skill 集計と memory 集計は同じ transcript キャッシュを共有するので、走査を始める前に
 * 揃えておかないと同じファイルを二度読みすることになる(解決自体は memo 済みで安い)。
 */
function primeMemoryRoots(cwd: string): void {
  const auto = resolveAutoMemoryDir(cwd);
  if (!auto) {
    setMemoryRoots([]);
    return;
  }
  /*
   * 設定値そのものと、その実パス(異なるときだけ)の両方を許可ルートにする。
   * transcript の file_path が symlink 解決済みで記録される環境があり、設定値だけを
   * 前方一致に使うと、その置き場の Read / Write を丸ごと取り逃すため。
   */
  const real = realDir(auto.dir);
  setMemoryRoots(real !== auto.dir ? [auto.dir, real] : [auto.dir]);
}

/*
 * 登録簿と worktree 列挙の結果一式。3 つは必ず同じ 1 回の列挙から作る
 * (切替の候補・selected.mainPath・応答の worktrees・CLAUDE.md の追跡対象がずれないように)。
 */
interface ProjectSets {
  /* listProjects の結果 = ~/.claude.json の登録簿 + cwd(実在するディレクトリだけ) */
  projects: string[];
  /* projects の本体から列挙した linked worktree(id 付き。計画 16 Phase C) */
  worktrees: Worktree[];
  /* ?project=<id> の解決候補 = projects ∪ worktrees の path ∪ その本体(mainPath) */
  candidates: string[];
}

/*
 * 登録簿(~/.claude.json)の版。mtime(ns)とサイズが変わったらメモを捨てる。
 * 読めない環境(登録簿が無い)は 'none' ── その場合も候補は「cwd とその worktree」なので、
 * 下の worktree 側の版だけで組み直しの判断が付く。
 */
function registryStamp(): string {
  try {
    const st = fs.statSync(REGISTRY_FILE, { bigint: true });
    return `${st.mtimeNs}:${st.size}`;
  } catch {
    return 'none';
  }
}

/*
 * worktree 一覧の版。本体ごとの `<main>/.git/worktrees` は worktree の追加・削除で必ず
 * mtime が動く(エントリの作成・削除)ので、そのディレクトリの版を鍵に載せる。
 * `git worktree add` は ~/.claude.json を触らない(登録は claude をそこで起動したとき)ため、
 * 登録簿の版だけを鍵にすると新しい worktree が候補にも worktrees にも出てこない
 * ── README の「ページを再読み込みすれば再スキャン」と食い違うので、ここで拾う(レビュー 3 周目)。
 * statSync は本体の数ぶんだけ(µs 単位)。無ければ '-'(まだ worktree が 1 つも無い本体)。
 */
function worktreeStamp(mains: string[]): string {
  return mains
    .map((main) => {
      try {
        const st = fs.statSync(path.join(main, '.git', 'worktrees'), { bigint: true });
        return `${st.mtimeNs}`;
      } catch {
        return '-';
      }
    })
    .join(',');
}

/*
 * 候補一式のメモ(レビュー 2 周目)。resolveAutoMemoryDir の autoDirMemo と同じ流儀で、
 * 「登録簿と各本体の worktree 一覧が変わっていなければ組み直さない」。
 *
 * なぜ要るか: 組むのは listProjects × 2 + worktreesForProjects(本体ごとの readdir + 逆リンク検証)で、
 * 実環境(33 project / 73 worktree)では 6.3ms/req かかる。web は読み取り系にも常に
 * `data.selected.id` を付けるので、選択が cwd(既定)のままでも /api/file・/api/diff が毎回これを
 * 払っていた ── `.claude` 配下と分かれば 0.01ms で終わる判定の手前で 10ms 級の前段が乗る。
 *
 * 本体の集合(repoRootsOf)は登録簿の版に紐付けて覚える: 畳み込みは祖先方向の existsSync なので、
 * 版の判定のために毎回やり直さない。
 *
 * 限界: 登録済みディレクトリが消えたこと・新しいリポジトリが本体として現れたことは
 * ~/.claude.json が動くまで反映されない(列挙の起点が登録簿だから。起動し直せば必ず組み直す)。
 * 返す配列はメモと共有しているので、呼び出し側で書き換えないこと。
 */
let setsMemo: { regKey: string; mains: string[]; wtKey: string; sets: ProjectSets } | undefined;

function projectSets(cwd: string): ProjectSets {
  const regKey = path.resolve(cwd) + '\0' + registryStamp();
  if (setsMemo?.regKey === regKey && setsMemo.wtKey === worktreeStamp(setsMemo.mains))
    return setsMemo.sets;
  const projects = listProjects(cwd);
  const mains = repoRootsOf(projects);
  const worktrees: Worktree[] = worktreesForProjects(projects).map((w) => ({
    // id をサーバーが作るのは、web がパスから組み立てると規則が二重定義になるため(判断 2)
    id: projectSectionId(w.path),
    mainId: projectSectionId(w.mainPath),
    ...w,
  }));
  const sets: ProjectSets = {
    projects,
    worktrees,
    /*
     * 候補には worktree から逆引きした本体(mainPath)も入れる。本体は登録簿に無い・定義 0 件
     * のことがあり、そのとき「worktree は選べるのに本体は選べない」= 切替から本体の行が
     * 消える(その本体にぶら下がる worktree ごと辿れなくなる)ため。
     * 増えるのは列挙済み worktree の本体だけで、その worktree は既に候補にある
     * ── 母集団は「cwd と選んだプロジェクト」のままで、生のパスは相変わらず通らない。
     */
    candidates: [
      ...new Set([
        ...projects,
        ...worktrees.map((w) => w.path),
        ...worktrees.map((w) => w.mainPath),
      ]),
    ],
  };
  setsMemo = { regKey, mains, wtKey: worktreeStamp(mains), sets };
  return sets;
}

/*
 * 登録済みプロジェクトの本体から列挙した linked worktree(id 付き。計画 16 Phase C)。
 * 切替の候補・selected.mainPath・応答の worktrees が必ず同じ集合を見るよう 1 か所に置く。
 */
export function projectWorktrees(cwd: string): Worktree[] {
  return projectSets(cwd).worktrees;
}

/*
 * ?project=<id> の解決候補 = 登録済みプロジェクト(+ cwd)∪ そこから列挙した worktree
 * ∪ その worktree の本体(mainPath)。
 * worktree を足すのは、「claude を起動して登録された」かつ「.claude/ に 1 件以上ある」ものしか
 * 登録簿に出ないため ── 登録の有無に依らず選べるようにする(計画 16 判断 5・6)。
 * 本体を足すのも同じ理由で、本体側が登録簿に無い(worktree でしか claude を起動していない)
 * ときに「worktree は選べるのに本体は選べない」状態を作らないため。
 * 足すのは列挙した path だけで、生のパスは入らない。
 * 1 リクエストの中で何度呼んでも列挙は 1 回きり(projectSets のメモ)。
 */
export function projectCandidates(cwd: string): string[] {
  return projectSets(cwd).candidates;
}

/*
 * 応答の selected(この GET が文脈を計算した対象)。worktree を選んでいるときは本体のパスも
 * 返す: skill は worktree 自身の .claude、メモリは本体に収束する、という組み合わせの理由を
 * 画面が 1 行で言えるようにするため(計画 16 Phase C)。collect から切り出しているのはテストのため。
 */
export function selectedProject(
  cwd: string,
  selectedPath: string,
  worktrees: Worktree[],
): SelectedProject {
  const wt = worktrees.find((w) => w.path === selectedPath);
  return {
    id: projectSectionId(selectedPath),
    path: selectedPath,
    name: path.basename(selectedPath),
    isCwd: selectedPath === path.resolve(cwd),
    // 本体は id も返す: 定義 0 件・未登録だと Section が無く、web に本体を指す id が無いため
    ...(wt ? { mainPath: wt.mainPath, mainId: wt.mainId } : {}),
  };
}

/*
 * ?project=<id> → 文脈を計算するプロジェクトのパス。
 * 受け取るのは id だけで、生のパスは解釈しない(計画 16 判断 2): 候補を projectSectionId で
 * 突き合わせて一致したものだけを採り、'all'・未知の id・省略はすべて cwd に落とす。
 * こうしておけば「?project= に任意のパスを渡して読ませる」経路が生まれない。
 */
export function resolveSelectedProject(
  cwd: string,
  id: string | null,
  /* 呼び出し元が既に組んでいるなら渡す。省略時は「id があるときだけ」組む(登録簿を無駄に読まない) */
  candidates?: string[],
): string {
  const fallback = path.resolve(cwd);
  if (!id || id === 'all') return fallback;
  /*
   * 既定(cwd を選んでいる)なら候補を組まずに返す(レビュー 2 周目)。web は読み取り系にも
   * 常に data.selected.id を付けるので、選択が cwd のままでも /api/file・/api/diff が毎回
   * ここを通る ── 候補の組み立ては実環境で 6.3ms/req あり、`.claude` 配下と分かれば
   * 0.01ms で済む判定の手前でそれを払うことになる。cwd の id は必ず候補にあり、
   * 別の候補と衝突していれば下の分岐でも cwd に落ちるので、答えは変わらない。
   */
  if (id === projectSectionId(fallback)) return fallback;
  /*
   * projectSectionId は非可逆(英数字以外を '-' に潰す)なので、`~/w/foo.bar` と `~/w/foo-bar` は
   * 同じ id になる。どちらを指しているか決められない以上、勝手に片方を選ばない
   * ── 一致が 2 件以上なら未知の id と同じく cwd に落とす(読み取り許可の母集団に
   * 「利用者が選んだつもりのない方」が入るのを防ぐ)。
   */
  const hits = (candidates ?? projectCandidates(cwd)).filter((p) => projectSectionId(p) === id);
  return hits.length === 1 ? path.resolve(hits[0]) : fallback;
}

/*
 * 棚卸し(POST /api/memory-triage)の対象セクションと、その走査に使った起点(計画 16)。
 * 起点を選べるようにしたのは autoMemoryDirectory の置き場のため: そのセクションは置き場を
 * 設定したプロジェクトを起点に走査したときだけ現れるので、cwd 固定だと一覧(/api/skills は
 * 選んだプロジェクトで走査する)には出ているのに棚卸しだけ not-found になる。
 * ハンドラから切り出しているのはテストのため(HTTP を起こさずに id の解決を確かめる。
 * read-access.ts の assertOpenablePath と同じ理由)。
 */
export function triageTarget(
  cwd: string,
  selected: string | null,
  sectionId: string,
): { root: string; section: MemorySection | undefined } {
  const root = resolveSelectedProject(cwd, selected);
  return { root, section: memorySections(root).find((s) => s.id === sectionId) };
}

/*
 * ①(前回からの変化)の入力 3 点。collect と POST /api/changes-ack が同じものを見ることを
 * 1 か所で保証する ── 入力がずれると「既読にした」直後に同じ差分がまた出る。
 * 起点は選択に依らず cwd(計画 16 判断 8)、CLAUDE.md 群だけは候補(cwd ∪ 登録簿 ∪ worktree)
 * 全体を追う(Phase D 判断 9)。
 * sections / memory を渡せるのは、collect が既に持っているものを再スキャンしないため。
 */
export function changeInputs(
  cwd: string,
  lang: Lang,
  candidates: string[],
  pre: { sections?: Section[]; memory?: MemorySection[] } = {},
): { sections: Section[]; memory: MemorySection[]; claudeMd: ClaudeMdRef[] } {
  return {
    sections: pre.sections ?? scanSections(cwd, lang),
    memory: pre.memory ?? memorySections(cwd),
    claudeMd: claudeMdRefsOf(candidates),
  };
}

/*
 * projectId は ?project= の値(未指定は null)。ここで 1 回だけ解決するのは、選んだ
 * プロジェクトのパス = ② セッションの文脈を計算する対象 = 読み取り許可の母集団、だから
 * (計画 16 判断 1・4)。cwd はその既定値でしかないが、①(changes)と起動時サマリは
 * cwd 起点のまま(判断 8)。
 *
 * 登録簿・worktree の列挙・候補は projectSets から 1 組で受け取り、選択の解決・selectedProject・
 * CLAUDE.md の追跡対象・① の絞り込みに配り回す(レビュー 1 周目: 同じ集合を 3 か所が別々に
 * 組み直していた。2 周目でメモに載せ、リクエストをまたいでも登録簿が変わるまで組み直さない)。
 */
export function collect(cwd: string, lang: Lang, projectId: string | null): SkillsData {
  const { projects, worktrees, candidates } = projectSets(cwd);
  const selectedPath = resolveSelectedProject(cwd, projectId, candidates);
  const selected = selectedProject(cwd, selectedPath, worktrees);
  // 以降の絞り込みは「解決したパスの Section id」で見る(受け取った id をそのまま信じない)
  const selectedId = selected.id;
  const isCwd = selected.isCwd;
  primeMemoryRoots(selectedPath);
  /*
   * 走査対象は登録簿 ∪ 選んだプロジェクト(レビュー 2 周目)。未登録の worktree を選ぶと
   * ③ が必ず 0 件になっていた ── 候補には worktree 列挙が入るのに、走査は登録簿だけだった。
   */
  const sections = scanSections(cwd, lang, selectedPath);
  const usageAvailable = attributeUsage(sections);
  const summaries = loadSummaries();
  for (const sec of sections) {
    for (const it of sec.items) {
      const cached = summaries[it.path];
      if (
        cached &&
        cached.lang === lang && // 表示言語と違う要約は出さない(aiStale 側にカウントされる)
        it.path &&
        fs.existsSync(it.path) &&
        cached.hash === contentHash(it.path)
      ) {
        it.aiSummary = cached.summary;
        if (cached.invocation) {
          it.aiInvocation = cached.invocation;
          it.aiInvocationReason = cached.invocationReason || '';
        }
        // 生成後に照合ルールが厳格化されても、現在の refs に無い関係は表示しない
        const valid = (cached.relations || []).filter((r) => (it.refs || []).includes(r.name));
        if (valid.length) it.aiRelations = valid;
      }
    }
  }
  attachDiagnoses(sections, lang);
  attachFlows(sections, lang);
  const grp = attachGroups(sections, lang);
  const aiStale = staleItems(sections, lang).length;
  // memory は「呼び出す」ものではないので sections には混ぜず、別配列で同乗させる
  const memory = memorySections(selectedPath);
  // 共有ストア環境かどうかは選んだプロジェクトから解決した値で判定する(棚卸し側と同じ事実を見る)
  attachMemoryTriage(memory, lang, undefined, {
    sharedEnv: resolveAutoMemoryDir(selectedPath)?.scope === 'user',
  });
  const claudeMd = claudeMdLayers({ root: selectedPath });
  /*
   * ①(既読基準)は cwd 起点のまま(計画 16 判断 8)。選択に追随させると、別プロジェクトを
   * 選んだだけで cwd の CLAUDE.md が「削除」に化け、しかも「既読にする」(/api/changes-ack は
   * cwd 起点)を押しても消えない差分になる。cwd を選んでいる通常時は計算済みのものを使い回す。
   * 差分に要るのはパスと内容ハッシュだけなので、cwd 側は実績付与(memorySections)を通さない。
   *
   * CLAUDE.md の追跡対象は cwd の 7 段(claudeMdLayers)ではなく、登録済み全プロジェクト
   * (Phase D、判断 9)。projectCandidates(cwd) の各プロジェクトを claudeMdRefsOf に渡すだけなので、
   * 「選択が cwd と違うときに cwd の CLAUDE.md を計算し直す」処理(以前の cwdClaudeMd)は不要
   * ── 集合は最初から cwd 抜きに全プロジェクト分なので、選択が cwd かどうかに依らない。
   */
  const cwdMemory = isCwd ? memory : scanMemory(cwd);
  /*
   * ① の Section も cwd 起点に揃える: 選択で足した Section(登録簿に無い worktree を選んだとき
   * だけ現れる)は ack 側の走査(scanSections(cwd, lang) = 登録簿だけ)に出てこないので、
   * 入れたままだと「既読にしても消えない差分」になる。登録簿にあるものは選択に依らず走査される
   * ので、この filter が効くのは未登録の worktree を選んでいる間だけ。
   */
  const trackedSections = projects.includes(selectedPath)
    ? sections
    : sections.filter((s) => s.id !== selectedId);
  const chIn = changeInputs(cwd, lang, candidates, {
    sections: trackedSections,
    memory: cwdMemory,
  });
  return {
    generatedAt: new Date().toISOString(),
    cwd,
    selected,
    // 切替が本体の下へ寄せるための一覧。sections 自体は変えない(計画 16 判断 6)
    ...(worktrees.length ? { worktrees } : {}),
    sections,
    aiStale,
    aiAvailable,
    usageAvailable,
    claudeMd,
    budget: descriptionBudget(sections, selectedId),
    context: sessionContext(sections, memory, claudeMd, selectedId),
    changes: computeChanges(chIn.sections, chIn.memory, chIn.claudeMd),
    ...(grp.groups ? { groups: grp.groups } : {}),
    ...(grp.stale ? { groupsStale: true } : {}),
    ...(memory.length ? { memory: publicMemory(memory) } : {}),
  };
}

/* DNS rebinding 対策: same-origin GET には Origin が付かないため Host 側も検証する */
function hostOk(req: http.IncomingMessage): boolean {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  return host === '127.0.0.1' || host === 'localhost';
}

/* 同一オリジン以外からの API アクセスを拒否(Origin が付く場合のみ検証) */
function originOk(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin fetch / curl は Origin なし
  try {
    const h = new URL(origin).hostname;
    return h === '127.0.0.1' || h === 'localhost';
  } catch {
    return false;
  }
}

/* クライアント指定の表示言語(不明値は 'en' に落とす) */
function langOf(v: unknown): Lang {
  return v === 'ja' ? 'ja' : 'en';
}

/*
 * /api/* の 1 往復。export はテスト用(tests/handle-api.test.ts):
 * ハンドラの結線 ── どのパラメータをどの検証に渡しているか ── は関数単体のテストでは
 * 落ちないので、req / res の最小スタブで実際に通す(レビュー 2 周目の指摘)。
 */
export function handleApi(req: http.IncomingMessage, res: http.ServerResponse, cwd: string): void {
  const send = (code: number, obj: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  if (!hostOk(req) || !originOk(req)) return send(403, { error: 'bad-origin', detail: '' });

  const url = new URL(req.url || '/', 'http://localhost');

  if (req.method === 'GET') {
    try {
      if (url.pathname === '/api/token') return send(200, { token: TOKEN });
      if (url.pathname === '/api/skills')
        return send(
          200,
          collect(
            cwd,
            langOf(url.searchParams.get('lang')),
            // 読み取りパラメータなのでトークンは要らない(GET / mutation の二分はそのまま)
            url.searchParams.get('project'),
          ),
        );
      if (url.pathname === '/api/summary-status') return send(200, summaryStatus());
      /*
       * 読み取り系も「どのプロジェクトを選んでいるか」を受ける(?project=<id>)。
       * 許可の母集団が cwd と選んだプロジェクトの 2 つだからで、省略・未知は cwd に落ちる
       * ので従来(cwd 限定)と同じ挙動になる。生のパスは解釈しない(候補との一致だけ)。
       */
      if (url.pathname === '/api/file') {
        const selectedPath = resolveSelectedProject(cwd, url.searchParams.get('project'));
        const real = assertReadableMd(url.searchParams.get('src') || '', cwd, selectedPath);
        return send(200, { content: fs.readFileSync(real, 'utf8') });
      }
      // 前版(HEAD)の内容。削除済みファイルも対象なので assertReadableMd は通さない(diff.ts に専用の検証)
      if (url.pathname === '/api/diff')
        return send(
          200,
          previousContent(url.searchParams.get('src') || '', cwd, {
            selectedPath: resolveSelectedProject(cwd, url.searchParams.get('project')),
          }),
        );
      throw new ApiError('unknown-endpoint', url.pathname);
    } catch (e) {
      return send(
        e instanceof ApiError && e.code === 'unknown-endpoint' ? 404 : 400,
        toErrorBody(e),
      );
    }
  }

  // mutation 系はトークン必須
  if (req.headers['x-csb-token'] !== TOKEN) return send(403, { error: 'bad-token', detail: '' });
  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > 1e6) req.destroy();
  });
  req.on('end', () => {
    let data: any;
    try {
      data = JSON.parse(body || '{}');
    } catch {
      return send(400, { error: 'bad-json', detail: '' });
    }
    const lang = langOf(data.lang);
    const model = modelOf(data.model);
    /*
     * mutation の body の `selected` は ?project= と同じ Section.id(生のパスは解釈しない)。
     * 読み取り許可の母集団は cwd と選んだプロジェクトの 2 つなので、AI に本文を送る前・
     * エディタに渡す前の検証にも同じ解決結果を渡す。省略・未知は cwd に落ちる = 従来の挙動。
     */
    const selectedId = typeof data.selected === 'string' ? data.selected : null;
    const selectedPath = () => resolveSelectedProject(cwd, selectedId);
    try {
      if (url.pathname === '/api/diagnose') {
        const real = assertAiReadableMd(data.src, cwd, selectedPath());
        const name = data.name || path.basename(path.dirname(real));
        diagnoseOne(real, name, lang, model)
          .then((d) => send(200, { ok: true, ...d }))
          .catch((e) => send(400, toErrorBody(e)));
        return;
      }
      if (url.pathname === '/api/flow') {
        const real = assertAiReadableMd(data.src, cwd, selectedPath());
        const name = data.name || path.basename(path.dirname(real));
        flowOne(real, name, lang, model)
          .then((f) => send(200, { ok: true, ...f }))
          .catch((e) => send(400, toErrorBody(e)));
        return;
      }
      if (url.pathname === '/api/changes-ack') {
        /*
         * 既読にする基準は collect の changes と同じ入力(changeInputs)で作る。
         * 起点は cwd のまま ── ack の対象集合は cwd 起点なので、prime も選択に追随させない。
         */
        const inp = changeInputs(cwd, lang, projectCandidates(cwd));
        ackChanges(inp.sections, inp.memory, inp.claudeMd);
        return send(200, { ok: true });
      }
      if (url.pathname === '/api/open') return send(200, openInEditor(data, cwd, selectedPath()));
      if (url.pathname === '/api/summarize-all')
        /*
         * 母集団は collect と同じ「登録簿 ∪ 選んだプロジェクト」(レビュー 3 周目)。
         * cwd 固定だと、未登録の worktree を選んだときにその skill が ③・未要約件数
         * (aiStale)には出るのに要約ジョブに入らず、「未要約 N 件」が押しても減らない。
         */
        return send(
          200,
          startSummarizeAll(scanSections(cwd, lang, selectedPath()), !!data.force, lang, model),
        );
      if (url.pathname === '/api/group-generate') {
        /*
         * 環境全体で 1 回の claude 呼び出し。完了時にグループ集合を返す(割当は再取得で反映)。
         * ここは母集団が「環境全体」という設計なので選択を渡さない(グループは
         * プロジェクトをまたいで共有する分類で、選択で中身が変わると生成のたびに揺れる)。
         */
        generateGroups(scanSections(cwd, lang), lang, model)
          .then((r) => send(200, { ok: true, groups: r.groups }))
          .catch((e) => send(400, toErrorBody(e)));
        return;
      }
      if (url.pathname === '/api/memory-triage') {
        // 1 プロジェクト分をまとめて 1 回の claude 呼び出しで棚卸しする(結果は再取得で反映)
        const project = String(data.project || '');
        /*
         * memory を走査する起点(計画 16)。/api/skills の ?project= と同じ Section.id を
         * 受け、resolveSelectedProject に解決させる(候補との一致だけ。生のパスは解釈せず、
         * 省略・未知は cwd に落ちるので従来と同じ経路)。body の `project` は
         * MemorySection.id で埋まっている(意味が違う)ため、別のキーで受ける。
         * 起点が要るのは autoMemoryDirectory の置き場: そのセクションは置き場を設定した
         * プロジェクトを起点に走査したときだけ現れるので、cwd 固定のままだと画面には出るのに
         * 棚卸しだけ not-found になる。sharedEnv(共有ストア環境か)も同じパスで解決する。
         */
        const { root: selectedPath, section: sec } = triageTarget(
          cwd,
          typeof data.selected === 'string' ? data.selected : null,
          project,
        );
        if (!sec) throw new ApiError('not-found', project);
        const files = Array.isArray(data.files)
          ? data.files.filter((f: unknown): f is string => typeof f === 'string')
          : undefined;
        // sections は「CLAUDE.md / skill に既に書いてある」「skill へ昇格」を判定させる文脈。
        // AI を呼ぶときだけ要るので、フルスキャンは関数で渡して遅延させる。
        // 選択を渡さないのは、これが件数や予算ではなく「どこかに既にあるか」を見るための
        // 環境全体の文脈だから(未登録の worktree を選んでいても判定は変わらない)
        triageProject(sec, lang, model, {
          force: !!data.force,
          files,
          sections: () => scanSections(cwd, lang),
          // 置き場の解決は選んだプロジェクト基準。process.cwd() 任せにせず、走査に使ったのと
          // 同じパスで解決した値を渡す(一覧・読み取り許可と同じ事実を見る)
          autoMemory: resolveAutoMemoryDir(selectedPath),
        })
          .then((results) => send(200, { ok: true, results }))
          .catch((e) => send(400, toErrorBody(e)));
        return;
      }
      if (url.pathname === '/api/summarize') {
        const real = assertAiReadableMd(data.src, cwd, selectedPath());
        // refs(関係候補)はスキャン結果から復元する
        const sections = scanSections(cwd, lang);
        const item = sections.flatMap((s) => s.items).find((x) => x.path === real);
        const name = data.name || item?.name || path.basename(path.dirname(real));
        summarizeOne({ path: real, name, refs: item?.refs || [] }, lang, model)
          .then((analysis) => {
            saveSummary(real, name, analysis, lang, model);
            send(200, { ok: true, ...analysis });
          })
          .catch((e) => send(400, toErrorBody(e)));
        return;
      }
      throw new ApiError('unknown-endpoint', url.pathname);
    } catch (e) {
      return send(
        e instanceof ApiError && e.code === 'unknown-endpoint' ? 404 : 400,
        toErrorBody(e),
      );
    }
  });
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url || '/', 'http://localhost');
  let fp = path.join(DIST, path.normalize(url.pathname));
  if (!fp.startsWith(DIST)) {
    res.writeHead(403);
    return void res.end();
  }
  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    fp = path.join(DIST, 'index.html'); // SPA fallback (/skills/xxx など)
  }
  if (!fs.existsSync(fp)) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    // 開発者向けメッセージなので英語固定
    return void res.end('dist/ not found. Run `pnpm build` first.');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  res.end(fs.readFileSync(fp));
}

/*
 * 起動時の1〜2行サマリー(--no-open 運用でも価値が出るように)。
 * 前回からの差分 + セッション注入トークン概算 + 直近未使用の件数。失敗しても起動は止めない。
 */
function printStartupSummary(cwd: string): void {
  try {
    // 起動時サマリは cwd の文脈(計画 16 判断 8)。CLI に選択という概念は無いので id は渡さない
    const data = collect(cwd, serverLang, null);
    const ch = data.changes;
    if (ch) {
      console.log(
        srvMsg(
          `前回から: 追加 ${ch.added.length} / 更新 ${ch.updated.length} / 削除 ${ch.removed.length}`,
          `Since last run: ${ch.added.length} added / ${ch.updated.length} updated / ${ch.removed.length} removed`,
        ),
      );
    }
    // 画面の「セッションの文脈」と同じ数字を出す(式を再現せず、計算済みの値を使う)
    const sessionTokens = data.budget.used;
    const unused = data.usageAvailable
      ? data.sections.flatMap((s) => s.items).filter((it) => it.kind !== 'hook' && !it.useCount)
          .length
      : null;
    console.log(
      srvMsg(
        `スキル定義のセッション注入 ≈${sessionTokens.toLocaleString()}tok` +
          (unused !== null ? ` / 直近未使用 ${unused} 件` : ''),
        `Skill definitions inject ≈${sessionTokens.toLocaleString()} tok/session` +
          (unused !== null ? ` / ${unused} with no recent use` : ''),
      ),
    );
  } catch {
    /* サマリーは補助情報。失敗しても起動を妨げない */
  }
}

export interface StartOptions {
  port?: number;
  open?: boolean;
  cwd?: string;
}

export function start(
  { port = 4763, open = true, cwd = process.cwd() }: StartOptions = {},
  attempt = 0,
): void {
  detectAi();
  const server = http.createServer((req, res) => {
    if ((req.url || '').startsWith('/api/')) return handleApi(req, res, cwd);
    serveStatic(req, res);
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && attempt < 10) {
      start({ port: port + 1, open, cwd }, attempt + 1);
    } else {
      console.error(err.message);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`skills-viewer: ${url}  (cwd: ${cwd})`);
    // v0.8 のインライン編集が残した控え。黙って消さず、消したことを 1 行出す
    if (cleanupLegacyBackups())
      console.log(
        srvMsg(
          'v0.8 の編集機能が作ったバックアップ(~/.cache/skills-viewer/backups)を削除しました。',
          'Removed the backups left by the v0.8 editor (~/.cache/skills-viewer/backups).',
        ),
      );
    printStartupSummary(cwd);
    console.log(
      srvMsg(
        'Ctrl+C で終了。ページ再読み込みで再スキャンされます。',
        'Press Ctrl+C to quit. Reloading the page rescans.',
      ),
    );
    if (open && process.platform === 'darwin') execFile('open', [url], () => {});
    if (open && process.platform === 'win32') execFile('cmd', ['/c', 'start', url], () => {});
    if (open && process.platform === 'linux') execFile('xdg-open', [url], () => {});
  });
}
