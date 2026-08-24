import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  encodeProjectPath,
  extractHits,
  hasTranscripts,
  scanMemoryUsage,
  scanTranscript,
} from '../src/server/usage';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-usage-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fixture(lines: string[]): string {
  const fp = path.join(tmp, Math.random().toString(36).slice(2) + '.jsonl');
  fs.writeFileSync(fp, lines.join('\n'));
  return fp;
}

describe('extractHits (トランスクリプトからの起動抽出)', () => {
  it('人間タイプ(<command-name>)を typed として拾う', () => {
    const fp = fixture([
      '{"timestamp":"2026-07-08T00:00:00.000Z","message":"<command-name>/weall-ship</command-name>"}',
    ]);
    expect(extractHits(fp)).toEqual([
      { name: 'weall-ship', ts: Date.parse('2026-07-08T00:00:00.000Z'), via: 'typed' },
    ]);
  });

  it('Skill ツール呼び出しを auto として拾う', () => {
    const fp = fixture([
      '{"timestamp":"2026-07-08T01:00:00.000Z","x":{"name":"Skill","input":{"skill":"code-review"}}}'.replace(
        /x":/,
        'tool":',
      ),
    ]);
    const hits = extractHits(fp);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ name: 'code-review', via: 'auto' });
  });

  it('subagent_type(エージェント起動)を auto として拾う', () => {
    const fp = fixture([
      '{"timestamp":"2026-07-08T02:00:00.000Z","input":{"subagent_type":"debugger"}}',
    ]);
    expect(extractHits(fp)[0]).toMatchObject({ name: 'debugger', via: 'auto' });
  });

  it('無関係な行は無視する', () => {
    const fp = fixture(['{"type":"assistant","text":"hello"}', 'not json at all']);
    expect(extractHits(fp)).toEqual([]);
  });

  it('チャンク境界をまたぐ行・マルチバイト文字も正しく処理する', () => {
    const lines = [
      '{"timestamp":"2026-07-08T00:00:00.000Z","message":"日本語のパディング テキスト","x":"<command-name>/alpha</command-name>"}',
      '{"timestamp":"2026-07-08T01:00:00.000Z","input":{"subagent_type":"beta"}}',
    ];
    const fp = fixture(lines);
    // chunkSize=7 で行・マルチバイト文字が必ず分断される状況を作る
    expect(extractHits(fp, 7)).toEqual(extractHits(fp));
    expect(extractHits(fp, 7).map((h) => h.name)).toEqual(['alpha', 'beta']);
  });
});

describe('encodeProjectPath', () => {
  it('Claude Code のトランスクリプトディレクトリ名の規則と一致する', () => {
    expect(encodeProjectPath('/Users/foo/Dropbox/work/weall/monorepo')).toBe(
      '-Users-foo-Dropbox-work-weall-monorepo',
    );
    expect(encodeProjectPath('/Users/foo/app.example')).toBe('-Users-foo-app-example');
  });
});

describe('scanTranscript (memory ファイルへの Read / Write / Edit)', () => {
  it('memory の Read を read、Write / Edit を write として拾う', () => {
    const fp = fixture([
      '{"timestamp":"2026-07-08T00:00:00.000Z","tool":{"name":"Read","input":{"file_path":"/Users/x/.claude/projects/-Users-x-repo/memory/handoff.md"}}}',
      '{"timestamp":"2026-07-08T01:00:00.000Z","tool":{"name":"Write","input":{"file_path":"/Users/x/.claude/projects/-Users-x-repo/memory/handoff.md"}}}',
      '{"timestamp":"2026-07-08T02:00:00.000Z","tool":{"name":"Edit","input":{"file_path":"/Users/x/.claude/projects/-Users-x-repo/memory/handoff.md"}}}',
    ]);
    expect(scanTranscript(fp).memHits.map((h) => h.kind)).toEqual(['read', 'write', 'write']);
  });

  it('memory 以外のファイル操作と MEMORY.md(索引)は拾わない', () => {
    const fp = fixture([
      '{"timestamp":"2026-07-08T00:00:00.000Z","tool":{"name":"Read","input":{"file_path":"/Users/x/repo/.claude/skills/foo/SKILL.md"}}}',
      '{"timestamp":"2026-07-08T00:00:00.000Z","tool":{"name":"Read","input":{"file_path":"/Users/x/.claude/projects/-Users-x-repo/memory/MEMORY.md"}}}',
      '{"timestamp":"2026-07-08T00:00:00.000Z","tool":{"name":"Read","input":{"file_path":"/Users/x/.claude/projects/-Users-x-repo/memory/notes.txt"}}}',
    ]);
    expect(scanTranscript(fp).memHits).toEqual([]);
  });

  it('既存3パターンと同じ行・同じファイルに混在しても両方を取り違えない', () => {
    const fp = fixture([
      '{"timestamp":"2026-07-08T00:00:00.000Z","message":"<command-name>/weall-ship</command-name>"}',
      '{"timestamp":"2026-07-08T01:00:00.000Z","tool":{"name":"Read","input":{"file_path":"/Users/x/.claude/projects/-Users-x-repo/memory/handoff.md"}},"input":{"subagent_type":"debugger"}}',
    ]);
    const { hits, memHits } = scanTranscript(fp);
    expect(hits.map((h) => h.name)).toEqual(['weall-ship', 'debugger']);
    expect(memHits).toEqual([
      {
        path: '/Users/x/.claude/projects/-Users-x-repo/memory/handoff.md',
        ts: Date.parse('2026-07-08T01:00:00.000Z'),
        kind: 'read',
      },
    ]);
  });
});

