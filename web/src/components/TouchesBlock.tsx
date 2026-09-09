/*
 * 理解画面の「触るもの」(設計判断 #12)。機械情報を先に出し、AI は追加で並べる:
 *   委譲先 = refs(本文からの静的抽出)+ aiRelations(あれば ✦)
 *   使うツール = frontmatter の allowed-tools(無ければ「指定なし(全ツール)」)
 *   書き込み / 外部 = allowed-tools に Write / Edit / Bash / WebFetch があるかの機械判定。
 *   aiFlow があるときだけ、抽出された外部ツール名(未知の calls)を ✦ で添える
 */

import { delegatesOf, makeResolve, touchesOf } from '../detail';
import type { FlatItem } from '../util';
import { relTypeLabel, t } from '../i18n';

export function TouchesBlock({
  it,
  all,
  onOpen,
}: {
  it: FlatItem;
  all: FlatItem[];
  onOpen: (key: string) => void;
}) {
  const resolve = makeResolve(it, all);
  const delegates = delegatesOf(it);
  const touch = touchesOf(it.allowedTools);
  // フロー抽出が挙げた呼び出し先のうち既知の skill に解決できないもの(gw・gh など外部のツール)
  const aiCalls = it.aiFlow
    ? [...new Set(it.aiFlow.steps.flatMap((s) => s.calls).map((c) => c.replace(/^\//, '')))].filter(
        (name) => !resolve(name),
      )
    : [];
  const yesNo = (list: string[]) =>
    !touch.tools
      ? t('touch.unknown')
      : list.length
        ? t('touch.yes', { list: list.join(', ') })
        : t('touch.no');
  return (
    <section className="dblk">
      <div className="dblk-hd">
        <h2>{t('touch.title')}</h2>
      </div>
      <div className="kv">
        <span className="k">{t('touch.delegates')}</span>
        <span className="v-wrap">
          {delegates.length ? (
            delegates.map((d) => {
              const target = resolve(d.name);
              const title = [relTypeLabel(d.type), d.note].filter(Boolean).join(' · ');
              return (
                <span className="v-del" key={d.name} title={title}>
                  {target ? (
                    <button className="link" onClick={() => onOpen(target.key)}>
                      {d.name}
                    </button>
                  ) : (
                    <span className="sub">{d.name}</span>
                  )}
                  <span className="meta">
                    {target ? target.kind : t('detail.notInstalled')}
                    {d.ai ? ' ✦' : ''}
                  </span>
                </span>
              );
            })
          ) : (
            <span className="meta">{t('touch.none')}</span>
          )}
        </span>
        <span className="k">{t('touch.tools')}</span>
        {touch.tools ? (
          <span className="mono v-mono">{touch.tools.join(' · ')}</span>
        ) : (
          <span className="meta">{t('touch.toolsAll')}</span>
        )}
        <span className="k">{t('touch.writes')}</span>
        <span className="v-text">{yesNo(touch.writes)}</span>
        <span className="k">{t('touch.external')}</span>
        <span className="v-text">
          {yesNo(touch.external)}
          {aiCalls.length > 0 && (
            <span className="sub">
              <span className="ai-mark">✦ </span>
              {aiCalls.join(' · ')}
            </span>
          )}
        </span>
      </div>
    </section>
  );
}
