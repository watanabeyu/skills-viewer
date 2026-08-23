/*
 * AI 棚卸し診断: 自動メモリ 1 件ずつの「行き先」の仮説(verdict + 理由 + 根拠 + 指示文)を
 * 生成する。呼び出しは groups.ts 型の一括(重複・別プロジェクト混入は全件を同時に見せないと
 * 判定できない)、キャッシュは diagnose.ts 型の件単位(本文 hash + lang)というハイブリッド。
 * 再診断は未キャッシュ(= 内容が変わった)件だけを集めて 1 call にまとめる。
 *
 * skills-viewer は memory に一切書き込まない。削減の実体は MEMORY.md の索引行削除だが、
 * そこは Claude Code の管理領域なので「貼れる指示文」を作って本人にやらせる。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  AiModel,
  Lang,
  MemorySection,
  MemorySignal,
  MemoryState,
  MemoryTriage,
  MemoryVerdict,
  Section,
  SkillItem,
} from '../shared/types';
import { pruneMissing } from './cache';
import { branchSignals, loadBranches } from './memory-signals';
import { HOME, parseFrontmatter } from './scan';
import { contentHash, runClaude } from './summary';

const TRIAGE_FILE = path.join(os.homedir(), '.cache', 'skills-viewer', 'memory-triage.json');

const VERDICTS: readonly MemoryVerdict[] = [
  'keep',
  'shrink',
  'to-claude-md',
  'to-docs',
  'delete',
  'wrong-project',
  'to-skill',
  'update',
];
const STATES: readonly MemoryState[] = ['current', 'outdated', 'historical', 'obsolete'];

interface TriageEntry extends MemoryTriage {
  hash: string | null;
  lang: Lang;
  generatedAt: string;
  /* 生成に使ったモデル(記録のみ。stale 判定には使わない) */
  model?: AiModel;
}
export type TriageStore = Record<string, TriageEntry>;

