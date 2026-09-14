/*
 * 画面に居座らない小さな共通部品。
 *
 * v0.9.0 でブラウザの alert ダイアログを全廃したので(計画 15 Phase B)、
 * 操作起点の失敗は押したボタンの脇に 1 行で出す。置き場所は 2 通りで、
 *   - 操作起点(AI 生成・エディタ起動・既読・コピー) → ここの InlineError をボタンの隣に
 *   - 画面全体の失敗(app.loadFailed) → 既存の全画面表示(App.tsx の .empty)
 * InlineNote は失敗ではない注記(claude CLI 不在など)用で、色だけが違う。
 */

import { useEffect, useState } from 'react';
import { copyText } from '../util';
import { t } from '../i18n';

/* 直前の操作が失敗したことを示す 1 行。msg が空なら何も描かない */
export function InlineError({ msg }: { msg: string }) {
  if (!msg) return null;
  return (
    <span className="inline-msg err" role="alert">
      ⚠ {msg}
    </span>
  );
}

/* 押せない理由・前提の注記(失敗ではないので警告色にしない) */
export function InlineNote({ msg }: { msg: string }) {
  if (!msg) return null;
  return <span className="inline-msg note">{msg}</span>;
}

/*
 * 指示文をクリップボードへ。成功は 2 秒だけラベルで、失敗はボタンの隣に 1 行で返す
 * (コピーは指示文を渡す唯一の手段なので、黙って失敗させない)。
 */
export function CopyButton({
  text,
  label,
  className,
}: {
  text: string;
  label?: string;
  className: string;
}) {
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  // コピー成功のフィードバックは 2 秒でラベルを戻す
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setDone(false), 2000);
    return () => window.clearTimeout(timer);
  }, [done]);
  const onClick = async () => {
    setError('');
    try {
      await copyText(text);
      setDone(true);
    } catch (e) {
      setError(t('alert.copyFailed', { msg: e instanceof Error ? e.message : String(e) }));
    }
  };
  return (
    <>
      <button className={className} onClick={onClick}>
        {done ? t('memory.triage.copied') : label || t('memory.triage.copy')}
      </button>
      <InlineError msg={error} />
    </>
  );
}
