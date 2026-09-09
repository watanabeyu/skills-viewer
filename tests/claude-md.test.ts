/*
 * CLAUDE.md 群の走査。この開発環境には CLAUDE.md が 1 枚も無い(7 段すべて不在)ので、
 * 実環境ではなく一時ディレクトリのフィクスチャで確かめる。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { claudeMdLayers, claudeMdRefs } from '../src/server/claude-md';
import type { ClaudeMdLayerKind } from '../src/shared/types';

let dir: string;
let home: string;
let root: string;
/* 管理ポリシーは OS 固定パスなので、テストでは存在しない場所に向けて「無い」を確かめる */
let managedPath: string;

function write(fp: string, body: string): string {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, body);
  return fp;
}

function layer(kind: ClaudeMdLayerKind, opts: Parameters<typeof claudeMdLayers>[0] = {}) {
  const scan = claudeMdLayers({ home, root, managedPath, ...opts });
  return scan.layers.find((l) => l.kind === kind)!;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csb-claudemd-'));
  home = path.join(dir, 'home');
  root = path.join(dir, 'proj');
  managedPath = path.join(dir, 'no-such-managed', 'CLAUDE.md');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('claudeMdLayers — 7 段の列挙', () => {
  it('1 枚も無ければ全段が files: [] で、合計は 0(「なし」の行を出せるように段自体は残す)', () => {
    const scan = claudeMdLayers({ home, root, managedPath });
    expect(scan.layers.map((l) => l.kind)).toEqual([
      'managed',
      'user',
      'project',
      'project-dot',
      'local',
      'rules',
      'parent',
    ]);
    expect(scan.layers.every((l) => l.files.length === 0)).toBe(true);
    expect(scan.tokens).toBe(0);
  });

  it('注入順に並び、存在する段だけ files が埋まる', () => {
    write(path.join(home, '.claude', 'CLAUDE.md'), '# user\nhello');
    write(path.join(root, 'CLAUDE.md'), '# project\nhello');
    write(path.join(root, '.claude', 'CLAUDE.md'), '# project-dot\nhello');
    write(path.join(root, 'CLAUDE.local.md'), '# local\nhello');
    const scan = claudeMdLayers({ home, root, managedPath });
    const filled = scan.layers.filter((l) => l.files.length).map((l) => l.kind);
    expect(filled).toEqual(['user', 'project', 'project-dot', 'local']);
    expect(scan.tokens).toBeGreaterThan(0);
  });

  it('root が無ければ管理ポリシーと user の 2 段だけを見る', () => {
    const scan = claudeMdLayers({ home, root: null, managedPath });
    expect(scan.layers.map((l) => l.kind)).toEqual(['managed', 'user']);
  });

  it('管理ポリシーは本文を返さず、存在と概算だけ扱う', () => {
    const managed = path.join(dir, 'managed', 'CLAUDE.md');
    write(managed, '# managed\n## 節\n本文');
    const l = layer('managed', { managedPath: managed });
    expect(l.files[0].bodyWithheld).toBe(true);
    expect(l.files[0].headings).toEqual([]);
    expect(l.files[0].tokens).toBeGreaterThan(0);
  });
});

describe('見出しごとの概算', () => {
  it('見出しから次の見出しの直前までを 1 節として数える', () => {
    write(path.join(root, 'CLAUDE.md'), '# 基本方針\n本文A\n\n## 言語\n本文B\n');
    const f = layer('project').files[0];
    expect(f.headings.map((h) => h.text)).toEqual(['基本方針', '言語']);
    expect(f.headings.every((h) => h.tokens > 0)).toBe(true);
  });
});

describe('rules 段', () => {
  it('paths: が無いものだけを常時コストに数え、paths: 付きは lazy として残す', () => {
    write(path.join(root, '.claude', 'rules', 'always.md'), '# always\n本文');
    write(
      path.join(root, '.claude', 'rules', 'lazy.md'),
      '---\npaths:\n  - "src/**/*.ts"\n---\n# lazy\n本文',
    );
    const l = layer('rules');
    expect(l.files.map((f) => path.basename(f.path))).toEqual(['always.md', 'lazy.md']);
    expect(l.files.find((f) => f.path.endsWith('lazy.md'))!.lazy).toBe(true);
    expect(l.files.find((f) => f.path.endsWith('always.md'))!.lazy).toBeUndefined();
    // 合計は always.md の分だけ
    expect(l.tokens).toBe(l.files.find((f) => f.path.endsWith('always.md'))!.tokens);
  });

  it('paths: の値は YAML リストで既存パーサが読めないので、キーの有無で判定する', () => {
    // 値が空文字列になる形。真偽値で判定すると取りこぼす
    write(path.join(root, '.claude', 'rules', 'a.md'), '---\npaths:\n  - "x"\n---\n本文');
    expect(layer('rules').files[0].lazy).toBe(true);
  });

  it('rules ディレクトリが無ければ空', () => {
    expect(layer('rules').files).toEqual([]);
  });
});

describe('@import の展開', () => {
  it('参照先の中身を数え、深さを記録する', () => {
    write(path.join(root, 'common.md'), 'shared body');
    write(path.join(root, 'CLAUDE.md'), '# p\n@./common.md\n');
    const f = layer('project').files[0];
    expect(f.imports).toHaveLength(1);
    expect(f.imports[0].exists).toBe(true);
    expect(f.imports[0].depth).toBe(1);
    expect(f.tokens).toBe(f.ownTokens + f.imports[0].tokens);
  });

  it('循環は 2 度目で打ち切り、印を残す', () => {
    write(path.join(root, 'a.md'), '@./b.md');
    write(path.join(root, 'b.md'), '@./a.md');
    write(path.join(root, 'CLAUDE.md'), '@./a.md');
    const f = layer('project').files[0];
    const cyclic = f.imports.filter((im) => im.skipped === 'cycle');
    expect(cyclic).toHaveLength(1);
    expect(cyclic[0].tokens).toBe(0);
  });

  it('4 段を超えたら打ち切る', () => {
    for (let i = 1; i <= 6; i++) write(path.join(root, `l${i}.md`), `body ${i}\n@./l${i + 1}.md`);
    write(path.join(root, 'CLAUDE.md'), '@./l1.md');
    const f = layer('project').files[0];
    expect(f.imports.some((im) => im.skipped === 'depth')).toBe(true);
    expect(Math.max(...f.imports.map((im) => im.depth))).toBeLessThanOrEqual(5);
  });

  it('存在しない参照は exists: false で残す(コストは 0)', () => {
    write(path.join(root, 'CLAUDE.md'), '@./missing.md');
    const f = layer('project').files[0];
    expect(f.imports[0].exists).toBe(false);
    expect(f.imports[0].tokens).toBe(0);
  });

  it('コードブロック内の @ は参照として拾わない', () => {
    write(path.join(root, 'other.md'), 'x');
    write(path.join(root, 'CLAUDE.md'), '```\n@./other.md\n```\n');
    expect(layer('project').files[0].imports).toEqual([]);
  });

  it('~ 始まりは home から解決する', () => {
    write(path.join(home, 'shared.md'), 'shared');
    write(path.join(root, 'CLAUDE.md'), '@~/shared.md');
    const f = layer('project').files[0];
    expect(f.imports[0].exists).toBe(true);
    expect(f.imports[0].path).toBe(fs.realpathSync(path.join(home, 'shared.md')));
  });
});

describe('親ディレクトリの段', () => {
  it('git root まで遡る(その間の CLAUDE.md を拾う)', () => {
    const repo = path.join(dir, 'repo');
    const sub = path.join(repo, 'packages', 'app');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(sub, { recursive: true });
    write(path.join(repo, 'CLAUDE.md'), '# repo root');
    write(path.join(repo, 'packages', 'CLAUDE.md'), '# packages');
    const l = layer('parent', { root: sub });
    expect(l.files.map((f) => path.dirname(f.path))).toEqual([path.join(repo, 'packages'), repo]);
  });

  it('git 管理外なら 1 つ上だけ見る', () => {
    const outer = path.join(dir, 'outer');
    const inner = path.join(outer, 'inner');
    fs.mkdirSync(inner, { recursive: true });
    write(path.join(outer, 'CLAUDE.md'), '# outer');
    write(path.join(dir, 'CLAUDE.md'), '# too far');
    const l = layer('parent', { root: inner });
    expect(l.files.map((f) => f.path)).toEqual([path.join(outer, 'CLAUDE.md')]);
  });

  it('ホームより上には出ない', () => {
    const inHome = path.join(home, 'proj');
    fs.mkdirSync(inHome, { recursive: true });
    write(path.join(home, 'CLAUDE.md'), '# home');
    expect(layer('parent', { root: inHome }).files).toEqual([]);
  });
});

describe('claudeMdRefs — 差分追跡へ渡す参照', () => {
  it('管理ポリシーは追跡しない(OS が配るもので利用者の変更対象ではない)', () => {
    const managed = path.join(dir, 'managed', 'CLAUDE.md');
    write(managed, '# managed');
    write(path.join(root, 'CLAUDE.md'), '# project');
    const refs = claudeMdRefs(claudeMdLayers({ home, root, managedPath: managed }), home);
    expect(refs.map((r) => r.path)).toEqual([path.join(root, 'CLAUDE.md')]);
  });

  it('~/.claude 配下は user、それ以外は project', () => {
    write(path.join(home, '.claude', 'CLAUDE.md'), '# user');
    write(path.join(root, 'CLAUDE.md'), '# project');
    const refs = claudeMdRefs(claudeMdLayers({ home, root, managedPath }), home);
    expect(refs.map((r) => r.source)).toEqual(['user', 'project']);
    expect(refs.every((r) => r.exists)).toBe(true);
  });

  it('遅延ロードの rules も追跡する(変わったら知りたい)', () => {
    write(path.join(root, '.claude', 'rules', 'lazy.md'), '---\npaths:\n  - "x"\n---\n本文');
    const refs = claudeMdRefs(claudeMdLayers({ home, root, managedPath }), home);
    expect(refs.map((r) => path.basename(r.path))).toEqual(['lazy.md']);
  });
});
