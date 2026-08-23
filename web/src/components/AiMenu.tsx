import { useEffect, useRef } from 'react';
import { t } from '../i18n';

/*
 * ヘッダーの「✦ AI」ドロップダウン。AI 要約(summarize-all)・用途グルーピング・
 * memory 棚卸しを集約する(CopyMenu と同じ開閉パターン)。行を選ぶとメニューを閉じて実行する。
 * 棚卸しは現在のプロジェクトに memory がある場合だけ出す(無ければ項目ごと出さない)。
 */
export function AiMenu({
  summaryLabel,
  summaryBusy,
  onSummarize,
  groupLabel,
  groupBusy,
  groupStale,
  onGroups,
  memoryCurrentId,
  onTriage,
  onClose,
}: {
  summaryLabel: string;
  summaryBusy: boolean;
  onSummarize: () => void;
  groupLabel: string;
  groupBusy: boolean;
  groupStale: boolean;
  onGroups: () => void;
  /* 現在プロジェクトの MemorySection.id。memory が無いプロジェクトでは undefined */
  memoryCurrentId?: string;
  onTriage: (id: string) => void;
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
      {memoryCurrentId && (
        <button className="di" onClick={() => pick(() => onTriage(memoryCurrentId))}>
          <div className="l1">{t('memory.triage.menu')}</div>
          <div className="l2">{t('memory.triage.menuTitle')}</div>
        </button>
      )}
    </div>
  );
}
