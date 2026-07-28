import { useEffect, useRef } from 'react';
import { t } from '../i18n';

/*
 * ヘッダーの「✦ AI」ドロップダウン。AI 要約(summarize-all)と用途グルーピングの
 * 2 操作を集約する(CopyMenu と同じ開閉パターン)。行を選ぶとメニューを閉じて実行する。
 */
export function AiMenu({
  summaryLabel,
  summaryBusy,
  onSummarize,
  groupLabel,
  groupBusy,
  groupStale,
  onGroups,
  onClose,
}: {
  summaryLabel: string;
  summaryBusy: boolean;
  onSummarize: () => void;
  groupLabel: string;
  groupBusy: boolean;
  groupStale: boolean;
  onGroups: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    // メニューを開いたクリック自体で閉じないよう次フレームで登録
    const timer = window.setTimeout(() => document.addEventListener('click', handler), 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('click', handler);
    };
  }, [onClose]);

  const pick = (fn: () => void) => {
    onClose();
    fn();
  };

  return (
    <div className="drop" ref={ref}>
      <button className="di" disabled={summaryBusy} onClick={() => pick(onSummarize)}>
        <div className="l1">{summaryLabel}</div>
        <div className="l2">{t('ai.buttonTitle')}</div>
      </button>
      <button className="di" disabled={groupBusy} onClick={() => pick(onGroups)}>
        <div className="l1">
          {groupBusy ? t('group.generating') : (groupStale ? '⚠ ' : '') + groupLabel}
        </div>
        <div className="l2">{groupStale ? t('group.stale') : t('group.generateTitle')}</div>
      </button>
    </div>
  );
}