export function loadTriage(): TriageStore {
  try {
    return JSON.parse(fs.readFileSync(TRIAGE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveTriage(store: TriageStore): void {
  fs.mkdirSync(path.dirname(TRIAGE_FILE), { recursive: true });
  // 保存のついでに死にエントリを掃除する(GET では書き込まないので掃除もしない)
  fs.writeFileSync(TRIAGE_FILE, JSON.stringify(pruneMissing(store), null, 1));
}

/* MEMORY.md(索引)の全文。差分 call でも重複・別プロジェクト判定の文脈として常に渡す */
function readIndexText(memDir: string): string {
  try {
    return fs.readFileSync(path.join(memDir, 'MEMORY.md'), 'utf8').slice(0, 12000);
  } catch {
    return '';
  }
}

function daysAgo(ms?: number): number | null {
  if (!ms) return null;
  return Math.max(0, Math.floor((Date.now() - ms) / 86400000));
}

export interface TriageContext {
  projectName: string;
  /* MEMORY.md の全文(無ければ空文字) */
  index: string;
  /* false = そのプロジェクトの transcript が無い = Read / W-E は計測不能 */
  usageAvailable: boolean;
  /*
   * このプロジェクトで常時有効なもの。「もう CLAUDE.md に書いてある(= delete)」
   * 「その skill に 1 行足せば memory 自体が要らない(= to-skill)」を判定させるための文脈。
   * 収集できなければ空文字(呼び出し側の都合で省略も可)。
   */
  rules?: string;
  skills?: string;
}

/* 常設文脈の上限。プロンプト全体が本文で既に大きいので、見出し・名前だけに絞って総量を抑える */
const RULES_MAX_LINES = 80;
const RULES_MAX_CHARS = 6000;
const SKILLS_MAX_LINES = 120;
const SKILLS_MAX_CHARS = 8000;
const DESC_MAX_CHARS = 120;

/*
 * 見出し行(# 〜 ####)だけを抜く。本文は機密・サイズの両面で渡さない。
 * コードフェンス内の「# コメント」は見出しではないので ``` / ~~~ のトグルで読み飛ばす。
 */
export function headingLines(file: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return []; // 無い・読めないファイルはスキップ
  }
  const out: string[] = [];
  // 開いているフェンス(記号と長さ)。CommonMark と同じく、閉じるのは同種かつ開始以上の長さで
  // info string を持たない行だけ。入れ子(```` の中の ```)で外側が閉じたと誤認しないため
  let fence: { ch: string; len: number } | null = null;
  for (const line of text.split('\n')) {
    const m = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (m) {
      if (!fence) fence = { ch: m[1][0], len: m[1].length };
      else if (m[1][0] === fence.ch && m[1].length >= fence.len && !m[2].trim()) fence = null;
      continue;
    }
    if (!fence && /^#{1,4}\s/.test(line)) out.push(line.trimEnd());
  }
  return out;
}

/*
 * プロンプトに載せる「常設文脈」を集める。
 * rules = CLAUDE.md の見出しだけ、skills = このプロジェクトで使える定義の name — description。
 * 孤児(projectPath null)はプロジェクトの CLAUDE.md を特定できないので
 * `~/.claude/CLAUDE.md` の見出しのみ、skills は user scope のみ。
 * home は既定で scan.ts の HOME。テストから擬似ホームを差せるよう引数にする(実環境依存を断つ)。
 */
export function collectTriageContext(
  sec: MemorySection,
  sections: Section[],
  opts: { home?: string } = {},
): { rules: string; skills: string } {
  const home = opts.home || HOME;
  const pp = sec.projectPath;
  const files: { file: string; label: string }[] = [];
  if (pp) {
    files.push({ file: path.join(pp, 'CLAUDE.md'), label: 'CLAUDE.md' });
    files.push({ file: path.join(pp, '.claude', 'CLAUDE.md'), label: '.claude/CLAUDE.md' });
  }
  files.push({
    file: path.join(home, '.claude', 'CLAUDE.md'),
    label: '~/.claude/CLAUDE.md',
  });

  const ruleLines: string[] = [];
  for (const f of files) {
    const heads = headingLines(f.file);
    if (!heads.length) continue;
    ruleLines.push('## ' + f.label, ...heads);
  }
  const rules = ruleLines.slice(0, RULES_MAX_LINES).join('\n').slice(0, RULES_MAX_CHARS);

  const skillLines: string[] = [];
  for (const s of sections) {
    // project は完全一致だけ。入れ子の別プロジェクト(サブディレクトリ・worktree)の定義は
    // cwd がそこでないと効かないので「このプロジェクトで常時有効」には載せない
    const inScope = s.source === 'user' || (s.source === 'project' && !!pp && s.note === pp);
    if (!inScope) continue;
    for (const it of s.items) {
      if (it.kind === 'hook') continue; // hook は name/description を注入しないので昇格先にならない
      skillLines.push(
        '- ' + it.kind + ' ' + it.name + ' — ' + it.description.slice(0, DESC_MAX_CHARS),
      );
    }
  }
  // rules と同じく行数・文字数の二重上限(1 行が極端に長い description でも総量が跳ねないように)
  const skills = skillLines.slice(0, SKILLS_MAX_LINES).join('\n').slice(0, SKILLS_MAX_CHARS);
  return { rules, skills };
}

/* シグナルをプロンプト用の 1 行ずつに(言語別)。無ければ「(なし)」で節を落とさない */
function signalLines(signals: MemorySignal[], lang: Lang): string {
  if (!signals.length) return lang === 'ja' ? '(なし)' : '(none)';
  return signals
    .map((s) => {
      if (lang === 'ja') {
        switch (s.kind) {
          case 'date':
            return `- 本文の最新日付 ${s.value}(${s.days} 日前)`;
          case 'path-missing':
            return `- 参照パスが存在しない: ${s.value}`;
          case 'done-words':
            return `- 完了・廃止を表す語: ${s.value}`;
          case 'branch-merged':
            return `- ブランチ ${s.value} はマージ済み`;
          case 'branch-missing':
            return `- ブランチ ${s.value} はローカルにもリモートにも無い`;
        }
      }
      switch (s.kind) {
        case 'date':
          return `- latest date in body: ${s.value} (${s.days} days ago)`;
        case 'path-missing':
          return `- referenced path does not exist: ${s.value}`;
        case 'done-words':
          return `- completion / deprecation words: ${s.value}`;
        case 'branch-merged':
          return `- branch ${s.value} is already merged`;
        case 'branch-missing':
          return `- branch ${s.value} exists neither locally nor on the remote`;
      }
    })
    .join('\n');
}

/* 1 件分の事実 + 本文。本文は diagnose.ts と同じく 12,000 字で切る */
function itemBlock(
  it: SkillItem,
  usageAvailable: boolean,
  lang: Lang,
  signals: MemorySignal[] = it.signals || [],
): string {
  let body = '';
  try {
    body = parseFrontmatter(fs.readFileSync(it.path, 'utf8')).body.trim().slice(0, 12000);
  } catch {
    /* 読めないファイルは事実だけで判定させる */
  }
  const d = daysAgo(it.updatedAt);
  if (lang === 'ja') {
    return [
      '## file: ' + path.basename(it.path),
      'name: ' + it.name,
      'type: ' + (it.memoryType || 'unknown'),
      'description: ' + it.description,
      '最終更新: ' + (d === null ? '不明' : d + '日前'),
      '索引: ' + (it.indexTokens || 0) + ' tok / 本文: ' + (it.bodyTokens || 0) + ' tok',
      usageAvailable
        ? 'Read: ' + (it.useCount || 0) + '回 / Write・Edit: ' + (it.writeCount || 0) + '回'
        : '参照実績: 計測不能(transcript なし)',
      'signals(機械が拾った鮮度の事実):',
      signalLines(signals, lang),
      '本文:',
      body,
    ].join('\n');
  }
  return [
    '## file: ' + path.basename(it.path),
    'name: ' + it.name,
    'type: ' + (it.memoryType || 'unknown'),
    'description: ' + it.description,
    'last updated: ' + (d === null ? 'unknown' : d + ' days ago'),
    'index: ' + (it.indexTokens || 0) + ' tok / body: ' + (it.bodyTokens || 0) + ' tok',
    usageAvailable
      ? 'Read: ' + (it.useCount || 0) + ' / Write-Edit: ' + (it.writeCount || 0)
      : 'usage: not measurable (no transcripts)',
    'signals (freshness facts collected mechanically):',
    signalLines(signals, lang),
    'body:',
    body,
  ].join('\n');
}

/*
 * 対象件の本文 + 事実 + 索引全文をまとめて 1 プロンプトにする。
 * 判定指針は「機械が断定できないこと」だけを渡し、Read 0 を異常扱いさせない注意を必ず添える
 * (feedback 型は索引 1 行で機能するので、本文が読まれないのが正常)。
 */
export function buildPrompt(
  targets: SkillItem[],
  ctx: TriageContext,
  lang: Lang,
  /* 件ごとの追加シグナル(git 層)。省略時はスキャン時の SkillItem.signals だけ */
  signalsOf: (it: SkillItem) => MemorySignal[] = (it) => it.signals || [],
): string {
  const blocks = targets
    .map((it) => itemBlock(it, ctx.usageAvailable, lang, signalsOf(it)))
    .join('\n\n');
  const files = targets.map((it) => path.basename(it.path)).join(', ');
  const standing =
    lang === 'ja'
      ? '# このプロジェクトで常時有効なもの(重複・昇格先の判断に使う)\n\n' +
        '## CLAUDE.md の見出し\n' +
        (ctx.rules || '(無し)') +
        '\n\n## skill / command / agent\n' +
        (ctx.skills || '(無し)') +
        '\n\n' +
        'これらの本文は渡していない。見出し・名前・description から重複や昇格先の見当を付け、' +
        '確証が無い場合は instruction に「<file> と重複していないか確認してから」と書くこと。\n'
      : '# Always-on context for this project (use it to spot duplicates and promotion targets)\n\n' +
        '## CLAUDE.md headings\n' +
        (ctx.rules || '(none)') +
        '\n\n## skill / command / agent\n' +
        (ctx.skills || '(none)') +
        '\n\n' +
        'Their bodies are NOT provided. Use the headings, names and descriptions to guess duplicates and ' +
        'promotion targets; when you are not certain, write "check it does not duplicate <file> first" ' +
        'in the instruction.\n';
  if (lang === 'ja') {
    return (
      'あなたは Claude Code の自動メモリ(~/.claude/projects/<project>/memory/)の棚卸しをします。\n' +
      '自動メモリは二層構造です: MEMORY.md の索引行は全件が毎セッション注入され(常時コスト)、' +
      '各メモリの本文は Read されたときだけ読まれます(従量コスト)。\n' +
      '各メモリについて、まず「まだ正しいか」(state)を事実で判定し、行き先(verdict)は下の対応表から決め、' +
      'Claude Code にそのまま貼れる指示文まで作ってください。\n\n' +
      '# 原則\n' +
      'memory の本来の住人は、長く変わらない好み・関係・方針・ルールです。project 型は「制約」だけを歓迎し、' +
      '進捗や状態は issue / PR / docs が正です。\n\n' +
      '# 判定の手順\n' +
      '## 1. 置き場所の適合(state に関係なく先に決まる)\n' +
      '| 状況 | 行き先 |\n' +
      '|---|---|\n' +
      '| 別プロジェクトの話 | wrong-project |\n' +
      '| 内容が特定の skill / command の手順や挙動に対する好み(例: PR 作成前に止まる、ブランチ名の確認) | ' +
      'その skill の SKILL.md に追記して memory を消す(to-skill)。全プロジェクトで効くようになる |\n' +
      '| CLAUDE.md や skill に既に同じことが書いてある | delete |\n' +
      '| 一次情報(wiki / issue / PR / docs)が既に外にあり、memory はその目次コピー | delete(移す先は無い。to-docs にしない) |\n\n' +
      '## 2. state(鮮度)を事実で判定する\n' +
      '| state | 意味 |\n' +
      '|---|---|\n' +
      '| current | 今も正しい。恒久的 |\n' +
      '| outdated | 骨子は生きているが一部(日付・パス・手順・type の付け方)が古い。書き直せば使える |\n' +
      '| historical | 過去の事実としては正しいが現在値ではない。記録としての価値はある |\n' +
      '| obsolete | 役目を終えた。記録としての価値もない |\n' +
      '根拠にするもの: 各件の signals(本文の日付・参照パスの実在・ブランチのマージ状況)、最終更新と Read / Write・Edit の新しさ、' +
      '索引の他の行や CLAUDE.md との関係。signals に挙がった事実はそのまま issues に引用してよい。' +
      '最終更新が新しく Write・Edit が続いている件は現役の作業メモなので、完了していない限り historical にしないこと。\n\n' +
      '## 3. verdict は type × state から決める\n' +
      '| type \\ state | current | outdated | historical | obsolete |\n' +
      '|---|---|---|---|---|\n' +
      '| user / feedback | keep(本文が長ければ shrink。強制力が要るなら to-claude-md) | update | delete(方針の履歴を残す意味は薄い) | delete |\n' +
      '| project | keep(制約のみ。進捗メモは issue / PR へ = to-docs) | update | to-docs | delete |\n' +
      '| reference | keep(Read あり)/ to-docs(長期 Read 0) | update(参照先の張り替え) | delete | delete |\n\n' +
      '# 注意\n' +
      '- Read 0 は異常ではありません。feedback 型は索引の 1 行だけでエージェントの行動を変えるため、本文が読まれないのが正常です。Read 0 だけを根拠に削除を勧めないこと。\n' +
      '- project 型の進捗メモの扱い: 最終更新が新しく Write・Edit が続き、本文に未完了の次アクションが残る件は**現役の作業状態**なので current / keep(issue / PR への転記は完了時。reason に「完了時に <転記先> へ」と一言添える)。' +
      '本文自身が完了を記録している(残タスクが merge のみ、loop 終了、push 済み等)なら historical で、外に無い知見だけを転記して削除(to-docs)。索引と本文の食い違いや参照パスの欠損だけなら outdated / update。\n' +
      '- 「参照実績: 計測不能」の件は、参照回数を根拠に使わないこと。\n' +
      '- 索引行を消さない限り常時コストは 1 tok も減りません。指示文では必ず MEMORY.md の索引行の削除に触れること。\n' +
      '- CLAUDE.md 行きは索引 1 行が全文注入に変わるため、多くの場合コストは増えます。\n\n' +
      '# 出力\n' +
      '次の JSON 配列だけを出力してください(前置き・コードフェンス不要):\n' +
      '[{"file": "対象のファイル名(入力の file をそのまま)",\n' +
      '  "state": "current" | "outdated" | "historical" | "obsolete",\n' +
      '  "verdict": "keep" | "shrink" | "to-claude-md" | "to-docs" | "delete" | "wrong-project" | "to-skill" | "update",\n' +
      '  "reason": "そう判断した理由(1〜3文。state の根拠を必ず含める)",\n' +
      '  "issues": ["判断の根拠になった事実(各30字程度、最大4件。無ければ空配列)"],\n' +
      '  "instruction": "Claude Code に貼る指示文(keep のときは空文字)"}]\n\n' +
      '制約:\n' +
      '- 対象ファイル(' +
      files +
      ')それぞれについて 1 要素ずつ、過不足なく出すこと\n' +
      '- state は上記 4 値、verdict は上記 8 値のみ。それ以外の値は使わない。state を省略しない\n' +
      '- update の instruction は「どの記述を何に直すか」(日付・パス・手順・type の付け替え)を具体に書く。' +
      '索引行は消さないが、description が古ければ MEMORY.md の索引行の書き換えも書く\n' +
      '- instruction は各行を「- 」で始める箇条書きで 3〜6 行。改行で区切る(1 行 1 要点)。' +
      '1 行目は「何をどこへ」(意図)、2 行目以降は見落としやすい要点。番号付き(1.)や散文にしない\n' +
      '- 貼る先はこのプロジェクトで動いている Claude Code 本人なので、' +
      'フルパスや手順の詳細は書かず、意図と見落としやすい要点だけを書く\n' +
      '- instruction に必ず含めること: MEMORY.md の該当索引行の削除 / 他メモリからの [[link]] の張り替え / ' +
      'shrink なら何を残し何を本文から出すかの分割線 / to-claude-md なら「全文が毎セッション注入になり +(本文 tok) tok」というコスト警告\n' +
      '- to-skill の instruction に必ず含めること: 追記先の skill / command 名' +
      '(~/.claude/skills/<name>/SKILL.md か .claude/skills/... かの別も書く)/ 追記する 1〜2 行の要旨 / ' +
      'MEMORY.md の該当索引行の削除\n' +
      '- 6 行に収まらない提案は複雑すぎるサインです。より単純な行き先を選ぶこと\n' +
      '- 出力の文章はすべて日本語で書くこと\n\n' +
      '# プロジェクト: ' +
      ctx.projectName +
      '\n\n' +
      standing +
      '\n# MEMORY.md(索引全文)\n' +
      (ctx.index || '(索引なし)') +
      '\n\n# 対象メモリ\n\n' +
      blocks
    );
  }
  return (
    'You are triaging Claude Code auto memory (~/.claude/projects/<project>/memory/).\n' +
    'Auto memory has two layers: every line of the MEMORY.md index is injected into every session ' +
    '(always-on cost), while each memory body is read only when it is Read (pay-per-use cost).\n' +
    'For each memory, first decide from facts whether it is still true (state), then derive the destination ' +
    '(verdict) from the table below, and write an instruction the user can paste into Claude Code.\n\n' +
    '# Principle\n' +
    'Memory is meant for durable things: preferences, relationships, policies and rules. For type project, ' +
    'only constraints belong here; progress and status belong in issues / PRs / docs.\n\n' +
    '# Procedure\n' +
    '## 1. Placement fit (decided first, regardless of state)\n' +
    '| situation | destination |\n' +
    '|---|---|\n' +
    '| belongs to a different project | wrong-project |\n' +
    '| a preference about how a specific skill / command behaves (e.g. stop before creating the PR, ' +
    'confirm the branch name) | add it to that skill SKILL.md and drop the memory (to-skill); ' +
    'it then applies in every project |\n' +
    '| CLAUDE.md or a skill already says the same thing | delete |\n' +
    '| the primary source already lives outside (wiki / issue / PR / docs) and the memory is just an index copy | delete — there is nothing to move; do not use to-docs |\n\n' +
    '## 2. Judge the state (freshness) from facts\n' +
    '| state | meaning |\n' +
    '|---|---|\n' +
    '| current | still true; durable |\n' +
    '| outdated | the gist still holds but parts (dates, paths, steps, the type tag) are stale; rewriting makes it usable |\n' +
    '| historical | true as a record of the past, not as the current value; worth keeping as a record |\n' +
    '| obsolete | served its purpose; no value even as a record |\n' +
    'Evidence: the per-memory signals (dates in the body, whether referenced paths exist, branch merge status), ' +
    'how recent the last update and Read / Write-Edit are, and how it relates to the other index lines and CLAUDE.md. ' +
    'You may quote the signals verbatim in issues. A memory updated recently with ongoing Write-Edit is a live working ' +
    'note: never mark it historical unless the work is finished.\n\n' +
    '## 3. Derive the verdict from type x state\n' +
    '| type \\ state | current | outdated | historical | obsolete |\n' +
    '|---|---|---|---|---|\n' +
    '| user / feedback | keep (shrink if the body is long; to-claude-md if it must be binding) | update | delete (history of a policy has little value) | delete |\n' +
    '| project | keep (constraints only; progress notes go to an issue / PR = to-docs) | update | to-docs | delete |\n' +
    '| reference | keep (has Reads) / to-docs (no Read for a long time) | update (re-point the reference) | delete | delete |\n\n' +
    '# Notes\n' +
    '- Read 0 is NOT an anomaly. A feedback memory changes the agent behaviour from its single index ' +
    'line alone, so its body is never read in normal operation. Never recommend deletion on Read 0 alone.\n' +
    '- Progress notes of type project: when the last update is recent, Write-Edit continues and the body still ' +
    'lists unfinished next actions, it is LIVE working state: current / keep (the move to an issue / PR happens ' +
    'when the work is done; add "move to <target> when done" to the reason). When the body itself records ' +
    'completion (only the merge left, loop finished, pushed), it is historical: move only what is not already ' +
    'outside and delete (to-docs). A mismatch between index and body, or missing referenced paths alone, is outdated / update.\n' +
    '- When usage is "not measurable", do not use read counts as evidence.\n' +
    '- Nothing is saved from the always-on cost unless the index line is removed. Every instruction ' +
    'MUST mention removing the line from MEMORY.md.\n' +
    '- Moving to CLAUDE.md turns one index line into a full-body injection, so it usually costs MORE.\n\n' +
    '# Output\n' +
    'Output ONLY this JSON array (no preamble, no code fences):\n' +
    '[{"file": "the target file name, exactly as given",\n' +
    '  "state": "current" | "outdated" | "historical" | "obsolete",\n' +
    '  "verdict": "keep" | "shrink" | "to-claude-md" | "to-docs" | "delete" | "wrong-project" | "to-skill" | "update",\n' +
    '  "reason": "why (1-3 sentences; always include the evidence for the state)",\n' +
    '  "issues": ["facts behind the call (about 10 words each, max 4; empty array if none)"],\n' +
    '  "instruction": "instruction to paste into Claude Code (empty string when verdict is keep)"}]\n\n' +
    'Constraints:\n' +
    '- Emit exactly one element for each target file (' +
    files +
    '), no more, no less.\n' +
    '- state must be one of the four values and verdict one of the eight values above; never invent ' +
    'another value, never omit state.\n' +
    '- For update, the instruction says concretely which statements change to what (dates, paths, steps, ' +
    'the type tag). The index line stays, but if the description is stale, also say to rewrite the MEMORY.md line.\n' +
    '- instruction is a bullet list of 3 to 6 lines, every line starting with "- ", one point per line, ' +
    'separated by newlines. The first line says what moves where (the intent); the rest are the ' +
    'easy-to-miss points. Never use numbered lists ("1.") or prose.\n' +
    '- It is pasted into the Claude Code session running in THIS project, so state intent and the ' +
    'easy-to-miss points only — no full paths, no step-by-step detail.\n' +
    '- instruction MUST cover: removing the matching line from MEMORY.md; re-pointing [[link]] references ' +
    'from other memories; for shrink, where to cut (what stays, what moves out); for to-claude-md, the cost ' +
    'warning that the full body becomes a per-session injection of +(body tok) tokens.\n' +
    '- For to-skill, the instruction MUST cover: the target skill / command name (and whether it is ' +
    '~/.claude/skills/<name>/SKILL.md or .claude/skills/...); the gist of the 1-2 lines to add; ' +
    'removing the matching line from MEMORY.md.\n' +
    '- A proposal that does not fit in 6 lines is too complex; pick a simpler destination.\n' +
    '- Write all prose in English.\n\n' +
    '# Project: ' +
    ctx.projectName +
    '\n\n' +
    standing +
    '\n# MEMORY.md (full index)\n' +
    (ctx.index || '(no index)') +
    '\n\n# Target memories\n\n' +
    blocks
  );
}

/*
 * 指示文の体裁をモデルに依らず固定する。プロンプトで「- 」箇条書きを指定しても
 * haiku は「1. 2. 3.」、opus は改行なしの散文で返すため、貼り先が読む文章としてここで揃える。
 * 番号・記号を剥がして全行を「- 」始まりにし、散文 1 行で来ても最低 1 箇条にする。
 */
export function normalizeInstruction(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const s = line.trim(); // インデントは先に落とす(「  - a」も箇条書きとして扱う)
      // 記号だけの行は中身が無いので空行と同じ扱いで捨てる
      if (/^(?:\d+[.)]|[-*・•])$/.test(s)) return '';
      // ASCII 記号・番号は区切りの空白を必須にする。空白ゼロを許すと
      // 「-40 tok」→「40 tok」、「1.5 倍」→「5 倍」と内容が変わってしまう。
      // 「・」「•」は数値・符号と紛れないので、空白なしの「・a」も箇条書きとして剥がす
      return s.replace(/^(?:(?:\d+[.)]|[-*])\s+|[・•]\s*)/, '').trim();
    })
    .filter((line) => line.length > 0)
    .map((line) => '- ' + line)
    .join('\n');
}

