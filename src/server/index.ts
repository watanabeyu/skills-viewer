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
  SessionContext,
  SkillsData,
} from '../shared/types';
import { listProjects, projectSectionId, scanSections } from './scan';
import { scanUsageByDir, scanMemoryUsage, encodeProjectPath, setMemoryRoots } from './usage';
import {
  publicMemory,
  realDir,
  resolveAutoMemoryDir,
  scanMemory,
  usageAvailableFor,
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
import { claudeMdLayers, claudeMdRefs } from './claude-md';
import { previousContent } from './diff';
import { ApiError, toErrorBody } from './errors';
import { serverLang, srvMsg } from './locale';

const TOKEN = crypto.randomBytes(16).toString('hex');

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
 * description の常時コストと予算。公式は「コンテキスト窓の 1%」で、200k 窓なら 2,000。
 * settings.json に相当するキーは無い(2026-09-08 確認)ので既定固定にし、
 * 公式にキーが現れたら source を分けて差し替える。
 */
const DESCRIPTION_BUDGET = 2000;

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
 * ?project=<id> の解決候補。今は登録済みプロジェクト(+ cwd)そのままだが、
 * 計画 16 Phase C で worktree を足すので、候補を組み立てる場所を 1 か所にしておく。
 */
export function projectCandidates(cwd: string): string[] {
  return listProjects(cwd);
}

/*
 * ?project=<id> → 文脈を計算するプロジェクトのパス。
 * 受け取るのは id だけで、生のパスは解釈しない(計画 16 判断 2): 候補を projectSectionId で
 * 突き合わせて一致したものだけを採り、'all'・未知の id・省略はすべて cwd に落とす。
 * こうしておけば「?project= に任意のパスを渡して読ませる」経路が生まれない。
 */
export function resolveSelectedProject(cwd: string, id: string | null): string {
  const fallback = path.resolve(cwd);
  if (!id || id === 'all') return fallback;
  for (const p of projectCandidates(cwd)) if (projectSectionId(p) === id) return path.resolve(p);
  return fallback;
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
 * selectedPath は「選んだプロジェクト」= ② セッションの文脈を計算する対象(計画 16 判断 1)。
 * cwd はその既定値でしかないが、①(changes)と起動時サマリは cwd 起点のまま(判断 8)。
 */
function collect(cwd: string, lang: Lang, selectedPath: string): SkillsData {
  const selectedId = projectSectionId(selectedPath);
  const isCwd = selectedPath === path.resolve(cwd);
  primeMemoryRoots(selectedPath);
  const sections = scanSections(cwd, lang);
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
   */
  const cwdMemory = isCwd ? memory : scanMemory(cwd);
  const cwdClaudeMd = isCwd ? claudeMd : claudeMdLayers({ root: cwd });
  return {
    generatedAt: new Date().toISOString(),
    cwd,
    selected: {
      id: selectedId,
      path: selectedPath,
      name: path.basename(selectedPath),
      isCwd,
    },
    sections,
    aiStale,
    aiAvailable,
    usageAvailable,
    claudeMd,
    budget: descriptionBudget(sections, selectedId),
    context: sessionContext(sections, memory, claudeMd, selectedId),
    changes: computeChanges(sections, cwdMemory, claudeMdRefs(cwdClaudeMd)),
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

function handleApi(req: http.IncomingMessage, res: http.ServerResponse, cwd: string): void {
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
            resolveSelectedProject(cwd, url.searchParams.get('project')),
          ),
        );
      if (url.pathname === '/api/summary-status') return send(200, summaryStatus());
      if (url.pathname === '/api/file') {
        const real = assertReadableMd(url.searchParams.get('src') || '', cwd);
        return send(200, { content: fs.readFileSync(real, 'utf8') });
      }
      // 前版(HEAD)の内容。削除済みファイルも対象なので assertReadableMd は通さない(diff.ts に専用の検証)
      if (url.pathname === '/api/diff')
        return send(200, previousContent(url.searchParams.get('src') || '', cwd));
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
    try {
      if (url.pathname === '/api/diagnose') {
        const real = assertAiReadableMd(data.src, cwd);
        const name = data.name || path.basename(path.dirname(real));
        diagnoseOne(real, name, lang, model)
          .then((d) => send(200, { ok: true, ...d }))
          .catch((e) => send(400, toErrorBody(e)));
        return;
      }
      if (url.pathname === '/api/flow') {
        const real = assertAiReadableMd(data.src, cwd);
        const name = data.name || path.basename(path.dirname(real));
        flowOne(real, name, lang, model)
          .then((f) => send(200, { ok: true, ...f }))
          .catch((e) => send(400, toErrorBody(e)));
        return;
      }
      if (url.pathname === '/api/changes-ack') {
        ackChanges(
          scanSections(cwd, lang),
          memorySections(cwd),
          claudeMdRefs(claudeMdLayers({ root: cwd })),
        );
        return send(200, { ok: true });
      }
      if (url.pathname === '/api/open') return send(200, openInEditor(data, cwd));
      if (url.pathname === '/api/summarize-all')
        return send(200, startSummarizeAll(scanSections(cwd, lang), !!data.force, lang, model));
      if (url.pathname === '/api/group-generate') {
        // 環境全体で 1 回の claude 呼び出し。完了時にグループ集合を返す(割当は再取得で反映)
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
        // AI を呼ぶときだけ要るので、フルスキャンは関数で渡して遅延させる
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
        const real = assertAiReadableMd(data.src, cwd);
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
    // 起動時サマリは cwd の文脈(計画 16 判断 8)。CLI に選択という概念は無い
    const data = collect(cwd, serverLang, path.resolve(cwd));
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
