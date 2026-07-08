import { useState } from 'react';
import {
  EDITOR_PRESETS,
  loadEditorSetting,
  saveEditorSetting,
  type EditorSetting,
} from '../settings';

export function SettingsModal({
  width,
  onChangeWidth,
  onClose,
}: {
  width: string;
  onChangeWidth: (w: string) => void;
  onClose: () => void;
}) {
  const [setting, setSetting] = useState<EditorSetting>(loadEditorSetting);

  const save = () => {
    if (setting.mode === 'custom' && !(setting.template || '').includes('{path}')) {
      alert('カスタムスキームには {path} を含めてください(例: myeditor://open?file={path})');
      return;
    }
    saveEditorSetting(setting);
    onClose();
  };

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal">
        <h3>設定</h3>

        <div className="set-label">表示幅</div>
        <div className="set-options">
          <label className="set-option">
            <input
              type="radio"
              name="width"
              checked={width === 'full'}
              onChange={() => onChangeWidth('full')}
            />
            <span>フル幅</span>
            <span className="set-scheme">広い画面では 4〜5 カラム</span>
          </label>
          <label className="set-option">
            <input
              type="radio"
              name="width"
              checked={width === 'fixed'}
              onChange={() => onChangeWidth('fixed')}
            />
            <span>固定幅 (1200px)</span>
            <span className="set-scheme">中央寄せ・常に 3 カラム</span>
          </label>
        </div>

        <div className="set-label">「エディタで開く」で使うエディタ</div>
        <div className="set-options">
          {EDITOR_PRESETS.map((p) => (
            <label key={p.id} className="set-option">
              <input
                type="radio"
                name="editor"
                checked={setting.mode === p.id}
                onChange={() => setSetting({ mode: p.id })}
              />
              <span>{p.label}</span>
              <span className="set-scheme">{p.template}</span>
            </label>
          ))}
          <label className="set-option">
            <input
              type="radio"
              name="editor"
              checked={setting.mode === 'custom'}
              onChange={() => setSetting({ mode: 'custom', template: setting.template || '' })}
            />
            <span>カスタム URL スキーム</span>
          </label>
          {setting.mode === 'custom' && (
            <input
              className="set-input"
              placeholder="myeditor://open?file={path}"
              value={setting.template || ''}
              onChange={(e) => setSetting({ mode: 'custom', template: e.target.value })}
            />
          )}
          <label className="set-option">
            <input
              type="radio"
              name="editor"
              checked={setting.mode === 'system'}
              onChange={() => setSetting({ mode: 'system' })}
            />
            <span>OS デフォルト</span>
            <span className="set-scheme">サーバー側で開く(拡張子の既定アプリ)</span>
          </label>
        </div>

        <div className="btns">
          <button className="pbtn" onClick={onClose}>
            キャンセル
          </button>
          <button className="pbtn primary" onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
