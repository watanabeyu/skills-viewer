/*
 * 理解画面の「流れ」(計画 15 Phase E1 / design-system 0.6)。
 * キャッシュ済みフロー(it.aiFlow)があれば flowgraph.ts でグラフに写像し、標準のフローチャート
 * 記法(start / end = 角丸の横長、proc = 四角、dec = ひし形、条件ラベル、左レーンのループ、
 * 右への中断、human ゲートは人のアイコン、委譲は下線リンク)で描く。判断を「色の違う処理の箱」で
 * 表さない。未生成時は SKILL.md の見出し構造を同じ縦の流れで出す(構造そのもの。✦ なし)。
 * 描画は zero-dep: ノードは CSS、配線はノード位置を実測して自前 SVG で引く。
 * 寸法は docs/design/0.9.0/*Understand.dc.html の SVG 実測: 幅 680、proc 300 × 48、ひし形 200 × 64、
 * 終端 200 × 32(中断 100 × 32)、ノード間 28、ループのレーンは proc の左 60、中断は proc の右 62。
 */

import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import { flowSkill, type SkillFlow } from '../api';
import { buildFlowGraph, type FlowGraph, type FlowNode } from '../flowgraph';
import { mdHeadings, splitFrontmatter } from '../md';
import type { FlatItem } from '../util';
import { t } from '../i18n';
import { InlineError, InlineNote } from './Inline';

