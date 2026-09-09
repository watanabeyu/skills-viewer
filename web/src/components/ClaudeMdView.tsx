/*
 * CLAUDE.md 画面(/claude-md/:id。計画 15 Phase E2 / README 6.2「何が毎回読まれているか」)。
 * S3「セッションが重い。何が毎回注入されているのか」に 1 画面で答える:
 *   名前と要約 → 事実の帯(合計 / 存在する階層 / 追加・更新 / @import)
 *   → 読まれる順の 7 段表(無い段も「なし」で残す)→ 見出しごとの tok + 本文(@import は展開位置に印)。
 * :id は toId(ファイルパス)。既定は読まれる順で最初に存在する段(claudemd.ts の defaultFile)。
 * 管理ポリシー(bodyWithheld)は本文を取らず「存在する」だけを出す。
 * 寸法は docs/design/0.9.0/{Ledger,Console}ClaudeMd.dc.html の実測(style.css の --cmd-* トークン)。
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  fetchDiff,
  fromId,
  toId,
  type ClaudeMdFile,
  type ClaudeMdLayer,
  type DiffResponse,
  type SkillsData,
} from '../api';
import {
  LAYER_TOTAL,
  allFiles,
  defaultFile,
  displayPath,
  findFile,
  homeOf,
  importLine,
  importStats,
  importTok,
  latestUpdated,
  layerOf,
  layerRows,
  lazyTokens,
  nestedState,
  outlineOf,
  presentKinds,
  splitImports,
  type ImportTree,
} from '../claudemd';
import { changeMarkOf, currentSection, fileName, fmtDate, relTimeLabel } from '../util';
import { mdRender, splitFrontmatter, splitPreview } from '../md';
import { t, type MsgKey } from '../i18n';
import { InlineError } from './Inline';
import { EditorButton, useOpenEditor } from './EditorButton';
import { FactCell } from './FactsBand';
import { DiffBlock, useMdText } from './FullText';
import { KindPill, Mark, SourcePill } from './Rows';

const kindLabel = (kind: ClaudeMdLayer['kind']) => t(('cmd.kind.' + kind) as MsgKey);

/* 存在する段の並び(重複する project は 1 つに寄せる。「user · project · rules」) */
function presentList(data: SkillsData): string {
  return [...new Set(presentKinds(data.claudeMd).map(kindLabel))].join(' · ');
}

export function ClaudeMdView({ data }: { data: SkillsData }) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const scan = data.claudeMd;
  const file = id ? findFile(scan, fromId(id)) : undefined;
  const fallback = defaultFile(scan);

  // :id が無い・走査に載らないパスなら既定の段へ(URL を正規化する)。1 枚も無ければ本文なしで出す
  if (!file && fallback) {
    return (
      <Navigate
        to={{ pathname: '/claude-md/' + toId(fallback.path), search: params.toString() }}
        replace
      />
    );
  }
  // 段を選ぶ = :id を差し替える(検索クエリは保つ)
  const select = (path: string) =>
    navigate({ pathname: '/claude-md/' + toId(path), search: params.toString() });
  return (
    <div className="dv">
      <TitleBlock data={data} file={file} />
      <Facts data={data} />
      <OrderTable data={data} current={file} onSelect={select} />
      {file ? (
        <BodyGrid data={data} file={file} />
      ) : (
        <div className="dblk">
          <div className="dv-empty">{t('cmd.noFiles')}</div>
        </div>
      )}
    </div>
  );
}

/* 名前とチップ、右端に「エディタで開く」(選択中のファイル。管理ポリシーは開けない)。下に要約文 */
function TitleBlock({ data, file }: { data: SkillsData; file?: ClaudeMdFile }) {
  const project = currentSection(data.sections);
  const projectLabel = project?.projectName || fileName(data.cwd);
  const kinds = presentKinds(data.claudeMd);
  const { openError, onOpenEditor } = useOpenEditor(file?.path || '');
  return (
    <div className="dv-title">
      <div className="dv-title-row">
        <h1>{t('cmd.title')}</h1>
        <KindPill kind="claude-md" />
        <SourcePill source="project" label={projectLabel} />
        <span className="dv-title-r">
          <InlineError msg={openError} />
          {file && !file.bodyWithheld && <EditorButton onClick={onOpenEditor} />}
        </span>
      </div>
      <p className="dv-desc">
        {kinds.length
          ? t('cmd.lead', { n: kinds.length, total: LAYER_TOTAL, list: presentList(data) })
          : t('cmd.leadNone', { total: LAYER_TOTAL })}
      </p>
    </div>
  );
}

