/*
 * CLAUDE.md 画面(計画 15 Phase E2 / README 6.2)の純粋ロジック。描画は components/ClaudeMdView.tsx。
 * サーバーの走査(src/server/claude-md.ts)が返す 7 段(注入順・無い段も files: [] で残る)を、
 * 画面の 3 つの部品 — 事実の帯 / 読まれる順の表 / 見出しと本文 — が要る形に組み替える。
 * 本文は /api/file で別に取るので、@import の展開位置はここで本文から求める(ref の抽出規則は
 * サーバーと同じ: コードフェンスの外、`@` の前は行頭か空白、末尾の句読点は落とす)。
 */

import type {
  ClaudeMdFile,
  ClaudeMdImport,
  ClaudeMdLayer,
  ClaudeMdLayerKind,
  ClaudeMdScan,
} from './api';
import { t, type MsgKey } from './i18n';

/* 公式の読み込み順(README 6.6)。サーバーが段を省いた場合(root 無し)も 7 行を保つための順序表 */
export const LAYER_ORDER: ClaudeMdLayerKind[] = [
  'managed',
  'user',
  'project',
  'project-dot',
  'local',
  'rules',
  'parent',
];

export const LAYER_TOTAL = LAYER_ORDER.length;

/* 7 段を注入順に。サーバーに無い段は空の段として補い、「なし」の行を出せるようにする */
export function layerRows(scan: ClaudeMdScan): ClaudeMdLayer[] {
  return LAYER_ORDER.map(
    (kind) => scan.layers.find((l) => l.kind === kind) ?? { kind, label: '', files: [], tokens: 0 },
  );
}

/* 読まれる順に並べた全ファイル(lazy・管理ポリシーも含む。表の行と :id の候補) */
export function allFiles(scan: ClaudeMdScan): ClaudeMdFile[] {
  return layerRows(scan).flatMap((l) => l.files);
}

/* 既定の :id の対象 = 最初に存在する段の最初のファイル(計画 15 E2)。1 枚も無ければ null */
export const defaultFile = (scan: ClaudeMdScan): ClaudeMdFile | null => allFiles(scan)[0] ?? null;

export const findFile = (scan: ClaudeMdScan, path: string): ClaudeMdFile | undefined =>
  allFiles(scan).find((f) => f.path === path);

/* ファイルが属する段 */
export function layerOf(scan: ClaudeMdScan, file: ClaudeMdFile): ClaudeMdLayer | undefined {
  return scan.layers.find((l) => l.files.includes(file));
}

/* 存在する段の kind(事実の帯「存在する階層 n / 7」と先頭の要約文に使う) */
export const presentKinds = (scan: ClaudeMdScan): ClaudeMdLayerKind[] =>
  layerRows(scan)
    .filter((l) => l.files.length > 0)
    .map((l) => l.kind);

/* 遅延ロード(paths: 付きの rules)の概算。段の tokens には入っていないので別に足し合わせる */
export const lazyTokens = (scan: ClaudeMdScan): number =>
  allFiles(scan)
    .filter((f) => f.lazy)
    .reduce((n, f) => n + f.tokens, 0);

/* 最終更新(ms)。1 枚も無ければ 0 */
export const latestUpdated = (scan: ClaudeMdScan): number =>
  allFiles(scan).reduce((m, f) => Math.max(m, Date.parse(f.updatedAt) || 0), 0);

/*
 * @import の集計(事実の帯)。expanded は中身を数えたもの、missing は参照先が無いもの、
 * skipped は循環か 4 段超えで打ち切ったもの。
 */
export interface ImportStats {
  expanded: number;
  missing: number;
  skipped: number;
  /* 展開した分の合計 tok */
  tokens: number;
  /* 最初に展開した @import(帯の注記用) */
  first?: ClaudeMdImport;
}

