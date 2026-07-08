import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { encodeProjectPath, extractHits } from '../src/server/usage';

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
});

describe('encodeProjectPath', () => {
  it('Claude Code のトランスクリプトディレクトリ名の規則と一致する', () => {
    expect(encodeProjectPath('/Users/foo/Dropbox/work/weall/monorepo')).toBe(
      '-Users-foo-Dropbox-work-weall-monorepo',
    );
    expect(encodeProjectPath('/Users/foo/app.example')).toBe('-Users-foo-app-example');
  });
});