describe('scanMemoryUsage (全ディレクトリ横断・file_path キーの集計)', () => {
  /* worktree のセッションは親リポジトリの memory を触るので、集計は file_path に寄せる */
  // 実装は ~/.claude/projects/ 配下だけを memory とみなすので、fixture も同じ形で作る
  const root = path.join(tmp, '.claude', 'projects');
  // 自動メモリの実パスは <encoded>/memory/ 直下(親リポジトリ側にだけ作られる)
  const memPath = path.join(root, '-Users-x-repo', 'memory', 'handoff.md');
  const line = (name: string, ts: string) =>
    `{"timestamp":"${ts}","tool":{"name":"${name}","input":{"file_path":"${memPath}"}}}`;

  it('worktree ディレクトリの Read も親の memory 実パスに集計し、jsonl のあるディレクトリを返す', () => {
    const parent = path.join(root, '-Users-x-repo');
    const worktree = path.join(root, '-Users-x-repo-feat-a');
    fs.mkdirSync(parent, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    fs.mkdirSync(path.join(root, '-Users-x-empty'), { recursive: true });
    fs.writeFileSync(
      path.join(parent, 's1.jsonl'),
      [line('Read', '2026-07-08T00:00:00.000Z'), line('Write', '2026-07-08T00:00:00.000Z')].join(
        '\n',
      ),
    );
    fs.writeFileSync(
      path.join(worktree, 's2.jsonl'),
      [line('Read', '2026-07-09T00:00:00.000Z'), line('Edit', '2026-07-09T00:00:00.000Z')].join(
        '\n',
      ),
    );
    const { byPath, dirsWithTranscripts } = scanMemoryUsage(root);
    expect(byPath[memPath]).toMatchObject({
      reads: 2,
      writes: 2,
      lastRead: Date.parse('2026-07-09T00:00:00.000Z'),
    });
    // daily は Read のみを数える
    expect(Object.values(byPath[memPath].daily).reduce((a, b) => a + b, 0)).toBe(2);
    expect([...dirsWithTranscripts].sort()).toEqual(['-Users-x-repo', '-Users-x-repo-feat-a']);
  });

  /* 実データの Edit は {"replace_all":…,"file_path":…} の順で、file_path は第 1 キーではない */
  it('キー順の違う Edit(replace_all が先頭)も write として拾う', () => {
    const dir = path.join(root, '-Users-x-edit');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(root, '-Users-x-edit', 'memory', 'handoff.md');
    fs.writeFileSync(
      path.join(dir, 's3.jsonl'),
      `{"timestamp":"2026-07-10T00:00:00.000Z","tool":{"name":"Edit","input":{"replace_all":false,"file_path":"${p}"}}}`,
    );
    const { byPath } = scanMemoryUsage(root);
    expect(byPath[p]).toMatchObject({ reads: 0, writes: 1 });
  });

  /*
   * 場所の判定は scanLine ではなく scanMemoryUsage(root) の後段が持つ(root を差し替えても効くように)。
   * リポジトリ内の src/memory/*.md は scanTranscript 単体では拾われ、root 外として集計から落ちる。
   */
  it('memory 以外の file_path(MEMORY.md・memory 直下でない)は拾わず、root 外は集計から落ちる', () => {
    const ok = path.join(root, '-Users-x-repo', 'memory', 'reference.md');
    const outside = '/Users/x/repo/src/memory/notes.md'; // リポジトリ内の同名ディレクトリ
    const paths = [
      ok,
      path.join(root, '-Users-x-repo', 'memory', 'MEMORY.md'), // 索引はアイテムではない
      path.join(root, '-Users-x-repo', 'memory', 'sub', 'deep.md'), // memory/ 直下ではない
      outside,
    ];
    const lines = paths.map(
      (p) =>
        `{"timestamp":"2026-07-11T00:00:00.000Z","tool":{"name":"Read","input":{"file_path":"${p}"}}}`,
    );
    expect(scanTranscript(fixture(lines)).memHits.map((h) => h.path)).toEqual([ok, outside]);

    const dir = path.join(root, '-Users-x-outside');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 's4.jsonl'), lines.join('\n'));
    const { byPath } = scanMemoryUsage(root);
    expect(byPath[ok]).toMatchObject({ reads: 1 });
    expect(byPath[outside]).toBeUndefined();
  });
});