export function importStats(scan: ClaudeMdScan): ImportStats {
  const st: ImportStats = { expanded: 0, missing: 0, skipped: 0, tokens: 0 };
  for (const f of allFiles(scan)) {
    for (const im of f.imports) {
      if (!im.exists) st.missing++;
      else if (im.skipped) st.skipped++;
      else {
        st.expanded++;
        st.tokens += im.tokens;
        st.first ??= im;
      }
    }
  }
  return st;
}

/* ---- @import 1 件の見え方(文言と tok 列) ---- */

/*
 * 打ち切り・未読の理由ごとの文言。`Record` で受けるので、サーバーが理由を増やしたら
 * ここが型エラーになる(既定値に落ちて「展開した」と嘘をつく事故を型で止める)。
 */
type Skip = NonNullable<ClaudeMdImport['skipped']>;

const IMPORT_SKIP: Record<Skip, MsgKey> = {
  cycle: 'cmd.importCycle',
  duplicate: 'cmd.importDuplicate',
  depth: 'cmd.importDepth',
  'too-large': 'cmd.importTooLarge',
  'out-of-scope': 'cmd.importOutOfScope',
};

const NESTED_SKIP: Record<Skip, MsgKey> = {
  cycle: 'cmd.nestedCycle',
  duplicate: 'cmd.nestedDuplicate',
  depth: 'cmd.nestedDepth',
  'too-large': 'cmd.nestedTooLarge',
  'out-of-scope': 'cmd.nestedOutOfScope',
};

/* 読まなかったものに tok は出さない(0 と書くと「読んで 0 だった」に見える) */
export const importTok = (im: ClaudeMdImport): string =>
  !im.exists || im.skipped ? '—' : im.tokens.toLocaleString();

/* 展開位置の印の文言(直接の import)。配下の状態は nestedState が 1 行ずつ */
export function importLine(im: ClaudeMdImport): string {
  if (!im.exists) return t('cmd.importMissing', { ref: im.ref });
  if (im.skipped) return t(IMPORT_SKIP[im.skipped], { ref: im.ref });
  return t('cmd.expandedHere', { ref: im.ref, n: im.tokens.toLocaleString() });
}

export function nestedState(im: ClaudeMdImport): string {
  if (!im.exists) return t('cmd.nestedMissing');
  if (im.skipped) return t(NESTED_SKIP[im.skipped]);
  return t('cmd.nestedTok', { n: im.tokens.toLocaleString() });
}

/* ---- 本文中の @import(展開位置の印) ---- */

/*
 * 1 行に含まれる @import の参照(サーバーの importRefs と同じ規則)。
 * 公式の除外規則はコードスパンとコードフェンス(フェンスは呼び出し側が飛ばす)。
 * サーバーと規則がずれると、本文の印とサーバーの展開結果を出現順で突き合わせている都合で
 * 1 つずつずれる(実在する @import の行に別のファイルの tok が付く)ので、必ず揃える。
 */
