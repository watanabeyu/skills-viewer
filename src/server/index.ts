/*
 * HTTP サーバー: /api/* の JSON API + dist/ (SPA) の静的配信。
 * セキュリティ: 127.0.0.1 バインド + 起動ごとのトークン(/api/token で同一オリジンにのみ配布。
 * mutation 系はトークン必須。SOP により他オリジンのページはトークンを読めない)。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { execFile } from 'node:child_process';

import type { Lang, MemorySection, Section, SkillsData } from '../shared/types';
import { scanSections, listProjects, HOME } from './scan';
import { scanUsageByDir, scanMemoryUsage, encodeProjectPath, hasTranscripts } from './usage';
import { scanMemory } from './memory';
import {
  loadSummaries,
  contentHash,
  modelOf,
  summarizeOne,
  saveSummary,
  staleItems,
  startSummarizeAll,
  summaryStatus,
} from './summary';
import { assertReadableMd, doCopy, doDelete, openInEditor } from './manage';
import { doApplyDescription, doSave } from './edit';
import { attachDiagnoses, diagnoseOne } from './diagnose';
import { attachFlows, flowOne } from './flow';
import { attachGroups, generateGroups } from './groups';
import { attachMemoryTriage, triageProject } from './memory-triage';
import { ackChanges, computeChanges } from './snapshot';
import { ApiError, toErrorBody } from './errors';
import { serverLang, srvMsg } from './locale';

const TOKEN = crypto.randomBytes(16).toString('hex');
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
 */
function attributeMemoryUsage(memory: MemorySection[]): void {
  if (!memory.length) return;
  const { byPath, dirsWithTranscripts } = scanMemoryUsage();
  for (const sec of memory) {
    sec.usageAvailable = hasTranscripts(dirsWithTranscripts, sec.id);
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
function memorySections(cwd: string): MemorySection[] {
  const memory = scanMemory(cwd);
  attributeMemoryUsage(memory);
  return memory;
}

/*
 * web へ返す直前に、サーバー内部でしか使わないフィールドを memory セクションから落とす。
 * otherProjects は wrong-project の候補算出(triageProject)専用で web には参照が無く、
 * セクション × 登録プロジェクト数だけ payload を膨らませるだけ。
 * /api/memory-triage は自前で memorySections() を再スキャンするので影響しない。
 */
export function publicMemory(memory: MemorySection[]): MemorySection[] {
  return memory.map((sec) => {
    const out = { ...sec };
    delete out.otherProjects;
    return out;
  });
}

function collect(cwd: string, lang: Lang): SkillsData {
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
  const memory = memorySections(cwd);
  attachMemoryTriage(memory, lang);
  const targets = [
    { label: 'user skills', sub: '~/.claude/skills/', path: HOME },
    ...listProjects(cwd)
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b)))
      .map((p) => ({ label: path.basename(p), sub: p, path: p })),
  ];
  return {
    generatedAt: new Date().toISOString(),
    cwd,
    sections,
    targets,
    aiStale,
    usageAvailable,
    changes: computeChanges(sections),
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
        return send(200, collect(cwd, langOf(url.searchParams.get('lang'))));
      if (url.pathname === '/api/summary-status') return send(200, summaryStatus());
      if (url.pathname === '/api/file') {
        const real = assertReadableMd(url.searchParams.get('src') || '');
        // mtime は編集画面の競合検出(/api/save の baseMtime)に使う
        return send(200, {
          content: fs.readFileSync(real, 'utf8'),
          mtime: fs.statSync(real).mtimeMs,
        });
      }
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
      if (url.pathname === '/api/save') return send(200, doSave(data));
      if (url.pathname === '/api/apply-description') return send(200, doApplyDescription(data));
      if (url.pathname === '/api/diagnose') {
        const real = assertReadableMd(data.src);
        const name = data.name || path.basename(path.dirname(real));
        diagnoseOne(real, name, lang, model)
          .then((d) => send(200, { ok: true, ...d }))
          .catch((e) => send(400, toErrorBody(e)));
        return;
      }
      if (url.pathname === '/api/flow') {
        const real = assertReadableMd(data.src);
        const name = data.name || path.basename(path.dirname(real));
        flowOne(real, name, lang, model)
          .then((f) => send(200, { ok: true, ...f }))
          .catch((e) => send(400, toErrorBody(e)));
        return;
      }
      if (url.pathname === '/api/changes-ack') {
        ackChanges(scanSections(cwd, lang));
        return send(200, { ok: true });
      }
      if (url.pathname === '/api/copy') return send(200, doCopy(data, cwd));
      if (url.pathname === '/api/delete') return send(200, doDelete(data));
      if (url.pathname === '/api/open') return send(200, openInEditor(data));
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
        const sec = memorySections(cwd).find((s) => s.id === project);
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
        })
          .then((results) => send(200, { ok: true, results }))
          .catch((e) => send(400, toErrorBody(e)));
        return;
      }
      if (url.pathname === '/api/summarize') {
        const real = assertReadableMd(data.src);
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
    const data = collect(cwd, serverLang);
    const ch = data.changes;
    if (ch) {
      console.log(
        srvMsg(
          `前回から: 追加 ${ch.added.length} / 更新 ${ch.updated.length} / 削除 ${ch.removed.length}`,
          `Since last run: ${ch.added.length} added / ${ch.updated.length} updated / ${ch.removed.length} removed`,
        ),
      );
    }
    const sessionTokens = data.sections
      .filter((s) => s.source !== 'project' || s.isCurrent)
      .flatMap((s) => s.items)
      .reduce((sum, it) => sum + (it.tokens || 0), 0);
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
