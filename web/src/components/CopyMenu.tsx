import { useEffect, useRef } from 'react';
import type { CopyTarget } from '../api';
import { t } from '../i18n';

export function CopyMenu({
  targets,
  onPick,
  onClose,
}: {
  targets: CopyTarget[];
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    // メニューを開いたクリック自体で閉じないよう次フレームで登録
    const t = window.setTimeout(() => document.addEventListener('click', handler), 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('click', handler);
    };
  }, [onClose]);

  return (
    <div className="drop" ref={ref}>
      <div className="dh">{t('copy.header')}</div>
      {targets.map((t) => (
        <button className="di" key={t.path} onClick={() => onPick(t.path)}>
          <div className="l1">{t.label}</div>
          <div className="l2">{t.sub}</div>
        </button>
      ))}
    </div>
  );
}