export function importRefsOfLine(line: string): string[] {
  const refs: string[] = [];
  // コードスパンは中身ごと落とす(`@README` は文字どおりの表記で参照ではない)
  for (const m of line.replace(/`[^`]*`/g, ' ').matchAll(/(^|\s)@(\S+)/g)) {
    let end = m[2].length;
    while (end > 0 && '.,;:)]'.includes(m[2][end - 1])) end--;
    const ref = m[2].slice(0, end);
    if (ref && ref.length <= 1024) refs.push(ref);
  }
  return refs;
}

/*
 * 直接の @import(depth 1)とその配下(深さ優先で続く depth ≥ 2)の組。
 * サーバーは深さ優先で out に積むので、次の depth 1 までが直前の直接 import の子孫。
 */
export interface ImportTree {
  root: ClaudeMdImport;
  nested: ClaudeMdImport[];
}

export function importTrees(imports: ClaudeMdImport[]): ImportTree[] {
  const out: ImportTree[] = [];
  for (const im of imports) {
    if (im.depth <= 1 || out.length === 0) out.push({ root: im, nested: [] });
    else out[out.length - 1].nested.push(im);
  }
  return out;
}

export type BodySegment =
  | { type: 'md'; text: string }
  /* @import を含む行。tree は本文中の出現順にサーバーの直接 import と突き合わせたもの(無ければ undefined) */
  | { type: 'import'; ref: string; tree?: ImportTree };

/*
 * 本文を @import の位置で分ける。@import だけの行は印に置き換え、文中に @ref がある行は
 * 行を残して直後に印を出す(位置が分かればよい)。コードフェンス内は見ない。
 */
export function splitImports(body: string, imports: ClaudeMdImport[]): BodySegment[] {
  const trees = importTrees(imports);
  const out: BodySegment[] = [];
  let buf: string[] = [];
  let i = 0;
  let inFence = false;
  const flush = () => {
    if (buf.length) out.push({ type: 'md', text: buf.join('\n') });
    buf = [];
  };
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const refs = inFence ? [] : importRefsOfLine(line);
    if (!refs.length) {
      buf.push(line);
      continue;
    }
    const only = /^\s*@\S+\s*$/.test(line);
    if (!only) buf.push(line);
    flush();
    for (const ref of refs) out.push({ type: 'import', ref, tree: trees[i++] });
  }
  flush();
  return out;
}

/* ---- 見出しと tok(左の一覧) ---- */

export type OutlineRow =
  | { type: 'heading'; level: number; text: string; tokens: number }
  | { type: 'import'; tree: ImportTree; ref: string };

/*
 * 見出しの一覧に @import を出現位置で差し込む。見出しの tok はサーバーの headings(本文と同じ順)から取り、
 * 本文が未取得(または管理ポリシー)なら見出しだけを並べ、@import は末尾に置く。
 * サーバーの見出し抽出はコードフェンスを見ない(headingsOf)ので、ここも同じ規則で数えて index を揃える。
 */
export function outlineOf(file: ClaudeMdFile, body: string | null): OutlineRow[] {
  const trees = importTrees(file.imports);
  const heads = file.headings;
  if (body === null) {
    return [
      ...heads.map((h) => ({ type: 'heading' as const, level: 0, text: h.text, tokens: h.tokens })),
      ...trees.map((tree) => ({ type: 'import' as const, tree, ref: tree.root.ref })),
    ];
  }
  const out: OutlineRow[] = [];
  let hi = 0;
  let ii = 0;
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const tok = heads[hi]?.tokens ?? 0;
      hi++;
      out.push({ type: 'heading', level: h[1].length, text: h[2].trim(), tokens: tok });
      continue;
    }
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    for (const ref of importRefsOfLine(line)) {
      const tree = trees[ii++];
      if (tree) out.push({ type: 'import', tree, ref });
    }
  }
  // 本文側で拾えなかった分(規則の差)は落とさず末尾へ
  for (; hi < heads.length; hi++)
    out.push({ type: 'heading', level: 0, text: heads[hi].text, tokens: heads[hi].tokens });
  for (; ii < trees.length; ii++)
    out.push({ type: 'import', tree: trees[ii], ref: trees[ii].root.ref });
  return out;
}

/* ---- 表示用のパス ---- */

/* user 段の label(<home>/.claude/CLAUDE.md)からホームを逆算する。SkillsData にホームは無い */
export function homeOf(scan: ClaudeMdScan): string {
  const user = scan.layers.find((l) => l.kind === 'user');
  const m = user?.label.match(/^(.*)[\\/]\.claude[\\/]CLAUDE\.md$/);
  return m ? m[1] : '';
}

/* プロジェクト配下は ./、ホーム配下は ~/ に縮める(モックの「場所」列) */
export function displayPath(p: string, cwd: string, home: string): string {
  if (!p) return '';
  const strip = (base: string) => base.replace(/[\\/]+$/, '');
  const c = strip(cwd);
  if (c && (p === c || p.startsWith(c + '/') || p.startsWith(c + '\\')))
    return './' + p.slice(c.length + 1);
  const h = strip(home);
  if (h && (p.startsWith(h + '/') || p.startsWith(h + '\\'))) return '~/' + p.slice(h.length + 1);
  return p;
}
