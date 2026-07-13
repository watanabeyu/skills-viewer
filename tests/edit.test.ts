import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { doSave, replaceDescription } from '../src/server/edit';
import { parseFrontmatter } from '../src/server/scan';

describe('replaceDescription', () => {
  it('既存の description 行を差し替える', () => {
    const out = replaceDescription(
      '---\nname: foo\ndescription: old\nversion: 1\n---\nbody\n',
      'new desc',
    );
    const { meta, body } = parseFrontmatter(out);
    expect(meta.description).toBe('new desc');
    expect(meta.name).toBe('foo');
    expect(meta.version).toBe('1');
    expect(body).toBe('body\n');
  });

  it('block scalar(|)の description を継続行ごと差し替える', () => {
    const raw = '---\nname: foo\ndescription: |\n  1行目\n  2行目\nother: x\n---\nbody';
    const { meta } = parseFrontmatter(replaceDescription(raw, 'flat'));
    expect(meta.description).toBe('flat');
    expect(meta.other).toBe('x');
  });

  it('description キーが無ければ name の直後に挿入する', () => {
    const out = replaceDescription('---\nname: foo\n---\nbody', 'added');
    expect(parseFrontmatter(out).meta.description).toBe('added');
    expect(out.indexOf('name: foo')).toBeLessThan(out.indexOf('description:'));
  });

  it('frontmatter 自体が無ければ新設する', () => {
    const out = replaceDescription('# タイトルだけ\n', 'added');
    const { meta, body } = parseFrontmatter(out);
    expect(meta.description).toBe('added');
    expect(body).toContain('# タイトルだけ');
  });

  it('改行・特殊文字は安全にクォートされる', () => {
    const out = replaceDescription('---\ndescription: old\n---\n', 'a: b\n"c" #d');
    expect(parseFrontmatter(out).meta.description).toBe('a: b "c" #d');
  });
});

describe('doSave', () => {
  let dir: string;
  let fp: string;
  beforeEach(() => {
    // assertManagedPath を通すため .claude/skills 配下の実ファイルを作る
    dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'edit-'));
    process.env.SKILLS_VIEWER_BACKUP_DIR = path.join(dir, 'backups'); // 実キャッシュを汚さない
    fp = path.join(dir, '.claude', 'skills', 'foo', 'SKILL.md');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, '---\nname: foo\n---\nold');
  });
  afterEach(() => {
    delete process.env.SKILLS_VIEWER_BACKUP_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('保存できて新しい mtime を返す', () => {
    const r = doSave({ src: fp, content: '---\nname: foo\n---\nnew' });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(fp, 'utf8')).toContain('new');
    expect(r.mtime).toBe(fs.statSync(fp).mtimeMs);
  });

  it('baseMtime が現在と違えば edit-conflict', () => {
    expect(() => doSave({ src: fp, content: 'x', baseMtime: 12345 })).toThrowError(/edit-conflict/);
    expect(fs.readFileSync(fp, 'utf8')).toContain('old'); // 上書きされていない
  });

  it('空の内容・管理外パスは拒否する', () => {
    expect(() => doSave({ src: fp, content: '   ' })).toThrowError(/empty-content/);
    const outside = path.join(dir, 'outside.md');
    fs.writeFileSync(outside, 'x');
    expect(() => doSave({ src: outside, content: 'y' })).toThrowError(/not-managed-path/);
  });
});