/* 事実の帯: 合計 / 存在する階層 / 追加・更新 / @import(E1 の FactCell を共用) */
function Facts({ data }: { data: SkillsData }) {
  const scan = data.claudeMd;
  const kinds = presentKinds(scan);
  const lazy = lazyTokens(scan);
  const updated = latestUpdated(scan);
  const st = importStats(scan);
  // 差分(既読基準)に載っている CLAUDE.md 群の件数。印は 1 件でもあれば「変わった」
  const changed = allFiles(scan)
    .map((f) => changeMarkOf({ kind: 'claude-md', path: f.path }, data.changes))
    .filter(Boolean);
  const mark =
    changed.includes('add') && !changed.includes('mod') ? 'add' : changed.length ? 'mod' : null;
  return (
    <div className="dblk facts">
      <FactCell label={t('cmd.factTotal')}>
        <span className="fv lg">
          {scan.tokens.toLocaleString()} <span className="meta">{t('ctx.unit')}</span>
        </span>
        <span className="meta">{t('cmd.factTotalNote')}</span>
        {lazy > 0 && (
          <span className="meta">{t('cmd.lazyNote', { n: lazy.toLocaleString() })}</span>
        )}
      </FactCell>
      <FactCell label={t('cmd.factLayers')}>
        <span className="fv lg">
          {kinds.length}{' '}
          <span className="meta">{t('cmd.factLayersOf', { total: LAYER_TOTAL })}</span>
        </span>
        <span className="meta ellip">
          {kinds.length ? t('cmd.layersOnly', { list: presentList(data) }) : t('cmd.layersNone')}
        </span>
      </FactCell>
      <FactCell label={t('fact.history')} mark={mark}>
        <span className="fv-sub mono">
          {updated ? t('fact.updated', { date: fmtDate(updated) }) : t('cmd.noUpdated')}
        </span>
        {changed.length > 0 && (
          <span className="meta">{t('cmd.changedN', { n: changed.length })}</span>
        )}
      </FactCell>
      <FactCell label={t('cmd.factImport')}>
        <span className="fv-sub">
          {st.expanded ? t('cmd.importN', { n: st.expanded }) : t('cmd.importNone')}
        </span>
        {st.first && (
          <span className="meta mono ellip" title={st.first.path}>
            {t('cmd.importFirst', { ref: st.first.ref, n: st.first.tokens.toLocaleString() })}
          </span>
        )}
        {st.missing + st.skipped > 0 && (
          <span className="warn-inline">
            {t('cmd.importIssues', { n: st.missing + st.skipped })}
          </span>
        )}
      </FactCell>
    </div>
  );
}

/* ---- 読まれる順の 7 段表 ---- */

function OrderTable({
  data,
  current,
  onSelect,
}: {
  data: SkillsData;
  current?: ClaudeMdFile;
  onSelect: (path: string) => void;
}) {
  const scan = data.claudeMd;
  const home = homeOf(scan);
  const disp = (p: string) => displayPath(p, data.cwd, home);
  const rows = layerRows(scan);
  return (
    <section className="dblk">
      <div className="dblk-hd">
        <h2>{t('cmd.order')}</h2>
        <span className="meta">{t('cmd.orderSub')}</span>
      </div>
      <div className="crow thead">
        <span>{t('cmd.colN')}</span>
        <span>{t('cmd.colScope')}</span>
        <span>{t('cmd.colPath')}</span>
        <span>{t('cmd.colState')}</span>
        <span className="num">{t('col.tok')}</span>
        <span>{t('cmd.colUpdated')}</span>
      </div>
      {rows.map((layer, i) => {
        const n = i + 1;
        const many = layer.files.length > 1;
        const single = layer.files.length === 1 ? layer.files[0] : null;
        const note = layer.kind === 'rules' && !layer.files.length ? t('cmd.rulesNote') : '';
        return (
          <div key={layer.kind} className="cgrp">
            {single ? (
              <FileRow
                n={String(n)}
                scope={<span className="pill">{kindLabel(layer.kind)}</span>}
                file={single}
                path={disp(single.path)}
                cur={single === current}
                mark={changeMarkOf({ kind: 'claude-md', path: single.path }, data.changes)}
                onSelect={onSelect}
              />
            ) : (
              <div className={'crow' + (many ? '' : ' absent') + (note ? ' noted' : '')}>
                <span className="mono meta">{n}</span>
                <span>
                  <span className="pill">{kindLabel(layer.kind)}</span>
                </span>
                <span className="ccell">
                  <span className="cpath mono" title={layer.label}>
                    {disp(layer.label) + (layer.kind === 'parent' && !many ? ' …' : '')}
                  </span>
                  {note && <span className="cnote">{note}</span>}
                </span>
                <span className={many ? 'good cstate' : 'meta'}>
                  {many ? t('cmd.presentN', { n: layer.files.length }) : t('cmd.absent')}
                </span>
                <span className={'num' + (many ? '' : ' meta')}>
                  {many ? layer.tokens.toLocaleString() : '—'}
                </span>
                <span />
              </div>
            )}
            {many &&
              layer.files.map((f) => (
                <FileRow
                  key={f.path}
                  n=""
                  scope={null}
                  file={f}
                  path={disp(f.path)}
                  cur={f === current}
                  mark={changeMarkOf({ kind: 'claude-md', path: f.path }, data.changes)}
                  onSelect={onSelect}
                  sub
                />
              ))}
          </div>
        );
      })}
    </section>
  );
}

