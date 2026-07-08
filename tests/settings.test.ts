import { describe, expect, it } from 'vitest';
import { editorUrl } from '../web/src/settings';

describe('editorUrl (エディタ URL スキームの組み立て)', () => {
  it('プリセットからスキームを組み立てる', () => {
    expect(editorUrl({ mode: 'vscode' }, '/Users/x/.claude/skills/a/SKILL.md')).toBe(
      'vscode://file/Users/x/.claude/skills/a/SKILL.md',
    );
    expect(editorUrl({ mode: 'cursor' }, '/p/a.md')).toBe('cursor://file/p/a.md');
  });

  it('スペースを含むパスをエンコードする', () => {
    expect(editorUrl({ mode: 'vscode' }, '/Users/x/My Docs/a.md')).toBe(
      'vscode://file/Users/x/My%20Docs/a.md',
    );
  });

  it('カスタムテンプレートの {path} を置換する', () => {
    expect(editorUrl({ mode: 'custom', template: 'my://open?f={path}' }, '/a/b.md')).toBe(
      'my://open?f=/a/b.md',
    );
  });

  it('system(OS デフォルト)と不正テンプレートは null(サーバー側にフォールバック)', () => {
    expect(editorUrl({ mode: 'system' }, '/a.md')).toBeNull();
    expect(editorUrl({ mode: 'custom', template: 'no-placeholder://' }, '/a.md')).toBeNull();
  });
});
