import { useState } from 'react';
import {
  AI_MODELS,
  EDITOR_PRESETS,
  THEME_PREFS,
  applyTheme,
  loadAiModel,
  loadEditorSetting,
  loadThemePref,
  resolveTheme,
  saveAiModel,
  saveEditorSetting,
  saveThemePref,
  type AiModel,
  type EditorSetting,
  type ThemePref,
} from '../settings';
import { t, type Lang, type MsgKey } from '../i18n';

const LANGS: [Lang, string][] = [
  ['ja', '日本語'],
  ['en', 'English'],
];

/* テーマの選択肢のラベルと 1 行説明(キーは i18n の settings.theme* に揃える) */
const THEME_LABEL: Record<ThemePref, [MsgKey, MsgKey]> = {
  auto: ['settings.themeAuto', 'settings.themeAutoNote'],
  console: ['settings.themeConsole', 'settings.themeConsoleNote'],
  ledger: ['settings.themeLedger', 'settings.themeLedgerNote'],
};

export function SettingsModal({
  lang,
  onChangeLang,
  onClose,
}: {
  lang: Lang;
  onChangeLang: (l: Lang) => void;
  onClose: () => void;
}) {
  const [setting, setSetting] = useState<EditorSetting>(loadEditorSetting);
  const [aiModel, setAiModel] = useState<AiModel>(loadAiModel);
  const [themePref, setThemePref] = useState<ThemePref>(loadThemePref);
  /* 言語と同じく即時反映(保存を待たない)。見た目の切替は選んだ瞬間に確かめたいため */
  const changeTheme = (p: ThemePref) => {
    setThemePref(p);
    saveThemePref(p);
    applyTheme(resolveTheme(p));
  };

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

        <div className="set-label">{t('settings.theme')}</div>
        <div className="set-options">
          {THEME_PREFS.map((p) => (
            <label key={p} className="set-option">
              <input
                type="radio"
                name="theme"
                checked={themePref === p}
                onChange={() => changeTheme(p)}
              />
              <span>{t(THEME_LABEL[p][0])}</span>
              <span className="set-scheme">{t(THEME_LABEL[p][1])}</span>
            </label>
          ))}
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