/* 存在するファイルの行。押せる(選ぶと本文が切り替わる)。lazy は状態を「遅延」にし、tok は補足色 */
function FileRow({
  n,
  scope,
  file,
  path,
  cur,
  mark,
  onSelect,
  sub,
}: {
  n: string;
  scope: ReactNode;
  file: ClaudeMdFile;
  path: string;
  cur: boolean;
  mark: 'add' | 'mod' | null;
  onSelect: (path: string) => void;
  sub?: boolean;
}) {
  const ms = Date.parse(file.updatedAt) || 0;
  const note = file.lazy
    ? t('cmd.lazyRowNote')
    : file.bodyWithheld
      ? t('cmd.withheldRow')
      : file.tooLarge
        ? t('cmd.tooLargeRow')
        : '';
  return (
    <button
      className={
        'crow present' + (cur ? ' cur' : '') + (sub ? ' sub' : '') + (note ? ' noted' : '')
      }
      onClick={() => onSelect(file.path)}
      aria-current={cur ? 'page' : undefined}
    >
      <span className="mono meta">{n}</span>
      <span>{scope}</span>
      <span className="ccell">
        <span className="cpath mono" title={file.path}>
          {path}
          {mark && <Mark mark={mark} small />}
        </span>
        {note && <span className="cnote">{note}</span>}
      </span>
      <span className={file.lazy ? 'meta cstate' : 'good cstate'}>
        {file.lazy ? t('cmd.lazy') : t('cmd.present')}
      </span>
      <span className={'num' + (file.lazy ? ' meta' : '')}>{file.tokens.toLocaleString()}</span>
      <span className="meta nowrap">{ms ? relTimeLabel(ms) : ''}</span>
    </button>
  );
}

/* ---- 見出しと tok + 本文 ---- */

function BodyGrid({ data, file }: { data: SkillsData; file: ClaudeMdFile }) {
  // 4 MiB 超は本文を取りに行かない(サーバーも読んでいない)。管理ポリシーと同じ扱いにする
  const withheld = !!file.bodyWithheld || !!file.tooLarge;
  const { raw, error } = useMdText(withheld ? '' : file.path);
  const parsed = raw === null ? null : splitFrontmatter(raw);
  const body = parsed ? parsed.body : null;
  const layer = layerOf(data.claudeMd, file);
  const home = homeOf(data.claudeMd);
  const rows = outlineOf(file, body);
  return (
    <div className="cmd-body">
      <section className="dblk">
        <div className="dblk-hd">
          <h2>{t('cmd.sections')}</h2>
          <span className="meta">{layer ? kindLabel(layer.kind) : ''}</span>
        </div>
        <div className="orow thead">
          <span>{t('cmd.colHeading')}</span>
          <span className="num">{t('col.tok')}</span>
        </div>
        {rows.length === 0 && <div className="dv-empty">{t('cmd.sectionsNone')}</div>}
        {rows.map((r, i) =>
          r.type === 'heading' ? (
            <div className="orow" key={i}>
              <span className="oname ellip" title={r.text}>
                {r.level ? '#'.repeat(r.level) + ' ' : ''}
                {r.text}
              </span>
              <span className="num sub">{r.tokens.toLocaleString()}</span>
            </div>
          ) : (
            <ImportRows key={i} tree={r.tree} />
          ),
        )}
      </section>
      <FilePanel
        file={file}
        path={displayPath(file.path, data.cwd, home)}
        raw={raw}
        parsed={parsed}
        error={error}
        withheld={withheld}
      />
    </div>
  );
}

