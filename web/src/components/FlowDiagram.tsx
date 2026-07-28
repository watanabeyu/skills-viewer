import { useState } from 'react';
import { flowSkill, type SkillFlow } from '../api';
import type { FlatItem } from '../util';
import { t } from '../i18n';

/*
 * AI フロー図解(詳細画面の「フロー」タブ本体)。
 * キャッシュ済みフロー(it.aiFlow)があれば縦型ステッパーで描画し、
 * 無ければ説明 + 抽出ボタンを出す(diagnose の DiagnosisBlock と同じオンデマンド構成)。
 * 描画は zero-dep: SVG ライブラリを使わず CSS のボックス + コネクタで組む。
 */
export function FlowSection({
  it,
  resolve,
  onOpen,
  reload,
}: {
  it: FlatItem;
  /* calls 内の名前を既知アイテムに解決する(OverviewTab の関連スキルと同じ規則) */
  resolve: (name: string) => FlatItem | undefined;
  onOpen: (key: string) => void;
  reload: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const flow = it.aiFlow;

  const run = async () => {
    setBusy(true);
    try {
      await flowSkill(it.path, it.name);
      await reload();
    } catch (e) {
      alert(t('alert.flowFailed', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flow-tab">
      {flow ? (
        <FlowDiagram flow={flow} resolve={resolve} onOpen={onOpen} />
      ) : (
        <p className="full-desc">{t('flow.emptyHint')}</p>
      )}
      <button className="pbtn sm" disabled={busy} onClick={run} title={t('flow.runTitle')}>
        {busy ? t('flow.running') : flow ? t('flow.rerun') : '✦ ' + t('flow.run')}
      </button>
    </div>
  );
}

function FlowDiagram({
  flow,
  resolve,
  onOpen,
}: {
  flow: SkillFlow;
  resolve: (name: string) => FlatItem | undefined;
  onOpen: (key: string) => void;
}) {
  return (
    <div className="flow">
      {flow.steps.map((s, i) => (
        <div key={i}>
          <div className={'flow-box' + (s.gate === 'human' ? ' human' : '')}>
            <div className="flow-t">
              <span className="flow-num">{i + 1}</span>
              <span className="flow-title">{s.title}</span>
              {s.gate === 'human' && <span className="flow-gate">👤 {t('flow.gateHuman')}</span>}
            </div>
            {s.detail && <div className="flow-d">{s.detail}</div>}
            {s.calls.length > 0 && (
              <div className="flow-calls">
                {s.calls.map((raw) => {
                  // 抽出結果は「/weall-feature」形式のこともあるので、解決前に / を剥がす
                  const name = raw.replace(/^\//, '');
                  const target = resolve(name);
                  return target ? (
                    <button key={raw} className="rel-chip" onClick={() => onOpen(target.key)}>
                      <span className="rn">/{name}</span>
                    </button>
                  ) : (
                    /* 未知の名前(gw 等の外部ツール)はリンクにしない */
                    <span key={raw} className="rel-chip missing">
                      <span className="rn">{name}</span>
                    </span>
                  );
                })}
              </div>
            )}
            {s.branches.map((b, bi) => (
              <div key={bi} className="flow-branch">
                ↳ {b.when}
                {b.then ? ` ▸ ${b.then}` : ''}
              </div>
            ))}
          </div>
          {i < flow.steps.length - 1 && <div className="flow-conn" />}
        </div>
      ))}
    </div>
  );
}
