/*
 * memory の鮮度(state)を判定するための機械シグナル。事実を拾うだけで行き先は決めない。
 *
 * 2 層に分ける:
 *   - テキスト / fs 層(extractSignals): 本文の絶対日付・参照パスの実在・完了語。
 *     正規表現と existsSync だけなので /api/skills のスキャン時に毎回計算してよい
 *   - git 層(loadBranches + branchSignals): 本文に出るブランチ名のマージ状況。
 *     git の spawn を伴うので棚卸し診断の call 時にだけ計算する(起動経路に入れない)
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MemorySignal, MemoryType } from '../shared/types';
import { HOME } from './scan';

export interface SignalOptions {
  /* 経過日の基準(テストで固定する) */
  now?: number;
  /* `~/` の展開先(テストで差し替える) */
  home?: string;
  /* feedback / user 型なら本文構造のシグナルも出す */
  memoryType?: MemoryType;
  /* 本文の概算 tok(body-over の判定用) */
  bodyTokens?: number;
  /* この memory のプロジェクト以外の登録プロジェクト(worktree 関係は除外済み)。other-project の判定用 */
  otherProjects?: string[];
}

const MAX_MISSING_PATHS = 3;

/* 完了・廃止を表す語。ASCII は単語境界つき・大文字小文字無視、日本語はそのまま部分一致 */
const DONE_WORDS_JA = ['完了', 'マージ済', '対応済', 'リリース済', '廃止'];
const DONE_WORDS_EN = ['merged', 'done', 'completed', 'deprecated', 'resolved'];

/*
 * 本文中の絶対日付(YYYY-MM-DD / YYYY/MM/DD / YYYY年M月D日)のうち最新のもの。
 * memory の運用ルールで相対日付は絶対日付に直されているので、本文の日付がその記述の「いつ」を表す。
 * 未来すぎる日付(1 年超)は誤検出として除く。
 */
export function latestDate(body: string, now: number): { value: string; days: number } | null {
  let best: { value: string; ms: number } | null = null;
  for (const m of body.matchAll(/(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})日?/g)) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    const ms = Date.UTC(y, mo - 1, d);
    if (ms > now + 366 * 86400000) continue;
    if (!best || ms > best.ms) {
      best = { value: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, ms };
    }
  }
  if (!best) return null;
  return { value: best.value, days: Math.max(0, Math.floor((now - best.ms) / 86400000)) };
}

/*
 * 本文が参照するファイルパスのうち存在しないもの。
 * 対象は「/ を含み、末尾が拡張子つきのファイル名」に限る(URL・ブランチ名・パッケージ名を拾わない)。
 * 相対パスは projectPath 基準。projectPath が無い(プロジェクト不明)なら絶対パスと ~/ だけを見る。
 */
