/*
 * 「前回の起動から何が変わったか」のバナー。追加・更新はクリックで詳細へ、
 * 削除は名前表示のみ。「既読にする」で現在の状態が次回比較の基準になる。
 */

import { useState } from 'react';
import { ackChanges, type ChangeEntry, type SnapshotChanges } from '../api';
import { t } from '../i18n';

const SHOW_MAX = 8;

function ChangeChips({
  entries,
  label,
  cls,
  onOpen,
}: {
  entries: ChangeEntry[];
  label: string;
  cls: string;
  onOpen?: (key: string) => void;
}) {
  if (!entries.length) return null;
  const shown = entries.slice(0, SHOW_MAX);
  return (
    <span className="chg-group">
      <span className={'chg-label ' + cls}>{label}</span>
      {shown.map((e) =>
        onOpen ? (
          <button key={e.path} className="chg-chip" onClick={() => onOpen(e.path + '#' + e.name)}>
            {e.name}
          </button>
        ) : (
          <span key={e.path} className="chg-chip gone">
            {e.name}
          </span>
        ),
      )}
      {entries.length > SHOW_MAX && (
        <span className="chg-more">{t('changes.more', { n: entries.length - SHOW_MAX })}</span>
      )}
    </span>
  );
}

export function ChangesBanner({
  changes,
  onOpen,
  reload,
}: {
  changes: SnapshotChanges;
  onOpen: (key: string) => void;
  reload: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const onAck = async () => {
    setBusy(true);
    try {
      await ackChanges();
      await reload();
    } catch (e) {
      alert(t('alert.ackFailed', { msg: e instanceof Error ? e.message : String(e) }));
      setBusy(false);
    }
  };
  return (
    <div className="chg-banner">
      <span className="chg-title">{t('changes.title')}</span>
      <ChangeChips
        entries={changes.added}
        label={t('changes.added', { n: changes.added.length })}
        cls="add"
        onOpen={onOpen}
      />
      <ChangeChips
        entries={changes.updated}
        label={t('changes.updated', { n: changes.updated.length })}
        cls="upd"
        onOpen={onOpen}
      />
      <ChangeChips
        entries={changes.removed}
        label={t('changes.removed', { n: changes.removed.length })}
        cls="del"
      />
      <button
        className="pbtn sm chg-ack"
        disabled={busy}
        onClick={onAck}
        title={t('changes.ackTitle')}
      >
        {t('changes.ack')}
      </button>
    </div>
  );
}
