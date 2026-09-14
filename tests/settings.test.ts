import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyTheme,
  editorUrl,
  loadThemePref,
  resolveTheme,
  saveThemePref,
} from '../web/src/settings';

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

/* Node 環境には localStorage / matchMedia / document が無い。必要なテストだけ最小のスタブを置く */
describe('theme (テーマ設定の読み書きと解決)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ブラウザ外(localStorage 無し)でも落ちず既定の auto を返す', () => {
    expect(loadThemePref()).toBe('auto');
    expect(() => saveThemePref('console')).not.toThrow();
  });

  it('csb-theme に保存した値を読み戻し、不正値は auto に戻す', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    saveThemePref('console');
    expect(store.get('csb-theme')).toBe('console');
    expect(loadThemePref()).toBe('console');
    store.set('csb-theme', 'paper');
    expect(loadThemePref()).toBe('auto');
  });

  it('固定した設定はそのまま、auto は OS の配色で解決する', () => {
    expect(resolveTheme('console')).toBe('console');
    expect(resolveTheme('ledger')).toBe('ledger');
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    expect(resolveTheme('auto')).toBe('console');
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(resolveTheme('auto')).toBe('ledger');
  });

  it('matchMedia が無い環境の auto は ledger(明)に倒す', () => {
    expect(resolveTheme('auto')).toBe('ledger');
  });

  it('applyTheme は <html data-theme> に書き込む(document 無しでは何もしない)', () => {
    expect(() => applyTheme('console')).not.toThrow();
    const dataset: Record<string, string> = {};
    vi.stubGlobal('document', { documentElement: { dataset } });
    applyTheme('console');
    expect(dataset.theme).toBe('console');
  });
});