/*
 * 採用できなかった件の記録。誤った行き先を出さないのは従来どおりだが、
 * 「診断済み・出力不正」として残さないと差分診断のたびに同じ件を呼び直すことになる。
 */
export const invalidTriage = (): MemoryTriage => ({
  verdict: 'keep',
  reason: '',
  issues: [],
  instruction: '',
  error: 'invalid-output',
});

/*
 * 出力を検証つきでパース。file 対応が取れない要素(対象外・欠落・重複)は捨て、
 * verdict が 8 値以外・state が 4 値以外(欠落含む)・keep 以外で指示文が空の要素は出力不正として記録する
 * (誤った行き先は提示しないが、診断済みであることは残して再 call を防ぐ)。
 */
export function parseTriage(text: string, allowedFiles: string[]): Map<string, MemoryTriage> {
  const stripped = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const j = JSON.parse(stripped);
  if (!Array.isArray(j)) throw new Error('triage output is not an array');
  const allowed = new Set(allowedFiles);
  const out = new Map<string, MemoryTriage>();
  for (const e of j) {
    const file = typeof e?.file === 'string' ? e.file.trim() : '';
    if (!allowed.has(file) || out.has(file)) continue; // 対象外・欠落・重複(先勝ち)
    const verdict = e?.verdict as MemoryVerdict;
    const state = e?.state as MemoryState;
    if (!VERDICTS.includes(verdict) || !STATES.includes(state)) {
      out.set(file, invalidTriage());
      continue;
    }
    const issues = (Array.isArray(e?.issues) ? e.issues : [])
      .filter((x: unknown) => typeof x === 'string')
      .map((s: string) => s.slice(0, 80))
      .slice(0, 4);
    const instruction =
      verdict === 'keep' ? '' : normalizeInstruction(String(e?.instruction || ''));
    // 行き先だけ言って指示文が無い件は貼るものが無く、サマリ・試算・まとめコピーで数え方がずれる。
    // 不正な verdict と同じく「誤った提案を出すより欠けるほうが安全」で出力不正にする
    if (verdict !== 'keep' && !instruction) {
      out.set(file, invalidTriage());
      continue;
    }
    out.set(file, {
      verdict,
      state,
      reason: String(e?.reason || '')
        .trim()
        .slice(0, 400),
      issues,
      instruction: instruction.slice(0, 1200),
    });
  }
  return out;
}

