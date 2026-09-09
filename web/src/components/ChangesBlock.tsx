/*
 * ホーム ①「増えた・変わった」。前回の既読(スナップショット)からの差分を GitHub の diff 文法で出す
 * (design-system 0.3): 左端に固定幅の記号(+ / ~ / −)、増えた行だけ 3px のガター。
 * 色は記号とガターにだけ付け、行・チップ・地は塗らない。
 * skill / command / agent に加え memory / CLAUDE.md の変化も同じ列に並ぶ(計画 15 C1)。
 * 「誰が・いつ」は project 出所で git が引けた項目にだけ付き、無ければ更新日だけ(README 6.3)。
 * 差分が無ければ「変化なし」の 1 行に畳む。「既読にする」は既存の /api/changes-ack。
 */

import { useState } from 'react';
import { ackChanges, itemKey, type SkillsData } from '../api';
import {
  changeRows,
  changedProjectCount,
  relTimeLabel,
  type ChangeRow as Row,
  type ProjectSel,
} from '../util';
import { t } from '../i18n';
import { InlineError } from './Inline';
import { InvPill, KindPill, Mark, SourcePill } from './Rows';

function WhoWhen({ r }: { r: Row }) {
  const when = relTimeLabel(r.when);
  if (!when) return null;
  return (
    <>
      {r.entry.author ? r.entry.author + ' · ' : ''}
      {when}
    </>
  );
}

function ChangeRow({
  r,
  onOpen,
  onOpenMemory,
}: {
  r: Row;
  onOpen: (key: string) => void;
  onOpenMemory: (path: string) => void;
}) {
  const e = r.entry;
  const del = r.mark === 'del';
  // 消えたものと CLAUDE.md(E2 で画面が付く)は開けない
  const open =
    !del && r.item
      ? e.kind === 'memory'
        ? () => onOpenMemory(e.path)
        : () => onOpen(itemKey(r.item!))
      : undefined;
  const Tag = open ? 'button' : 'div';
  const who = <WhoWhen r={r} />;
  return (
    <Tag className={'chg-row ' + r.mark} onClick={open}>
      {r.mark === 'add' && <span className="gutter" />}
      <Mark mark={r.mark} />
      <span className="cell">
        <span className="nm">{e.name}</span>
        <span className="desc">
          {del ? t('chg.removed') : r.item?.description || ''}
          {/* 幅 1280 未満では「誰が・いつ」の列を落として説明の末尾へ(0.8) */}
          {r.when ? <span className="who-inline"> · {who}</span> : null}
        </span>
      </span>
      <span>
        <KindPill kind={e.kind} />
      </span>
      <span>
        <SourcePill source={e.source} label={r.scopeLabel} />
      </span>
      <span>
        {e.kind === 'memory' ? (
          <span className="meta nowrap">{t('chg.byClaude')}</span>
        ) : r.item && e.kind !== 'claude-md' ? (
          <InvPill it={r.item} />
        ) : null}
      </span>
      <span className="meta num c-who">{who}</span>
    </Tag>
  );
}

export function ChangesBlock({
  data,
  project,
  onOpen,
  onOpenMemory,
  reload,
}: {
  data: SkillsData;
  project: ProjectSel;
  onOpen: (key: string) => void;
  onOpenMemory: (path: string) => void;
  reload: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const rows = changeRows(data, project);
  const onAck = async () => {
    setBusy(true);
    setError('');
    try {
      await ackChanges();
      await reload();
    } catch (e) {
      setError(t('alert.ackFailed', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };
  const countLabel =
    project === 'all'
      ? t('chg.countProjects', { n: rows.length, p: changedProjectCount(rows) })
      : t('chg.count', { n: rows.length });
  return (
    <section className="blk">
      <div className="blk-hd">
        <h2>{t('chg.title')}</h2>
        {rows.length > 0 && <span className="pill">{countLabel}</span>}
        {/* 起点は前回「既読にする」を押した時刻。古い基準には無いので省略される */}
        {rows.length > 0 && data.changes?.since && (
          <span className="meta">
            {t('chg.since', { d: relTimeLabel(Date.parse(data.changes.since)) })}
          </span>
        )}
        <span className="hd-r">
          <InlineError msg={error} />
          {data.changes && (
            <button className="btn" disabled={busy} onClick={onAck} title={t('chg.ackTitle')}>
              {t('chg.ack')}
            </button>
          )}
        </span>
      </div>
      <div className="blk-body chg-body">
        {rows.length === 0 ? (
          <div className="chg-none meta">{t('chg.none')}</div>
        ) : (
          rows.map((r) => (
            <ChangeRow
              key={r.mark + ':' + r.entry.kind + ':' + r.entry.path}
              r={r}
              onOpen={onOpen}
              onOpenMemory={onOpenMemory}
            />
          ))
        )}
      </div>
    </section>
  );
}
