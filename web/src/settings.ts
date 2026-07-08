/* エディタで開く方法の設定(localStorage 永続化。npx 配布なので環境変数に依存しない) */

export interface EditorSetting {
  mode: 'vscode' | 'cursor' | 'zed' | 'windsurf' | 'custom' | 'system';
  template?: string; // custom 時の URL スキーム。{path} が絶対パスに置換される
}

export const EDITOR_PRESETS: { id: EditorSetting['mode']; label: string; template: string }[] = [
  { id: 'vscode', label: 'VS Code', template: 'vscode://file{path}' },
  { id: 'cursor', label: 'Cursor', template: 'cursor://file{path}' },
  { id: 'zed', label: 'Zed', template: 'zed://file{path}' },
  { id: 'windsurf', label: 'Windsurf', template: 'windsurf://file{path}' },
];

const KEY = 'csb-editor';

export function loadEditorSetting(): EditorSetting {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as EditorSetting;
  } catch {
    /* 壊れていたら既定に戻す */
  }
  return { mode: 'vscode' };
}

export function saveEditorSetting(s: EditorSetting): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}

/* URL スキームを組み立てる。system(OS デフォルト)は null → サーバー側 /api/open に委譲 */
export function editorUrl(s: EditorSetting, path: string): string | null {
  if (s.mode === 'system') return null;
  const template =
    s.mode === 'custom'
      ? s.template || ''
      : EDITOR_PRESETS.find((p) => p.id === s.mode)?.template || '';
  if (!template.includes('{path}')) return null;
  return template.replace('{path}', encodeURI(path));
}