/*
 * 再診断の対象選定。stale 条件は diagnose.ts と同じく本文 hash + lang のみで、
 * 経過日・Read 実績・他メモリの構成変化ではキャッシュを無効化しない(force で全件)。
 * 例外: state(鮮度)を持たない旧形式のエントリは stale(次の差分診断で置き換わる)。
 * 出力不正のエントリは state が無くても stale にしない(同じ出力を繰り返すモデルで無限に呼び直さない)。
 */
export function selectStale(
  items: SkillItem[],
  store: TriageStore,
  lang: Lang,
  force: boolean,
): SkillItem[] {
  if (force) return [...items];
  return items.filter((it) => {
    const cached = store[it.path];
    return (
      !cached ||
      cached.lang !== lang ||
      cached.hash !== contentHash(it.path) ||
      (!cached.state && !cached.error)
    );
  });
}

export interface TriageResult extends MemoryTriage {
  file: string;
  path: string;
}

/*
 * 累積サイズが limit を超えない範囲で items を前から詰めて分割する。
 * 1 件で limit を超えるものは単独チャンクにする(落とすと診断が欠けるため)。
 */
export function chunkByChars<T>(items: T[], sizeOf: (t: T) => number, limit: number): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let sum = 0;
  for (const item of items) {
    const size = sizeOf(item);
    if (current.length && sum + size > limit) {
      out.push(current);
      current = [];
      sum = 0;
    }
    current.push(item);
    sum += size;
  }
  if (current.length) out.push(current);
  return out;
}

