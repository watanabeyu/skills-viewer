/*
 * 理解画面の「発動」(README 6.2 / S2)。起点(実測 → AI 推定)・呼び方・自動発動・description の
 * 機械判定(lint)を上から並べ、AI 発動診断と指示文は最後の行に畳む。判定が weak のときだけ
 * 最初から指示文を開く。viewer は description を書き換えないので(計画 15 判断 1)、結果は
 * 「貼れる指示文」(util.ts の diagnosisInstruction: 事実ヘッダ + 本文 + 末尾の確認手順)を全文で出す。
 * 寸法は docs/design/0.9.0/*Understand.dc.html の kv(--kv-* トークン)。
 */

import { useEffect, useState } from 'react';
import { diagnoseSkill, type SkillsData } from '../api';
import { diagnosisInstruction, invocationOf, usageLine, type FlatItem } from '../util';
import { lintLabel, t } from '../i18n';
import { CopyButton, InlineError, InlineNote } from './Inline';
import { InvPill } from './Rows';

export function InvokeBlock({
  it,
  dir,
  data,
  reload,
}: {
  it: FlatItem;
  /* 指示文の事実ヘッダに出す置き場の実体パス(Section.note) */
  dir: string;
  data: SkillsData;
  reload: () => Promise<void>;
}) {
  const inv = invocationOf(it);
  const typed = it.typedCount || 0;
  const auto = it.autoCount || 0;
  const usage = usageLine(it);
  const lint = it.lint || [];
  const trigger = !lint.includes('no-trigger') && !lint.includes('no-description');
  const descNote = [
    t('inv.lintN', { n: lint.length }),
    t(trigger ? 'inv.trigYes' : 'inv.trigNo'),
    it.tokens ? t('act.tok', { n: it.tokens.toLocaleString() }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <section className="dblk">
      <div className="dblk-hd">
        <h2>{t('inv.title')}</h2>
      </div>
      <div className="kv">
        <span className="k">{t('inv.trigger')}</span>
        <span>
          <InvPill it={it} />
          {it.hidden ? null : inv?.basis === 'measured' ? (
            <span className="meta">{t('inv.measuredNote', { typed, auto })}</span>
          ) : inv?.basis === 'ai' ? (
            <span className="meta">{it.aiInvocationReason}</span>
          ) : (
            <span className="meta">{t('inv.unknown')}</span>
          )}
        </span>
        {usage && (
          <>
            <span className="k">{t('inv.usage')}</span>
            <span className="mono v-mono">{usage}</span>
          </>
        )}
        <span className="k">{t('inv.auto')}</span>
        <span className="v-text">{t(it.hidden ? 'inv.autoNone' : 'inv.autoDefault')}</span>
        <span className="k">{t('inv.desc')}</span>
        <span className="v-col">
          <span className="v-line">
            {it.hidden ? (
              <span className="meta">{t('inv.descHidden')}</span>
            ) : lint.length ? (
              <span className="warn v-verdict">{t('inv.unlikely')}</span>
            ) : (
              <span className="good v-verdict">{t('inv.likely')}</span>
            )}
            <span className="meta">{descNote}</span>
          </span>
          {lint.map((code) => (
            <span className="lint-row" key={code}>
              <span className="lint-mark">⚠</span>
              <span>{lintLabel(code)}</span>
            </span>
          ))}
        </span>
        {it.hasMd && (
          <>
            <span className="k">{t('inv.diag')}</span>
            <span className="v-col v-diag">
              <DiagnosisRow it={it} dir={dir} aiAvailable={data.aiAvailable} reload={reload} />
            </span>
          </>
        )}
      </div>
    </section>
  );
}

function DiagnosisRow({
  it,
  dir,
  aiAvailable,
  reload,
}: {
  it: FlatItem;
  dir: string;
  aiAvailable: boolean;
  reload: () => Promise<void>;
}) {
  const d = it.aiDiagnosis;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // 判定が weak のときだけ最初から開く(README 6.2)。再診断で判定が変わればそれに追随する
  const [open, setOpen] = useState(d?.verdict === 'weak');
  useEffect(() => setOpen(d?.verdict === 'weak'), [d]);
  const instruction = d ? diagnosisInstruction(it, dir) : '';

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      await diagnoseSkill(it.path, it.name);
      await reload();
    } catch (e) {
      setError(t('alert.diagnoseFailed', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {d ? (
        <span className={'v-line diag-sum ' + d.verdict}>
          <span className={d.verdict === 'good' ? 'good' : 'warn'}>
            {t(d.verdict === 'good' ? 'diag.verdict.good' : 'diag.verdict.weak')}
          </span>
          {d.issues.length > 0 && <span className="sub">{d.issues.join(' / ')}</span>}
        </span>
      ) : (
        <span className="meta">{t('diag.none')}</span>
      )}
      <span className="v-line diag-tools">
        {d && <span className="meta grow">{t('diag.note')}</span>}
        {d && <CopyButton className="btn sm" text={instruction} label={t('diag.copy')} />}
        <button
          className="btn sm"
          disabled={busy || !aiAvailable}
          onClick={run}
          title={t('diag.runTitle')}
        >
          {busy ? t('diag.running') : d ? t('diag.rerun') : '✦ ' + t('diag.run')}
        </button>
        {d && (
          <button className="btn sm quiet" onClick={() => setOpen((v) => !v)}>
            {open ? t('diag.hide') : t('diag.show')}
          </button>
        )}
        <InlineError msg={error} />
        {!aiAvailable && <InlineNote msg={t('ai.unavailable')} />}
      </span>
      {d && open && <Instruction text={instruction} />}
    </>
  );
}

/* 指示文の全文。先頭の事実ヘッダ(機械生成)だけ補足色にして、本文と見分けがつくようにする */
export function Instruction({ text }: { text: string }) {
  const cut = text.indexOf('\n\n');
  const head = cut > 0 ? text.slice(0, cut) : '';
  const body = cut > 0 ? text.slice(cut) : text;
  return (
    <pre className="instr-pre">
      {head && <span className="meta">{head}</span>}
      {body}
    </pre>
  );
}