/*
 * 計画 13 Phase D レビュー対応 M2: autoMemoryDirectory で置き場が ~/.claude/projects の外へ
 * 移った環境でも Read / Write 実績を集計する。パスの形(/memory/ 直下)では拾えないので、
 * 許可ルートとして渡す。
 */
describe('scanMemoryUsage (autoMemoryDirectory の置き場を許可ルートとして集計)', () => {
  const root = path.join(tmp, 'allow', '.claude', 'projects');
  const store = path.join(tmp, 'allow', 'mem-store'); // root 外の任意ディレクトリ
  const memPath = path.join(store, 'handoff.md');
  const line = (name: string, fp: string, ts: string) =>
    `{"timestamp":"${ts}","tool":{"name":"${name}","input":{"file_path":"${fp}"}}}`;

  it('置き場配下の *.md を集計し、MEMORY.md は除く。許可しなければ従来どおり拾わない', () => {
    const dir = path.join(root, '-Users-x-auto');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 's1.jsonl'),
      [
        line('Read', memPath, '2026-07-12T00:00:00.000Z'),
        line('Write', memPath, '2026-07-12T01:00:00.000Z'),
        line('Read', path.join(store, 'MEMORY.md'), '2026-07-12T02:00:00.000Z'),
      ].join('\n'),
    );
    const { byPath } = scanMemoryUsage(root, [store]);
    expect(byPath[memPath]).toMatchObject({
      reads: 1,
      writes: 1,
      lastRead: Date.parse('2026-07-12T00:00:00.000Z'),
    });
    expect(byPath[path.join(store, 'MEMORY.md')]).toBeUndefined();

    // 許可ルートを外すと(既定環境)集計対象にならない。キャッシュも許可ルートごとに分かれる
    const { byPath: plain } = scanMemoryUsage(root, []);
    expect(plain[memPath]).toBeUndefined();
  });

  /*
   * 計画 13 Phase D round2: 逆順(許可なし → 許可あり)でも拾えることを固定する。
   * transcript のスキャン結果は mtime キャッシュに載るので、許可ルートをキーに含めていないと
   * 1 回目(許可なし)の結果が居座り、設定を効かせた 2 回目で実績が 0 のままになる。
   */
  it('許可なしで一度スキャンした transcript でも、許可ルートを渡した 2 回目で拾える', () => {
    const dir = path.join(root, '-Users-x-auto-late');
    fs.mkdirSync(dir, { recursive: true });
    const late = path.join(store, 'late.md');
    fs.writeFileSync(
      path.join(dir, 's2.jsonl'),
      line('Read', late, '2026-07-13T00:00:00.000Z'), // 同じ transcript を 2 回スキャンする
    );
    expect(scanMemoryUsage(root, []).byPath[late]).toBeUndefined();
    expect(scanMemoryUsage(root, [store]).byPath[late]).toMatchObject({ reads: 1 });
  });
});

/* 入力は Set だけなので他 describe の fixture に依存させない(-t 指定の単独実行でも通す) */
describe('hasTranscripts (usageAvailable の前方一致)', () => {
  const dirs = new Set(['-Users-x-repo', '-Users-x-repo-feat-a']);

  it('完全一致・worktree だけの一致で true、境界のない前方一致・Set に無い名前は false', () => {
    expect(hasTranscripts(dirs, '-Users-x-repo')).toBe(true);
    // 親のディレクトリを外しても、worktree 側の transcript だけで計測可能とみなす
    expect(hasTranscripts(new Set(['-Users-x-repo-feat-a']), '-Users-x-repo')).toBe(true);
    // -Users-x-rep2 が -Users-x-rep に一致しないよう、区切り '-' を必須にする
    expect(hasTranscripts(dirs, '-Users-x-rep')).toBe(false);
    // dirsWithTranscripts に入らなかったプロジェクト(jsonl なし)は false
    expect(hasTranscripts(dirs, '-Users-x-empty')).toBe(false);
  });
});