/*
 * 1 プロンプトの上限。実測では最大の環境でも 26 件 / 13.4k tok で 1 チャンクに収まるが、
 * 件数が極端に多い環境でモデルのコンテキストを超えるのを避けるための保険として分割する。
 */
const PROMPT_MAX_CHARS = 160_000;

/*
 * 1 プロジェクト分の棚卸し。未キャッシュの件だけを集めて claude を呼ぶ(通常は 1 回、
 * 上限を超える件数のときだけチャンク分割して順に呼ぶ)。
 * 入力が大きい(全件の本文)ので timeout は groups.ts と同じ 10 分。
 */
export async function triageProject(
  sec: MemorySection,
  lang: Lang,
  model: AiModel = 'haiku',
  // sections は遅延評価。キャッシュ済みの再訪ではフルスキャンを払わずに済ませる
  opts: { force?: boolean; files?: string[]; sections?: () => Section[] } = {},
): Promise<TriageResult[]> {
  const wanted = opts.files?.length ? new Set(opts.files.map((f) => path.basename(f))) : null;
  const targets = wanted
    ? sec.items.filter((it) => wanted.has(path.basename(it.path)))
    : [...sec.items];
  if (!targets.length) return [];

  const store = loadTriage();
  const stale = selectStale(targets, store, lang, !!opts.force);
  if (stale.length) {
    const standing = collectTriageContext(sec, opts.sections?.() || []);
    const ctx: TriageContext = {
      projectName: sec.projectName,
      index: readIndexText(sec.note),
      usageAvailable: sec.usageAvailable,
      rules: standing.rules,
      skills: standing.skills,
    };
    // git 層のシグナル(ブランチのマージ状況)は診断時にだけ集める。プロジェクトごとに git を 1 回
    const branches = loadBranches(sec.projectPath);
    const gitSignals = new Map<string, MemorySignal[]>();
    for (const it of stale) {
      if (!branches) break;
      try {
        const body = parseFrontmatter(fs.readFileSync(it.path, 'utf8')).body;
        gitSignals.set(it.path, branchSignals(body, branches));
      } catch {
        /* 読めない件はシグナル無し */
      }
    }
    const signalsOf = (it: SkillItem) => [
      ...(it.signals || []),
      ...(gitSignals.get(it.path) || []),
    ];
    // ctx(索引全文・常設文脈)はチャンクごとに付け直す(重複・別プロジェクト判定に必ず要る)
    const chunks = chunkByChars(
      stale,
      (it) => itemBlock(it, ctx.usageAvailable, lang, signalsOf(it)).length,
      PROMPT_MAX_CHARS,
    );
    for (const chunk of chunks) {
      const text = await runClaude(buildPrompt(chunk, ctx, lang, signalsOf), model, 600000);
      const parsed = parseTriage(
        text,
        chunk.map((it) => path.basename(it.path)),
      );
      const generatedAt = new Date().toISOString();
      for (const it of chunk) {
        // AI が返さなかった件も出力不正として hash 付きで残す
        // (未診断のままだと差分診断のたびに再 call され続ける。force で再試行できる)
        const r = parsed.get(path.basename(it.path)) || invalidTriage();
        const git = gitSignals.get(it.path) || [];
        store[it.path] = {
          ...r,
          ...(git.length ? { signals: git } : {}),
          hash: contentHash(it.path),
          lang,
          model,
          generatedAt,
        };
      }
      // チャンクごとに保存する(後続チャンクが失敗しても済んだ分の call を無駄にしない)
      saveTriage(store);
    }
  }

  const results: TriageResult[] = [];
  for (const it of targets) {
    const e = store[it.path];
    if (!e) continue;
    results.push({
      file: path.basename(it.path),
      path: it.path,
      verdict: e.verdict,
      ...(e.state ? { state: e.state } : {}),
      reason: e.reason,
      issues: e.issues,
      instruction: e.instruction,
      ...(e.signals?.length ? { signals: e.signals } : {}),
      ...(e.error ? { error: e.error } : {}),
    });
  }
  return results;
}

/*
 * スキャン結果にキャッシュ済み診断を付与(内容が変わっていれば付けない)。
 * store は selectStale と同じくテストから差し替えられるよう引数にする。
 */
export function attachMemoryTriage(memory: MemorySection[], lang: Lang, store?: TriageStore): void {
  if (!memory.length) return;
  // memory が 0 件のときはキャッシュ読み込みごと省く(デフォルト引数だとガードより先に走る)
  const s = store ?? loadTriage();
  for (const sec of memory) {
    for (const it of sec.items) {
      const cached = s[it.path];
      if (
        cached &&
        cached.lang === lang &&
        fs.existsSync(it.path) &&
        cached.hash === contentHash(it.path)
      ) {
        it.aiTriage = {
          verdict: cached.verdict,
          ...(cached.state ? { state: cached.state } : {}),
          reason: cached.reason,
          issues: cached.issues,
          instruction: cached.instruction,
          ...(cached.signals?.length ? { signals: cached.signals } : {}),
          // 出力不正も「診断済み」として載せる(未診断と区別し、再診断を促す)
          ...(cached.error ? { error: cached.error } : {}),
        };
      }
    }
  }
}
