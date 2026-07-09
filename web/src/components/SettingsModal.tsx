import { useState } from 'react';
import {
  EDITOR_PRESETS,
  loadEditorSetting,
  saveEditorSetting,
  type EditorSetting,
} from '../settings';
import { t, type Lang } from '../i18n';

const LANGS: [Lang, string][] = [
  ['ja', '日本語'],
  ['en', 'English'],
];

export function SettingsModal({
  width,
  onChangeWidth,
  lang,
  onChangeLang,
  onClose,
}: {
  width: string;
  onChangeWidth: (w: string) => void;
  lang: Lang;
  onChangeLang: (l: Lang) => void;
  onClose: () => void;
}) {
  const [setting, setSetting] = useState<EditorSetting>(loadEditorSetting);

  const save = () => {
    if (setting.mode === 'custom' && !(setting.template || '').includes('{path}')) {
      alert(t('settings.customNeedsPath'));
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
        <h3>{t('settings.title')}</h3>

        <div className="set-label">{t('settings.language')}</div>
        <div className="set-options">
          {LANGS.map(([id, label]) => (
            <label key={id} className="set-option">
              <input
                type="radio"
                name="lang"
                checked={lang === id}
                onChange={() => onChangeLang(id)}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>

        <div className="set-label">{t('settings.width')}</div>
        <div className="set-options">
          <label className="set-option">
            <input
              type="radio"
              name="width"
              checked={width === 'full'}
              onChange={() => onChangeWidth('full')}
            />
            <span>{t('settings.widthFull')}</span>
            <span className="set-scheme">{t('settings.widthFullNote')}</span>
          </label>
          <label className="set-option">
            <input
              type="radio"
              name="width"
              checked={width === 'fixed'}
              onChange={() => onChangeWidth('fixed')}
            />
            <span>{t('settings.widthFixed')}</span>
            <span className="set-scheme">{t('settings.widthFixedNote')}</span>
          </label>
        </div>

        <div className="set-label">{t('settings.editor')}</div>
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
            <span>{t('settings.customScheme')}</span>
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
            <span>{t('settings.osDefault')}</span>
            <span className="set-scheme">{t('settings.osDefaultNote')}</span>
          </label>
        </div>

        <div className="btns">
          <button className="pbtn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="pbtn primary" onClick={save}>
            {t('settings.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
