import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  encodeProjectPath,
  extractHits,
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
  const root = path.join(tmp, 'projects');
  const memPath = path.join(tmp, 'parent-repo', 'memory', 'handoff.md');
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
});
