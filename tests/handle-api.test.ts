/*
 * /api/* の結線(レビュー 2 周目の指摘)。ハンドラを通るテストが 1 本も無かったため、
 * 「どのパラメータをどの検証に渡しているか」を壊しても全テストが緑のままだった
 * (実測: ack を旧式に戻す / collect の CLAUDE.md 追跡を cwd だけに縮める /
 *  /api/diff の引数を 1 つずらす、のいずれも検出できなかった)。
 *
 * ここでは http.IncomingMessage / ServerResponse の最小スタブで handleApi を 1 往復させ、
 * 「クエリの ?project= が読み取り許可に届いているか」「①(変化)の入力が collect と
 * /api/changes-ack で同じか」「Origin / Host のゲートが効いているか」
 * 「一括要約の母集団が ③ と一致するか」を結合で固定する。サーバーは起こさない(listen しない)。
 *
 * 環境: HOME は必ず一時ディレクトリに差し替えてから動的 import する。
 * snapshot(~/.cache/skills-viewer/snapshot.json)と AI キャッシュのパスは import 時に
 * HOME から固定されるので、差し替え前に import したモジュールを使うと実環境の基準を書き換える。
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { projectSectionId } from '../src/server/scan';
import type { Section, SkillsData } from '../src/shared/types';

/*
 * 一括要約(POST /api/summarize-all)が「どの母集団を」ジョブに渡したかを見るための差し替え。
 * 本物は claude CLI を起動してしまうので、受け取った sections だけ記録して空のジョブを返す
 * (他の export は素通し ── collect が使う loadSummaries / staleItems などは本物のまま)。
 */
const summarizeAllArgs = vi.hoisted(() => [] as Section[][]);
vi.mock('../src/server/summary', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/server/summary')>();
  return {
    ...actual,
    startSummarizeAll: (sections: Section[]) => {
      summarizeAllArgs.push(sections);
      return { finished: true, total: 0, done: 0, errors: [] };
    },
  };
});

interface Reply {
  code: number;
  body: any;
}

/* handleApi を 1 往復させる。GET は同期、mutation は data / end を流してから応答を待つ */
function call(
  mod: typeof import('../src/server/index'),
  cwd: string,
  opts: {
    method?: string;
    url: string;
    token?: string;
    body?: unknown;
    /* 既定は 127.0.0.1(hostOk)。Origin なしは same-origin fetch と同じ扱い */
    host?: string;
    origin?: string;
  },
): Promise<Reply> {
  return new Promise((resolve) => {
    const method = opts.method || 'GET';
    const listeners: Record<string, ((chunk?: unknown) => void)[]> = {};
    const req = {
      method,
      url: opts.url,
      headers: {
        host: opts.host ?? '127.0.0.1:4763',
        ...(opts.origin ? { origin: opts.origin } : {}),
        ...(opts.token ? { 'x-csb-token': opts.token } : {}),
      },
      on(ev: string, cb: (chunk?: unknown) => void) {
        (listeners[ev] ||= []).push(cb);
        return req;
      },
      destroy() {},
    } as unknown as http.IncomingMessage;
    let code = 0;
    const res = {
      writeHead(c: number) {
        code = c;
        return res;
      },
      end(body?: string) {
        resolve({ code, body: body ? JSON.parse(body) : null });
      },
    } as unknown as http.ServerResponse;
    mod.handleApi(req, res, cwd);
    if (method !== 'GET') {
      const payload = JSON.stringify(opts.body ?? {});
      for (const cb of listeners.data || []) cb(payload);
      for (const cb of listeners.end || []) cb();
    }
  });
}