export function FlowBlock({
  it,
  raw,
  resolve,
  aiAvailable,
  selected,
  onOpen,
  reload,
}: {
  it: FlatItem;
  /* SKILL.md の生テキスト(未生成時の見出しツリー用)。読み込み中は null */
  raw: string | null;
  /* calls 内の名前を既知アイテムに解決する(触るものの委譲先と同じ規則) */
  resolve: (name: string) => FlatItem | undefined;
  /* claude CLI があるか。無ければ抽出ボタンは押せない(起動時に 1 回だけ検出した結果) */
  aiAvailable: boolean;
  /* 選んでいるプロジェクト(SkillsData.selected.id)。抽出は本文を読むので読み取り許可に乗る */
  selected: string;
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
      await flowSkill(it.path, it.name, selected);
      await reload();
    } catch (e) {
      setError(t('alert.flowFailed', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="dblk">
      <div className="dblk-hd">
        <h2>{t('flow.title')}</h2>
        <span className="meta">{flow ? t('flow.extracted') : t('flow.treeNote')}</span>
        <span className="hd-r">
          <InlineError msg={error} />
          {!aiAvailable && <InlineNote msg={t('ai.unavailable')} />}
          <button
            className="btn"
            disabled={busy || !aiAvailable}
            onClick={run}
            title={t('flow.runTitle')}
          >
            {busy ? t('flow.running') : flow ? t('flow.rerun') : '✦ ' + t('flow.run')}
          </button>
        </span>
      </div>
      {flow ? (
        <div className="fc-body">
          <FlowChart
            flow={flow}
            startLabel={(it.kind === 'agent' ? '@' : '/') + it.name}
            resolve={resolve}
            onOpen={onOpen}
          />
        </div>
      ) : (
        <HeadingTree raw={raw} />
      )}
    </section>
  );
}

/* ── 未生成時: 見出しの木(States モックの「フロー図未生成」) ── */

function HeadingTree({ raw }: { raw: string | null }) {
  if (raw === null) return <div className="tree-row meta">{t('common.loading')}</div>;
  let hs = mdHeadings(splitFrontmatter(raw).body);
  // 文書のタイトル(先頭の唯一の h1)は骨格ではないので落とし、その下の階層を根にする
  if (hs.length > 1 && hs[0].level === 1 && !hs.slice(1).some((h) => h.level === 1)) {
    hs = hs.slice(1);
  }
  if (!hs.length) return <div className="tree-row meta">{t('flow.treeEmpty')}</div>;
  const min = Math.min(...hs.map((h) => h.level));
  return (
    <div className="tree">
      {hs.map((h, i) => {
        const depth = Math.min(h.level - min, 3);
        return (
          <div className={'tree-row d' + depth} key={i}>
            <span className="mono">{(depth ? '├─ ' : '') + h.text}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ── フローチャート描画 ── */

function FlowChart({
  flow,
  startLabel,
  resolve,
  onOpen,
}: {
  flow: SkillFlow;
  startLabel: string;
  resolve: (name: string) => FlatItem | undefined;
  onOpen: (key: string) => void;
}) {
  const graph = buildFlowGraph(flow, {
    yes: t('flow.yes'),
    no: t('flow.no'),
    done: t('flow.end'),
    abort: t('flow.abort'),
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
              <Node
                node={row.node}
                startLabel={t('flow.start', { name: startLabel })}
                refFor={ref}
                resolve={resolve}
                onOpen={onOpen}
              />
            </div>
            <div className="fc-r">
              {row.term && (
                <span ref={ref(row.term.id)} className="fc-cap abort" title={row.term.label}>
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

/* 承認を待つ判断(human ゲート)の印。モックの人のアイコン(丸 + 肩の弧) */
function Person() {
  return (
    <svg
      className="fc-person"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-label={t('flow.gateHuman')}
    >
      <circle cx="8" cy="5" r="3" />
      <path d="M2.5 15c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5" />
    </svg>
  );
}

function Node({
  node,
  startLabel,
  refFor,
  resolve,
  onOpen,
}: {
  node: FlowNode;
  startLabel: string;
  refFor: (id: string) => (el: HTMLElement | null) => void;
  resolve: (name: string) => FlatItem | undefined;
  onOpen: (key: string) => void;
}) {
  if (node.kind === 'start')
    return (
      <span ref={refFor(node.id)} className="fc-cap">
        {startLabel}
      </span>
    );
  if (node.kind === 'end')
    return (
      <span ref={refFor(node.id)} className="fc-cap">
        {node.label}
      </span>
    );
  if (node.kind === 'dec')
    return (
      <div ref={refFor(node.id)} className={'fc-dec' + (node.human ? ' human' : '')}>
        {/* ひし形は SVG(破線の縁取りを CSS の border では出せないため) */}
        <svg
          className="fc-shape"
          viewBox="0 0 200 64"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <polygon points="100,0 200,32 100,64 0,32" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="fc-q">
          {node.human && <Person />}
          <span>{node.when}</span>
        </div>
      </div>
    );
  const s = node.step;
  return (
    <div ref={refFor(node.id)} className="fc-proc">
      <div className="fc-head">
        <span className="fc-title">{s.title}</span>
        {/* 分岐を持たない human ゲート(判断ノードが無い)は処理の箱に印を出す */}
        {s.gate === 'human' && s.branches.length === 0 && <Person />}
      </div>
      {s.detail && <div className="fc-detail">{s.detail}</div>}
      {s.calls.length > 0 && (
        <div className="fc-calls">
          {s.calls.map((raw) => {
            // 抽出結果は「/weall-feature」形式のこともあるので、解決前に / を剥がす
            const name = raw.replace(/^\//, '');
            const target = resolve(name);
            return target ? (
              /* 委譲は下線リンク(本文色)。0.6 */
              <button key={raw} className="link" onClick={() => onOpen(target.key)}>
                {name}
              </button>
            ) : (
              /* 未知の名前(gw 等の外部ツール)はリンクにしない */
              <span key={raw} className="meta">
                {name}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── 配線: ノード実測 → SVG(直進 / ループ / 脱出 + 矢頭 + ラベル)。色・太さは --fc-* トークン ── */

const NS = 'http://www.w3.org/2000/svg';
const WIRE = 'var(--fc-wire)';
const LABEL = 'var(--fc-label)';
/* SVG ラベルの縁取り(パネル地の色)。文字が線に重なっても読めるようにする */
const HALO = 'var(--fc-halo)';
/* ループのレーンは戻り先の左 60px、2 本目以降は 20px ずつ外側(モック実測) */
const LOOP_INSET = 60;
const LOOP_STEP = 20;

/* fill / stroke は var() を確実に解決させるため属性でなく style に当てる */
const STYLE_KEYS = new Set(['fill', 'stroke', 'stroke-width']);
function mk(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (STYLE_KEYS.has(k)) el.style.setProperty(k, v);
    else el.setAttribute(k, v);
  }
  return el;
}

function line(svg: SVGSVGElement, d: string) {
  svg.appendChild(
    mk('path', { d, stroke: WIRE, 'stroke-width': 'var(--fc-wire-w)', fill: 'none' }),
  );
}

function arrow(svg: SVGSVGElement, x: number, y: number, dir: 'down' | 'right') {
  const d =
    dir === 'down'
      ? `M ${x - 3.5} ${y - 7} L ${x + 3.5} ${y - 7} L ${x} ${y} Z`
      : `M ${x - 7} ${y - 3.5} L ${x - 7} ${y + 3.5} L ${x} ${y} Z`;
  svg.appendChild(mk('path', { d, fill: WIRE }));
}

function label(
  svg: SVGSVGElement,
  x: number,
  y: number,
  text: string,
  anchor: 'start' | 'middle' | 'end',
) {
  if (!text) return;
  const el = mk('text', {
    x: String(x),
    y: String(y),
    fill: LABEL,
    'text-anchor': anchor,
    stroke: HALO,
    'stroke-width': '3',
    'paint-order': 'stroke',
  });
  el.textContent = text.length > 18 ? text.slice(0, 17) + '…' : text;
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
    if (e.type === 'seq') {
      line(svg, `M ${a.cx} ${a.b} V ${b.t - 1}`);
      arrow(svg, b.cx, b.t - 1, 'down');
      // 判断から下へ抜ける辺の条件ラベル(「はい」)は線の右脇
      label(svg, a.cx + 8, a.b + 18, e.label, 'start');
    } else if (e.type === 'exit') {
      /* 右頂点から右へ抜けて中断の終端へ。条件ラベルは線の上 */
      line(svg, `M ${a.l + a.w} ${a.cy} H ${b.l - 1}`);
      arrow(svg, b.l - 1, a.cy, 'right');
      label(svg, a.l + a.w + 10, a.cy - 6, e.label, 'start');
    } else {
      /* loop: 左頂点 → 左レーンを上へ → 戻り先の処理ノードの左辺。ラベルはレーンの中ほど */
      const lx = b.l - LOOP_INSET - (loopK % 3) * LOOP_STEP;
      loopK++;
      const sy = a.cy;
      const ty = b.cy;
      line(svg, `M ${a.l} ${sy} H ${lx} V ${ty} H ${b.l - 1}`);
      arrow(svg, b.l - 1, ty, 'right');
      label(svg, lx - 6, (sy + ty) / 2 + 4, e.label, 'end');
    }
  }
}
