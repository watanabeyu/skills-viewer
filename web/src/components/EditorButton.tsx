/*
 * 「エディタで開く」の状態(openError)・ハンドラ・ボタン markup。理解画面 / CLAUDE.md 画面 /
 * memory 一覧・詳細の 4 箇所で同型だった(違いは開くパスだけ)ため 1 箇所にまとめた。
 * InlineError の設置位置は呼び出し側に委ねる(useOpenEditor はメッセージを返すだけ)。
 * DetailView は AI 要約の失敗メッセージより先に openError を出しており、その並びは画面ごとに
 * 保つ必要があるため、状態・ハンドラ(hook)と markup(button)を分けている。
 */

import { useState } from 'react';
import { openSkill } from '../api';
import { editorUrl, loadEditorSetting } from '../settings';
import { t } from '../i18n';

function EditorIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M6 3H3v10h10v-3M9 3h4v4M13 3L7 9" />
    </svg>
  );
}

/*
 * 設定(⚙)の URL スキームで開く。OS デフォルト設定時のみサーバー側で開く。
 * path が空のときは呼び出し側がボタンごと出さない前提(built-in など開けない項目の扱いを踏襲)なので、
 * ここでは path の空チェックはしない。
 * selected は選んでいるプロジェクト(SkillsData.selected.id)。サーバー側で開く経路も
 * 読み取り許可(cwd + 選んだプロジェクト)に乗るので必ず送る(計画 16)。
 */
export function useOpenEditor(path: string, selected: string) {
  // 操作起点の失敗はボタンの脇に 1 行で出す(alert は使わない)
  const [openError, setOpenError] = useState('');
  const onOpenEditor = async () => {
    setOpenError('');
    const url = editorUrl(loadEditorSetting(), path);
    if (url) {
      window.location.href = url;
      return;
    }
    try {
      await openSkill(path, selected);
    } catch (e) {
      setOpenError(t('alert.openFailed', { msg: e instanceof Error ? e.message : String(e) }));
    }
  };
  return { openError, onOpenEditor };
}

/* ボタンの markup(アイコン + ラベル)だけの部品。表示可否・イベントハンドラは呼び出し側から渡す */
export function EditorButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="btn" onClick={onClick}>
      <EditorIcon />
      {t('detail.openEditor')}
    </button>
  );
}