/* 見出し一覧の中の @import(直接 1 行 + 配下は ↳ で 1 段下げ。打ち切りと欠落は注記) */
function ImportRows({ tree }: { tree: ImportTree }) {
  return (
    <>
      <div className="orow imp">
        <span className="mono meta ellip" title={tree.root.path}>
          {t('cmd.importRow', { ref: tree.root.ref })}
        </span>
        <span className="num sub">{importTok(tree.root)}</span>
      </div>
      {tree.nested.map((im, i) => (
        <div className="orow imp nested" key={i}>
          <span className="mono meta ellip" title={im.path}>
            {t('cmd.importNested', { ref: im.ref })}
          </span>
          <span className="num meta">{importTok(im)}</span>
        </div>
      ))}
    </>
  );
}

function ImportNote({ refText, tree }: { refText: string; tree?: ImportTree }) {
  if (!tree) return <div className="cmd-import">{t('cmd.importUnknown', { ref: refText })}</div>;
  const issue =
    !tree.root.exists || !!tree.root.skipped || tree.nested.some((n) => n.skipped || !n.exists);
  return (
    <div className={'cmd-import' + (issue ? ' issue' : '')}>
      <span>{importLine(tree.root)}</span>
      {tree.nested.map((im, i) => (
        <span className="nested" key={i}>
          {'↳ '.repeat(Math.max(1, im.depth - 1))}
          {'@' + im.ref} · {nestedState(im)}
        </span>
      ))}
    </div>
  );
}

/* 本文のパネル: 見出し行(パス · tok · 更新、右端に前版との diff)→ frontmatter → 本文(@import は印) */
function FilePanel({
  file,
  path,
  raw,
  parsed,
  error,
  withheld,
}: {
  file: ClaudeMdFile;
  path: string;
  raw: string | null;
  parsed: { frontmatter: string | null; body: string } | null;
  error: string;
  withheld: boolean;
}) {
  const [prev, setPrev] = useState<DiffResponse | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [more, setMore] = useState(false);
  useEffect(() => {
    let alive = true;
    setPrev(null);
    setShowDiff(false);
    setMore(false);
    if (withheld) return;
    fetchDiff(file.path)
      .then((r) => {
        if (alive) setPrev(r);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [file.path, withheld]);

  const preview = parsed ? splitPreview(parsed.body) : null;
  const shown = preview ? (more || !preview.rest ? parsed!.body : preview.head) : '';
  const segs = parsed ? splitImports(shown, file.imports) : [];
  const ms = Date.parse(file.updatedAt) || 0;
  return (
    <section className="dblk cmd-file">
      <div className="dblk-hd rule">
        <h2 className="cmd-file-name" title={file.path}>
          {path}
        </h2>
        <span className="meta mono ellip">
          {t('cmd.fileMeta', { n: file.tokens.toLocaleString(), date: fmtDate(ms) })}
          {file.lazy ? ' · ' + t('cmd.fileLazy') : ''}
        </span>
        {prev?.available && parsed && (
          <button
            className={'btn hd-r' + (showDiff ? ' on' : '')}
            onClick={() => setShowDiff((v) => !v)}
          >
            {showDiff ? t('detail.diffClose') : t('full.diffPrev')}
          </button>
        )}
      </div>
      {withheld && (
        <div className="dv-empty">
          {file.tooLarge
            ? t('cmd.tooLarge')
            : t('cmd.withheld', { n: file.tokens.toLocaleString() })}
        </div>
      )}
      {!withheld && error && <div className="dv-empty">{t('app.loadFailed', { msg: error })}</div>}
      {!withheld && !error && parsed === null && (
        <div className="dv-empty">{t('common.loading')}</div>
      )}
      {parsed && showDiff && prev?.previous !== undefined && raw !== null && (
        <div className="dv-diff">
          <DiffBlock
            aLabel={t('diff.prev')}
            bLabel={t('diff.now')}
            dep={file.path}
            load={async () => [prev.previous!, raw]}
          />
        </div>
      )}
      {parsed && (
        <>
          {parsed.frontmatter && <div className="fm">{parsed.frontmatter}</div>}
          {/* 自前レンダラ内で全テキストを HTML エスケープ済み */}
          <div className="md-full">
            {segs.map((s, i) =>
              s.type === 'md' ? (
                <div
                  className="md-body"
                  key={i}
                  dangerouslySetInnerHTML={{ __html: mdRender(s.text) }}
                />
              ) : (
                <ImportNote key={i} refText={s.ref} tree={s.tree} />
              ),
            )}
            {preview?.rest && (
              <button className="linkbtn meta" onClick={() => setMore((v) => !v)}>
                {more ? t('full.less') : t('full.more', { n: preview.restLines })}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
