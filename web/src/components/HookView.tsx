/*
 * hook の理解画面(簡易版。README 6.2「いつ何が走るか」)。hook は設定エントリなので
 * description の注入・使用実績・フロー図を持たない。出すのは:
 *   事実の帯(イベントと matcher / 場所 / 追加・更新 / コンテキストへの寄与)
 *   → コマンド → 同じセッションで走る hook の一覧。
 * 寸法は docs/design/0.9.0/{Ledger,Console}Hook.dc.html の実測(--hook-* トークン)。
 */

import type { SkillsData } from '../api';
import { hookParts, shortPath } from '../detail';
import { selectedSection, sessionSections, type FlatItem } from '../util';
import { DICTS, t, type MsgKey } from '../i18n';
import { FactCell, HistoryLines } from './FactsBand';
import { SourcePill } from './Rows';

/* イベント名の注記。既知のイベントだけ言い分け、それ以外は「イベント X で走る」 */
function eventNote(event: string): string {
  const key = ('hook.ev.' + event) as MsgKey;
  return key in DICTS.en ? t(key) : t('hook.ev.other', { event });
}

export function HookView({
  it,
  data,
  all,
  onOpen,
}: {
  it: FlatItem;
  data: SkillsData;
  all: FlatItem[];
  onOpen: (key: string) => void;
}) {
  const { event, matcher } = hookParts(it.name);
  const sec = data.sections.find((s) => s.id === it.secId);
  /*
   * 「同じセッション」= この hook のプロジェクト + user + plugin + built-in。
   * user / plugin の hook は特定のプロジェクトに属さないので、単位は cwd ではなく
   * 「選んだプロジェクト」に揃える(計画 16 判断 1。ホーム ③ と同じ母集団)
   */
  const project = sec?.source === 'project' ? sec : selectedSection(data);
  const ids = new Set(sessionSections(data.sections, project).map((s) => s.id));
  const hooks = all.filter((x) => x.kind === 'hook' && ids.has(x.secId));
  const where =
    it.source === 'user'
      ? t('hook.locUser')
      : it.source === 'project'
        ? t('hook.locProject', { name: it.scopeLabel })
        : t('hook.locOther', { source: it.source });
  return (
    <>
      <div className="dblk facts">
        <FactCell label={t('hook.event')}>
          <span className="fv mono">{event}</span>
          <span className="meta">
            {t('hook.matcher', { m: '' })}
            <span className="mono">{matcher || '—'}</span>
          </span>
        </FactCell>
        <FactCell label={t('hook.location')}>
          <span className="fv-path mono ellip" title={it.path}>
            {shortPath(it.path, data.cwd, data.home)}
          </span>
          <span className="meta">{where}</span>
        </FactCell>
        <FactCell label={t('fact.history')}>
          <HistoryLines it={it} changes={data.changes} />
        </FactCell>
        <FactCell label={t('hook.context')}>
          <span className="fv-sub">{t('hook.ctxNone')}</span>
          <span className="meta">{t('hook.ctxNote')}</span>
        </FactCell>
      </div>
      <section className="dblk">
        <div className="dblk-hd">
          <h2>{t('hook.command')}</h2>
          <span className="meta">{eventNote(event)}</span>
        </div>
        <pre className="hook-cmd mono">{it.description}</pre>
      </section>
      <section className="dblk">
        <div className="dblk-hd">
          <h2>{t('hook.session')}</h2>
          <span className="meta num">{hooks.length}</span>
        </div>
        <div className="hrow thead">
          <span>{t('hook.event')}</span>
          <span>{t('hook.colMatcher')}</span>
          <span>{t('hook.colCommand')}</span>
          <span>{t('col.source')}</span>
        </div>
        {hooks.map((h) => {
          const p = hookParts(h.name);
          const cur = h.key === it.key;
          return (
            <button
              key={h.key}
              className={'hrow' + (cur ? ' cur' : '')}
              onClick={() => onOpen(h.key)}
              aria-current={cur ? 'page' : undefined}
            >
              <span className="hname">{p.event}</span>
              <span className="mono meta">{p.matcher || '—'}</span>
              <span className="hcmd mono">{h.description}</span>
              <span>
                <SourcePill source={h.source} label={h.scopeLabel} />
              </span>
            </button>
          );
        })}
      </section>
    </>
  );
}
