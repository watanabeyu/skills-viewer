import { useState } from 'react';
import {
  AI_MODELS,
  EDITOR_PRESETS,
  loadAiModel,
  loadEditorSetting,
  saveAiModel,
  saveEditorSetting,
  type AiModel,
  type EditorSetting,
} from '../settings';
import { t, type Lang, type MsgKey } from '../i18n';

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
  const [aiModel, setAiModel] = useState<AiModel>(loadAiModel);

  const save = () => {
    if (setting.mode === 'custom' && !(setting.template || '').includes('{path}')) {
      alert(t('settings.customNeedsPath'));
      return;
    }
    saveEditorSetting(setting);
    saveAiModel(aiModel);
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

        <div className="set-label">{t('settings.aiModel')}</div>
        <div className="set-options">
          {AI_MODELS.map((m) => (
            <label key={m} className="set-option">
              <input
                type="radio"
                name="ai-model"
                checked={aiModel === m}
                onChange={() => setAiModel(m)}
              />
              <span>{m}</span>
              <span className="set-scheme">{t(`settings.aiModelNote.${m}` as MsgKey)}</span>
            </label>
          ))}
          <div className="set-note">{t('settings.aiModelHint')}</div>
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
