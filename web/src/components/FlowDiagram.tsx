import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import { flowSkill, type SkillFlow } from '../api';
import { buildFlowGraph, type FlowGraph, type FlowNode } from '../flowgraph';
import type { FlatItem } from '../util';
import { t } from '../i18n';
import { InlineError, InlineNote } from './Inline';

/*
 * AI フロー図解(詳細画面の「フロー」タブ本体)。
 * キャッシュ済みフロー(it.aiFlow)があれば flowgraph.ts でグラフに写像し、
 * フローチャート(中央=本線 / 左=ループ / 右=中断)として描画する。
 * 無ければ説明 + 抽出ボタンを出す(diagnose の DiagnosisBlock と同じオンデマンド構成)。
 * 描画は zero-dep: ノードは CSS、配線はノード位置を実測して自前 SVG で引く。
 */
export function FlowSection({
  it,
  resolve,
  aiAvailable,
  onOpen,
  reload,
}: {
  it: FlatItem;
  /* calls 内の名前を既知アイテムに解決する(OverviewTab の関連スキルと同じ規則) */
  resolve: (name: string) => FlatItem | undefined;
  /* claude CLI があるか。無ければ抽出ボタンは押せない(起動時に 1 回だけ検出した結果) */
  aiAvailable: boolean;
  onOpen: (key: string) => void;
  reload: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const flow = it.aiFlow;

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      await flowSkill(it.path, it.name);
      await reload();
    } catch (e) {
      setError(t('alert.flowFailed', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flow-tab">
      {flow ? (
        <FlowChart flow={flow} resolve={resolve} onOpen={onOpen} />
      ) : (
        <p className="full-desc">{t('flow.emptyHint')}</p>
      )}
      <button
        className="pbtn sm"
        disabled={busy || !aiAvailable}
        onClick={run}
        title={t('flow.runTitle')}
      >
        {busy ? t('flow.running') : flow ? t('flow.rerun') : '✦ ' + t('flow.run')}
      </button>
      <InlineError msg={error} />
      {!aiAvailable && <InlineNote msg={t('ai.unavailable')} />}
    </div>
  );
}

/* ── フローチャート描画 ── */

/* 配線は種類を破線パターンで分け、色は無彩色(テーマのトークンに追随) */
const WIRE = {
  seq: { stroke: 'var(--border-strong)', label: 'var(--sub)', dash: '' },
  loop: { stroke: 'var(--border-strong)', label: 'var(--sub)', dash: '5 4' },
  exit: { stroke: 'var(--border-strong)', label: 'var(--sub)', dash: '2 3' },
} as const;
/* SVG ラベルの縁取り(ペイン背景色)。文字が線に重なっても読めるようにする */
const HALO = 'var(--bg)';

function FlowChart({
  flow,
  resolve,
  onOpen,
}: {
  flow: SkillFlow;
  resolve: (name: string) => FlatItem | undefined;
  onOpen: (key: string) => void;
}) {
  const graph = buildFlowGraph(flow, {
    yes: t('flow.yes'),
    no: t('flow.no'),
    done: t('flow.done'),
  });
  const wrap = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const nodeEls = useRef<Record<string, HTMLElement | null>>({});
  const ref = (id: string) => (el: HTMLElement | null) => {
    nodeEls.current[id] = el;
  };

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const redraw = () => drawWires(el, svgRef.current, nodeEls.current, graph);
    redraw();
    const ro = new ResizeObserver(redraw);
    ro.observe(el);
    return () => ro.disconnect();
    // graph は flow(と言語)からの純関数なので flow だけ見れば足りる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow]);

  return (
    <div className="fc-scroll">
      <div className="fc" ref={wrap}>
        <svg className="fc-wires" ref={svgRef} aria-hidden="true" />
        {graph.rows.map((row) => (
          <Fragment key={row.node.id}>
            <div className="fc-l" />
            <div className="fc-m">
              <Node node={row.node} refFor={ref} resolve={resolve} onOpen={onOpen} />
            </div>
            <div className="fc-r">
              {row.term && (
                <span ref={ref(row.term.id)} className="fc-term abort">
                  {row.term.label}
                </span>
              )}
            </div>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function Node({
  node,
  refFor,
  resolve,
  onOpen,
}: {
  node: FlowNode;
  refFor: (id: string) => (el: HTMLElement | null) => void;
  resolve: (name: string) => FlatItem | undefined;
  onOpen: (key: string) => void;
}) {
  if (node.kind === 'start') return <span ref={refFor(node.id)} className="fc-start" />;
  if (node.kind === 'end')
    return (
      <span ref={refFor(node.id)} className="fc-term done">
        {node.label}
      </span>
    );
  if (node.kind === 'dec')
    return (
      <div ref={refFor(node.id)} className="fc-dec">
        <div className="fc-shape" />
        <div className="fc-q">{node.when}</div>
      </div>
    );
  const s = node.step;
  return (
    <div ref={refFor(node.id)} className={'fc-proc' + (s.gate === 'human' ? ' human' : '')}>
      <div className="fc-head">
        <span className="fc-num">{node.index + 1}</span>
        <span className="fc-title">{s.title}</span>
        {s.gate === 'human' && <span className="fc-gate">👤 {t('flow.gateHuman')}</span>}
      </div>
      {s.detail && <div className="fc-detail">{s.detail}</div>}
      {s.calls.length > 0 && (
        <div className="fc-calls">
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
    </div>
  );
}

/* ── 配線: ノード実測 → SVG(直進 / ループ / 脱出 + 矢頭 + ラベル)── */

const NS = 'http://www.w3.org/2000/svg';

/* fill / stroke は var() を確実に解決させるため属性でなく style に当てる */
const STYLE_KEYS = new Set(['fill', 'stroke']);
function mk(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (STYLE_KEYS.has(k)) el.style.setProperty(k, v);
    else el.setAttribute(k, v);
  }
  return el;
}

function arrow(svg: SVGSVGElement, x: number, y: number, dir: 'down' | 'right', color: string) {
  const d =
    dir === 'down'
      ? `M ${x - 4} ${y - 6} L ${x + 4} ${y - 6} L ${x} ${y} Z`
      : `M ${x - 6} ${y - 4} L ${x - 6} ${y + 4} L ${x} ${y} Z`;
  svg.appendChild(mk('path', { d, fill: color }));
}

function label(
  svg: SVGSVGElement,
  x: number,
  y: number,
  text: string,
  color: string,
  anchor: 'start' | 'middle' | 'end',
) {
  if (!text) return;
  const el = mk('text', {
    x: String(x),
    y: String(y),
    fill: color,
    'text-anchor': anchor,
    'font-size': '10.5',
    'font-weight': '700',
    stroke: HALO,
    'stroke-width': '3',
    'paint-order': 'stroke',
  });
  el.textContent = text.length > 14 ? text.slice(0, 13) + '…' : text;
  svg.appendChild(el);
}

function drawWires(
  container: HTMLElement,
  svg: SVGSVGElement | null,
  els: Record<string, HTMLElement | null>,
  graph: FlowGraph,
) {
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const mr = container.getBoundingClientRect();
  const box = (id: string) => {
    const n = els[id];
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return {
      l: r.left - mr.left,
      t: r.top - mr.top,
      b: r.top - mr.top + r.height,
      w: r.width,
      cx: r.left - mr.left + r.width / 2,
      cy: r.top - mr.top + r.height / 2,
    };
  };
  let loopK = 0;
  for (const e of graph.edges) {
    const a = box(e.from);
    const b = box(e.to);
    if (!a || !b) continue;
    const c = WIRE[e.type];
    if (e.type === 'seq') {
      svg.appendChild(
        mk('path', {
          d: `M ${a.cx} ${a.b} V ${b.t - 1}`,
          stroke: c.stroke,
          'stroke-width': '1.6',
          fill: 'none',
        }),
      );
      arrow(svg, b.cx, b.t - 1, 'down', c.stroke);
      label(svg, a.cx + 9, a.b + 15, e.label, c.label, 'start');
    } else if (e.type === 'exit') {
      svg.appendChild(
        mk('path', {
          d: `M ${a.l + a.w} ${a.cy} H ${b.l - 1}`,
          stroke: c.stroke,
          'stroke-width': '1.6',
          fill: 'none',
          'stroke-dasharray': c.dash,
        }),
      );
      arrow(svg, b.l - 1, a.cy, 'right', c.stroke);
      label(svg, (a.l + a.w + b.l) / 2, a.cy - 7, e.label, c.label, 'middle');
    } else {
      /* loop: 発生元ひし形の左頂点 → 左レーン → 行き先処理ノードの左辺(スキップも同経路) */
      const lx = 26 - (loopK % 3) * 12;
      loopK++;
      const r = 7;
      const sy = a.cy;
      const ty = b.cy;
      const up = ty < sy ? -1 : 1;
      svg.appendChild(
        mk('path', {
          d:
            `M ${a.l} ${sy} H ${lx + r}` +
            ` Q ${lx} ${sy} ${lx} ${sy + up * r}` +
            ` V ${ty - up * r}` +
            ` Q ${lx} ${ty} ${lx + r} ${ty}` +
            ` H ${b.l - 1}`,
          stroke: c.stroke,
          'stroke-width': '1.6',
          fill: 'none',
          'stroke-dasharray': c.dash,
        }),
      );
      arrow(svg, b.l - 1, ty, 'right', c.stroke);
      label(svg, a.l - 8, sy - 7, e.label, c.label, 'end');
    }
  }
}