export function missingPaths(body: string, projectPath: string | null, home: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re =
    /(?:^|[\s(`「'"<[])((?:~\/|\.{1,2}\/|\/)?[\w@.-]+(?:\/[\w@.-]+)+\.[A-Za-z0-9]{1,8})(?=$|[\s)`」'">\],:;。、])/gm;
  for (const m of body.matchAll(re)) {
    const raw = m[1];
    if (seen.has(raw)) continue;
    seen.add(raw);
    // `foo.com/bar.js` のようなドメイン風は除く(ホスト名にドットを含む先頭セグメント)
    const first = raw.replace(/^(?:~\/|\.{1,2}\/|\/)/, '').split('/')[0];
    if (/\.[a-z]{2,}$/i.test(first) && !raw.startsWith('/') && !raw.startsWith('~/')) continue;
    let resolved: string;
    if (raw.startsWith('~/')) resolved = path.join(home, raw.slice(2));
    else if (raw.startsWith('/')) resolved = raw;
    else if (projectPath) resolved = path.resolve(projectPath, raw);
    else continue;
    if (!fs.existsSync(resolved)) {
      out.push(raw);
      if (out.length >= MAX_MISSING_PATHS) break;
    }
  }
  return out;
}

/* description + 本文に含まれる完了語(重複排除、最大 3 語) */
export function doneWords(text: string): string[] {
  const found: string[] = [];
  for (const w of DONE_WORDS_JA) if (text.includes(w)) found.push(w);
  for (const w of DONE_WORDS_EN) {
    if (new RegExp('\\b' + w + '\\b', 'i').test(text)) found.push(w);
  }
  return found.slice(0, 3);
}

/* テキスト / fs 層のシグナルをまとめて計算する(スキャン時) */
export function extractSignals(
  body: string,
  description: string,
  projectPath: string | null,
  opts: SignalOptions = {},
): MemorySignal[] {
  const now = opts.now ?? Date.now();
  const home = opts.home ?? HOME;
  const out: MemorySignal[] = [];
  const date = latestDate(body, now);
  if (date) out.push({ kind: 'date', value: date.value, days: date.days });
  for (const p of missingPaths(body, projectPath, home))
    out.push({ kind: 'path-missing', value: p });
  const words = doneWords(description + '\n' + body);
  if (words.length) out.push({ kind: 'done-words', value: words.join(', ') });
  if (opts.memoryType === 'feedback' || opts.memoryType === 'user') {
    out.push(...feedbackSignals(body, description, opts.bodyTokens ?? 0));
  }
  for (const p of otherProjectRefs(body, home, opts.otherProjects || []))
    out.push({ kind: 'other-project', value: p });
  return out;
}

/*
 * 本文が別の登録プロジェクトの配下パス(絶対 / ~/)を指しているか。
 * 「別プロジェクトの話が混入した memory」の機械的な根拠で、置き場所(wrong-project)の判断材料になる。
 * 呼び出し側で自分自身(slug 一致を含む)・worktree 関係・入れ子プロジェクトは除いて渡す。
 * 値はフルパス(basename だと teamA/ai-workspace と teamB/ai-workspace のような
 * 同名プロジェクトを区別できないため。basename が要る表示側で導出する)。
 */
export function otherProjectRefs(body: string, home: string, others: string[]): string[] {
  if (!others.length) return [];
  const hit = new Set<string>();
  for (const m of body.matchAll(/(~\/[^\s)）」'"`<>]+|\/[\w.@-]+(?:\/[\w.@-]+)+)/g)) {
    const raw = m[1].replace(/[/.,:;。、)）」]+$/, '');
    const resolved = raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw;
    for (const p of others) {
      if (resolved === p || resolved.startsWith(p + path.sep)) hit.add(p);
    }
  }
  return [...hit].slice(0, 2);
}

/* ---- feedback / user 型の本文構造 ---- */

export interface FeedbackParts {
  /* 1 行目(ルール)。Why より前の最初の非空行 */
  rule: string;
  why: string;
  how: string;
}

const WHY_RE = /^\s*(?:\*\*)?Why:?(?:\*\*)?:?\s*/im;
const HOW_RE = /^\s*(?:\*\*)?How to apply:?(?:\*\*)?:?\s*/im;

/*
 * Claude Code が feedback を書くときの定型(1 行目 / **Why:** / **How to apply:**)に分解する。
 * 見出しが無ければ該当部分は空文字(テンプレートは「無い部分には触れない」)。
 */
export function parseFeedbackParts(body: string): FeedbackParts {
  const whyAt = body.search(WHY_RE);
  const howAt = body.search(HOW_RE);
  const head = body.slice(0, Math.min(...[whyAt, howAt].filter((i) => i >= 0), body.length));
  const rule =
    head
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) || '';
  let why = '';
  let how = '';
  if (whyAt >= 0) {
    const end = howAt > whyAt ? howAt : body.length;
    why = body.slice(whyAt, end).replace(WHY_RE, '').trim();
  }
  if (howAt >= 0) {
    const end = whyAt > howAt ? whyAt : body.length;
    how = body.slice(howAt, end).replace(HOW_RE, '').trim();
  }
  return { rule, why, how };
}

/* 文字 2-gram の Dice 係数(0〜1)。空白・記号を落として比べる。日本語の言い換え検出に十分な粗さ */
export function dice2gram(a: string, b: string): number {
  const grams = (s: string) => {
    const t = s.toLowerCase().replace(/[\s\p{P}]/gu, '');
    const set = new Set<string>();
    for (let i = 0; i + 1 < t.length; i++) set.add(t.slice(i, i + 2));
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit++;
  return (2 * hit) / (ga.size + gb.size);
}

const RESTATE_THRESHOLD = 0.3;
// 実測: 索引 1 行で機能する feedback の本文は 150〜300 tok が多数派。opus が「短い」と評した 166 tok を超えない閾値にする
const FEEDBACK_BODY_MAX_TOKENS = 200;
const EXCEPTION_RE = /ただし|例外|除く|除き|unless|except(?!ion)/i;
const EPISODIC_USER_RE =
  /ユーザー(?:が|の|から)?\s*(?:指摘|言|依頼|要望)|user (?:said|pointed out|asked)/i;
const EPISODIC_ISSUE_RE = /#\d{2,}/;

/* エピソード固有の語(ブランチ名 / #番号 / 日付 / 「ユーザーが指摘」)。why-episodic と whyRewrite の検証で共用 */
export function episodicTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(BRANCH_RE)) out.push(m[1]);
  const issue = text.match(EPISODIC_ISSUE_RE);
  if (issue) out.push(issue[0]);
  const date = text.match(/20\d{2}[-/年]\d{1,2}[-/月]\d{1,2}日?/);
  if (date) out.push(date[0]);
  const user = text.match(EPISODIC_USER_RE);
  if (user) out.push(user[0]);
  return [...new Set(out)].slice(0, 4);
}

export function feedbackSignals(
  body: string,
  description: string,
  bodyTokens: number,
): MemorySignal[] {
  const out: MemorySignal[] = [];
  const parts = parseFeedbackParts(body);
  const pct = (x: number) => Math.round(x * 100) + '%';
  if (parts.rule && description) {
    const sim = dice2gram(parts.rule, description);
    if (sim >= RESTATE_THRESHOLD) out.push({ kind: 'first-line-restates', value: pct(sim) });
  }
  if (parts.how && description) {
    const sim = dice2gram(parts.how, description);
    if (sim >= RESTATE_THRESHOLD) out.push({ kind: 'how-restates', value: pct(sim) });
  }
  if (parts.why) {
    const ep = episodicTokens(parts.why);
    if (ep.length) out.push({ kind: 'why-episodic', value: ep.join(', ') });
  }
  const exLine = body.split('\n').find((l) => EXCEPTION_RE.test(l));
  if (exLine) out.push({ kind: 'has-exception', value: exLine.trim().slice(0, 40) });
  if (bodyTokens > FEEDBACK_BODY_MAX_TOKENS)
    out.push({ kind: 'body-over', value: String(bodyTokens) });
  return out;
}

/* ---- git 層 ---- */

export interface BranchInfo {
  /* ローカル + リモートの全ブランチ(origin/ は剥がして正規化) */
  all: Set<string>;
  /* 既定ブランチに取り込み済みのブランチ(同じく正規化) */
  merged: Set<string>;
  defaultBranch: string;
}

function git(projectPath: string, args: string[]): string {
  return execFileSync('git', ['-C', projectPath, ...args], {
    encoding: 'utf8',
    timeout: 3000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

const normalizeRef = (r: string) => r.trim().replace(/^origin\//, '');

/*
 * プロジェクトのブランチ一覧とマージ状況。git リポジトリでない・git が無い・失敗した場合は null
 * (シグナル無しとして扱う。診断を止めない)。
 */
export function loadBranches(projectPath: string | null): BranchInfo | null {
  if (!projectPath) return null;
  try {
    const all = new Set(
      git(projectPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'])
        .split('\n')
        .map(normalizeRef)
        .filter((r) => r && r !== 'HEAD'),
    );
    let defaultBranch = '';
    try {
      defaultBranch = normalizeRef(
        git(projectPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
      );
    } catch {
      defaultBranch = all.has('main') ? 'main' : all.has('master') ? 'master' : '';
    }
    if (!defaultBranch) return { all, merged: new Set(), defaultBranch };
    const merged = new Set(
      git(projectPath, ['branch', '-a', '--merged', defaultBranch, '--format=%(refname:short)'])
        .split('\n')
        .map(normalizeRef)
        .filter((r) => r && r !== 'HEAD' && r !== defaultBranch),
    );
    return { all, merged, defaultBranch };
  } catch {
    return null;
  }
}

/*
 * 本文に出るブランチ名らしきトークン(接頭辞 feat/ fix/ 等)。ブランチ名は ASCII 前提。
 * docs/ test/ style/ はディレクトリ名として頻出し(docs/projects-design/、test/contract)、
 * 実測で誤検出になったので接頭辞から外す。末尾が / のものはディレクトリなので拾わない
 * (否定先読みはトークン文字全体を対象にし、短い一致へのバックトラックを防ぐ)
 */
const BRANCH_RE =
  /\b((?:feat|feature|fix|bugfix|hotfix|chore|refactor|release|ci|perf)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)(?![A-Za-z0-9._/-])/g;

export function branchSignals(body: string, info: BranchInfo): MemorySignal[] {
  const out: MemorySignal[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(BRANCH_RE)) {
    const name = m[1].replace(/[.)\]]+$/, ''); // 文末の句読点・閉じ括弧を剥がす
    if (seen.has(name) || name === info.defaultBranch) continue;
    seen.add(name);
    if (info.merged.has(name)) out.push({ kind: 'branch-merged', value: name });
    else if (!info.all.has(name)) out.push({ kind: 'branch-missing', value: name });
    // 存在して未マージ = 進行中。シグナルは出さない
  }
  return out;
}