describe('handleApi (クエリ・トークン・入力の結線)', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sv-handle-api-')));
  const home = path.join(tmp, 'home');
  const alpha = path.join(tmp, 'work', 'alpha'); // cwd
  const beta = path.join(tmp, 'work', 'beta'); // 登録済みだが cwd ではない
  const wtree = path.join(tmp, 'work', 'alpha-feat-a'); // alpha の worktree(登録簿には無い)
  const wtreeSkill = path.join(wtree, '.claude', 'skills', 'wt-skill', 'SKILL.md');
  let mod: typeof import('../src/server/index');
  const q = (o: Record<string, string>) =>
    Object.entries(o)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');

  beforeAll(async () => {
    for (const d of [home, alpha, beta]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ projects: { [alpha]: {}, [beta]: {} } }),
    );
    fs.writeFileSync(path.join(alpha, 'CLAUDE.md'), '# alpha\n');
    fs.writeFileSync(path.join(beta, 'CLAUDE.md'), '# beta\n');
    /*
     * alpha の linked worktree(登録簿には無い = 「claude をそこで起動していない」状態)。
     * git が書くファイルだけを再現する(tests/worktrees.test.ts の writeAdminDir と同じ形)。
     * 一括要約の母集団が「登録簿だけ」に縮んでいると、この skill がジョブに入らない。
     */
    const admin = path.join(alpha, '.git', 'worktrees', 'alpha-feat-a');
    fs.mkdirSync(admin, { recursive: true });
    fs.mkdirSync(path.dirname(wtreeSkill), { recursive: true });
    fs.writeFileSync(path.join(wtree, '.git'), 'gitdir: ' + admin + '\n');
    fs.writeFileSync(path.join(admin, 'gitdir'), path.join(wtree, '.git') + '\n');
    fs.writeFileSync(path.join(admin, 'HEAD'), 'ref: refs/heads/feat/a\n');
    fs.writeFileSync(
      wtreeSkill,
      '---\nname: wt-skill\ndescription: worktree にだけある skill\n---\n本文\n',
    );
    vi.resetModules();
    vi.stubEnv('HOME', home); // ← import より前(SNAPSHOT_FILE などが HOME を焼き込む)
    mod = await import('../src/server/index');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /*
   * 読み取り許可の母集団は cwd と選んだプロジェクトの 2 つ。?project= を渡さなければ
   * cwd だけなので、別プロジェクトの CLAUDE.md は 400 になる。
   */
  it('GET /api/file は ?project= を読み取り許可に渡す', async () => {
    const src = path.join(beta, 'CLAUDE.md');
    const denied = await call(mod, alpha, { url: '/api/file?' + q({ src }) });
    expect(denied.code).toBe(400);
    expect(denied.body.error).toBe('not-readable-path');

    const ok = await call(mod, alpha, {
      url: '/api/file?' + q({ src, project: projectSectionId(beta) }),
    });
    expect(ok.code).toBe(200);
    expect(ok.body.content).toBe('# beta\n');
  });

  /*
   * /api/diff も同じ母集団。選んでいなければ境界の外(out-of-scope)、選んでいれば
   * 境界の中まで進んで git の有無で判定される(この fixture は git 管理外なので not-git)。
   * 選択が resolveDiffTarget まで届いていなければ、両方 out-of-scope になる。
   */
  it('GET /api/diff は ?project= を resolveDiffTarget まで渡す', async () => {
    const src = path.join(beta, 'CLAUDE.md');
    const denied = await call(mod, alpha, { url: '/api/diff?' + q({ src }) });
    expect(denied.code).toBe(200);
    expect(denied.body).toEqual({ available: false, reason: 'out-of-scope' });

    const passed = await call(mod, alpha, {
      url: '/api/diff?' + q({ src, project: projectSectionId(beta) }),
    });
    expect(passed.code).toBe(200);
    expect(passed.body).toEqual({ available: false, reason: 'not-git' });
  });

  it('mutation はトークン必須(付けなければ 403、値は /api/token と同じ)', async () => {
    const noToken = await call(mod, alpha, { method: 'POST', url: '/api/changes-ack' });
    expect(noToken).toEqual({ code: 403, body: { error: 'bad-token', detail: '' } });
    const bad = await call(mod, alpha, {
      method: 'POST',
      url: '/api/changes-ack',
      token: 'not-the-token',
    });
    expect(bad.code).toBe(403);
    const tok = await call(mod, alpha, { url: '/api/token' });
    expect(tok.body.token).toBe(mod.TOKEN);
  });

  /*
   * ①(前回からの変化)は collect と /api/changes-ack が同じ入力を見ていないと、
   * 「既読にする」を押した直後にまた同じ差分が出る。CLAUDE.md の追跡対象は登録済み
   * 全プロジェクト(Phase D)なので、cwd 以外のプロジェクトの追加も 1 回で消えること。
   */
  it('POST /api/changes-ack の直後は GET /api/skills に差分が出ない', async () => {
    const url = '/api/skills?' + q({ lang: 'en', project: projectSectionId(beta) });
    // 1 回目は基準の保存だけ(changes は null)
    expect(((await call(mod, alpha, { url })).body as SkillsData).changes).toBeNull();

    // cwd 側に skill を 1 件、cwd 以外の登録済みプロジェクトに CLAUDE.md を 1 件足す
    const skillDir = path.join(alpha, '.claude', 'skills', 'new-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: new-skill\ndescription: 新しく増えた skill\n---\n本文\n',
    );
    const betaLocal = path.join(beta, 'CLAUDE.local.md');
    fs.writeFileSync(betaLocal, '# beta local\n');

    const changed = ((await call(mod, alpha, { url })).body as SkillsData).changes;
    expect(changed?.added.map((e) => e.path)).toEqual(
      expect.arrayContaining([path.join(skillDir, 'SKILL.md'), betaLocal]),
    );

    const ack = await call(mod, alpha, {
      method: 'POST',
      url: '/api/changes-ack',
      token: mod.TOKEN,
      body: { lang: 'en' },
    });
    expect(ack).toEqual({ code: 200, body: { ok: true } });

    expect(((await call(mod, alpha, { url })).body as SkillsData).changes).toBeNull();
  });

  /*
   * /api/open は実際にエディタを起動するので、拒否される側だけを見る
   * (選択を渡していないので beta のファイルは母集団の外)。
   */
  it('POST /api/open は選んでいないプロジェクトのファイルを拒む', async () => {
    const r = await call(mod, alpha, {
      method: 'POST',
      url: '/api/open',
      token: mod.TOKEN,
      body: { src: path.join(beta, 'CLAUDE.md') },
    });
    expect(r.code).toBe(400);
    expect(r.body.error).toBe('not-openable-path');
  });

  /*
   * Origin / Host のゲート(README Security の「非 localhost の Origin は拒否」の番犬)。
   * GET も mutation もハンドラの入口で 403 になり、トークンの有無より前に落ちる。
   * Host も見るのは DNS rebinding 対策(same-origin GET には Origin が付かない)。
   */
  it('非 localhost の Origin / Host は 403(bad-origin)', async () => {
    const evil = await call(mod, alpha, { url: '/api/token', origin: 'http://evil.example' });
    expect(evil).toEqual({ code: 403, body: { error: 'bad-origin', detail: '' } });
    const rebind = await call(mod, alpha, { url: '/api/token', host: 'example.com:4763' });
    expect(rebind).toEqual({ code: 403, body: { error: 'bad-origin', detail: '' } });
    // mutation も同じ入口で落ちる(正しいトークンを付けても通らない)
    const post = await call(mod, alpha, {
      method: 'POST',
      url: '/api/changes-ack',
      token: mod.TOKEN,
      origin: 'http://evil.example',
    });
    expect(post.code).toBe(403);
  });

  it('localhost の Origin と Origin 無しは通る', async () => {
    const withOrigin = await call(mod, alpha, {
      url: '/api/token',
      origin: 'http://127.0.0.1:4763',
    });
    expect(withOrigin.code).toBe(200);
    expect(
      (await call(mod, alpha, { url: '/api/token', origin: 'http://localhost:5173' })).code,
    ).toBe(200);
    // same-origin fetch / curl は Origin を付けない
    expect((await call(mod, alpha, { url: '/api/token' })).code).toBe(200);
  });

  /*
   * 一括要約の母集団は ③(GET /api/skills)と一致していなければならない。
   * cwd 固定のままだと、未登録の worktree を選んだときにその skill が一覧・未要約件数には
   * 出るのに要約ジョブに入らず、「未要約 N 件」が押しても減らない(レビュー 3 周目)。
   */
  it('POST /api/summarize-all の母集団は ③ と一致する(選んだ worktree を含む)', async () => {
    const project = projectSectionId(wtree);
    const shown = (await call(mod, alpha, { url: '/api/skills?' + q({ lang: 'en', project }) }))
      .body as SkillsData;
    const paths = (secs: Section[]) =>
      secs
        .flatMap((s) => s.items)
        .map((it) => it.path)
        .filter(Boolean)
        .sort();
    summarizeAllArgs.length = 0;
    const r = await call(mod, alpha, {
      method: 'POST',
      url: '/api/summarize-all',
      token: mod.TOKEN,
      body: { lang: 'en', selected: project },
    });
    expect(r.code).toBe(200);
    expect(summarizeAllArgs).toHaveLength(1);
    expect(paths(summarizeAllArgs[0])).toContain(wtreeSkill);
    expect(paths(summarizeAllArgs[0])).toEqual(paths(shown.sections));
  });

  it('未知のエンドポイントは 404', async () => {
    expect((await call(mod, alpha, { url: '/api/nope' })).code).toBe(404);
  });
});
