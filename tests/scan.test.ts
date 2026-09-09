import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { encodeProjectPath } from '../src/server/usage';

/*
 * Section.id の安定性(設計判断 13)。id は URL(?project=<id>)に載って共有・リロードを
 * またぐので、配列の位置ではなくプロジェクトのパスから決まらなければならない。
 * scan.ts は HOME を import 時に固定するので、環境を差し替えてから動的 import する。
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-scan-'));
const home = path.join(tmp, 'home');
const projA = path.join(tmp, 'work', 'alpha');
const projB = path.join(tmp, 'work', 'beta');

function writeSkill(project: string, name: string): void {
  const dir = path.join(project, '.claude', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} desc\n---\n`,
  );
}
function registerProjects(projects: string[]): void {
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ projects: Object.fromEntries(projects.map((p) => [p, {}])) }),
  );
}

let scanSections: typeof import('../src/server/scan').scanSections;
let projectSectionId: typeof import('../src/server/scan').projectSectionId;

beforeAll(async () => {
  fs.mkdirSync(home, { recursive: true });
  writeSkill(projA, 'alpha-skill');
  writeSkill(projB, 'beta-skill');
  vi.stubEnv('HOME', home);
  ({ scanSections, projectSectionId } = await import('../src/server/scan'));
});
afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('scanSections の Section.id(設計判断 13)', () => {
  it('project の id はパス由来(proj-<encodeProjectPath>)で、user / plugin / builtin は固定文字列', () => {
    registerProjects([projA, projB]);
    const secs = scanSections(projB);
    const ids = secs.map((s) => s.id);
    expect(ids).toContain('proj-' + encodeProjectPath(projA));
    expect(ids).toContain('proj-' + encodeProjectPath(projB));
    expect(ids.slice(-3)).toEqual(['user', 'plugin', 'builtin']);
    // 配列インデックスの id は残っていない
    expect(ids.some((id) => /^proj-\d+$/.test(id))).toBe(false);
  });

  it('cwd のプロジェクトが先頭に来ても id は変わらない(位置に依存しない)', () => {
    registerProjects([projA, projB]);
    const fromA = scanSections(projA);
    const fromB = scanSections(projB);
    expect(fromA[0].isCurrent).toBe(true);
    expect(fromA[0].id).toBe(projectSectionId(projA));
    expect(fromB[0].id).toBe(projectSectionId(projB));
    // 同じプロジェクトは cwd がどこでも同じ id
    expect(fromA.find((s) => s.note === projB)?.id).toBe(fromB[0].id);
  });

  it('プロジェクトの増減で他プロジェクトの id がずれない', () => {
    registerProjects([projA, projB]);
    const before = scanSections(projB).find((s) => s.note === projB)!.id;
    // alpha を登録から外す(旧実装では beta が proj-1 → proj-0 にずれていた)
    registerProjects([projB]);
    const after = scanSections(projB).find((s) => s.note === projB)!.id;
    expect(after).toBe(before);
  });

  it('projectSectionId はパスを resolve してから符号化する(末尾スラッシュ等の揺れを吸収)', () => {
    expect(projectSectionId(projA + '/')).toBe(projectSectionId(projA));
    expect(projectSectionId(projA)).toBe('proj-' + encodeProjectPath(projA));
  });
});
