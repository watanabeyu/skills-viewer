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
  FeedbackBodyPlan,
  FeedbackHowPlan,
  FeedbackIndexPlan,
  FeedbackWhyPlan,
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
import { repoRootOf } from './memory';
import { branchSignals, episodicTokens, loadBranches } from './memory-signals';
import { HOME, parseFrontmatter } from './scan';
import { contentHash, runClaude } from './summary';
import { encodeProjectPath } from './usage';
import * as crypto from 'node:crypto';

/*
 * 診断キャッシュの鍵。本文だけでなく MEMORY.md の索引行も含める
 * (索引行だけ直したときに「索引を書き換えよ」という古い診断が残らないように)。索引行が無ければ従来の contentHash
 */
export function triageHash(it: SkillItem): string | null {
  const base = contentHash(it.path);
  if (base === null || !it.indexLine) return base;
  return base + ':' + crypto.createHash('sha256').update(it.indexLine).digest('hex').slice(0, 8);
}

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
/*
 * プロジェクト不明(orphan)セクションで採用できる verdict(判断 5)。置き場所の判定
 * (wrong-project / 重複による delete / to-claude-md・to-docs・to-skill への昇格)は
 * 逆引き先のプロジェクトが無いと前提が成立しないため、鮮度に関する 3 値だけを許す。
 */
const ORPHAN_ALLOWED_VERDICTS: readonly MemoryVerdict[] = ['keep', 'shrink', 'update'];
/*
 * 型ガードにしておくと、格下げ側(demoted)に「実際に格下げされ得る値」だけが流れることを
 * 型でも保証できる(MemoryTriage.demoted の Exclude 型と同じ集合)
 */
function isOrphanRestricted(
  verdict: MemoryVerdict,
): verdict is Exclude<MemoryVerdict, 'keep' | 'shrink' | 'update'> {
  return !ORPHAN_ALLOWED_VERDICTS.includes(verdict);
}
const WHY_PLANS: readonly FeedbackWhyPlan[] = ['keep', 'generalize', 'drop'];
const HOW_PLANS: readonly FeedbackHowPlan[] = ['keep', 'keep-lines-only', 'drop'];
const INDEX_PLANS: readonly FeedbackIndexPlan[] = ['keep', 'rewrite', 'align'];

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
  /* プロジェクトの実パス(プロジェクト不明は無し)。「このプロジェクト」が何かを AI に示す(別プロジェクト判定の基準) */
  projectPath?: string | null;
  /*
   * プロジェクト不明(判断 5)か。判定の真実源は MemorySection.orphan 一つで、
   * ここへ渡ってこない直接呼び出し(テスト等)だけ projectPath === null にフォールバックする
   */
  orphan?: boolean;
  /* memory の実体があるディレクトリの実パス。値は常に運び、プロンプトに出すのは
   * プロジェクト不明のときだけ(buildPrompt 側で出し分ける) */
  memDir?: string;
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
 * プロジェクト不明(projectPath null)はプロジェクトの CLAUDE.md を特定できないので
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

/*
 * プロンプトに埋めるパスの無害化。パスは外部入力(ディレクトリ名・本文由来)なので、
 * 改行を含むと節や箇条書きの構造を偽装できてしまう。改行を落とし、長さも切って
 * 1 行に収める(候補一覧・signals・プロジェクト行で共通に通す)。
 */
export function promptPath(p: string): string {
  return p.replace(/[\r\n]+/g, ' ').slice(0, 200);
}

/* この件の signals が指す「別の登録プロジェクト」のフルパス(重複排除)。wrong-project の候補そのもの */
export function otherProjectPaths(signals: MemorySignal[]): string[] {
  return [...new Set(signals.filter((s) => s.kind === 'other-project').map((s) => s.value))];
}

/*
 * wrong-project の移動先候補(判断 3)。件ごとの other-project シグナルの値を、
 * scanMemory が算出した「別の登録プロジェクト」集合(自分自身・worktree・入れ子は除外済み)で
 * 絞る。候補が空の件は wrong-project を採用しない(parseTriage が keep へ格下げする)
 */
export function candidatesFor(sec: MemorySection, signals: MemorySignal[]): string[] {
  const registered = new Set(sec.otherProjects || []);
  return otherProjectPaths(signals).filter((p) => registered.has(p));
}

/*
 * 移動先の memory ディレクトリ。memory はリポジトリ単位で共有される(worktree にも
 * サブディレクトリにも専用の memory dir は作られない)ので、slug はリポジトリのルート
 * = repoRootOf から算出する(登録パスのままでは実在しない slug になる)。
 * 表記は絶対パス。web の事実ヘッダ(sec.note)も一覧の副題も絶対パスなので、
 * コピー文の中でパス表記が `~/` と絶対パスに混在しないように揃える。
 */
export function targetMemDirOf(project: string, home: string = HOME): string {
  const projectsDir = path.join(home, '.claude', 'projects');
  // 算出より観測を優先: 登録パス自身の slug に memory が既に実在するなら、それが正。
  // 「実在」は scanMemory の採用条件と同じ「MEMORY.md 以外の *.md が 1 件以上」で判定する
  // (空ディレクトリや索引だけの残骸に負けて、実体と別の slug へ誘導しないため。home はテスト注入用)
  const own = path.join(projectsDir, encodeProjectPath(project), 'memory');
  try {
    if (fs.readdirSync(own).some((f) => f.endsWith('.md') && f !== 'MEMORY.md')) return own;
  } catch {
    /* 無い・読めない → 算出(リポジトリルート基準)へフォールバック */
  }
  return path.join(projectsDir, encodeProjectPath(repoRootOf(project) ?? project), 'memory');
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
          case 'how-restates':
            return `- How to apply は description の再掲(類似度 ${s.value})`;
          case 'why-episodic':
            return `- Why にエピソード固有の語: ${s.value}`;
          case 'has-exception':
            return `- 本文に例外・但し書きあり: 「${s.value}」`;
          case 'first-line-restates':
            return `- 1 行目は description の再掲(類似度 ${s.value}。正常な形)`;
          case 'body-over':
            return `- feedback として本文が長い(${s.value} tok)`;
          case 'other-project':
            return `- 本文が別の登録プロジェクト「${promptPath(s.value)}」配下のパスを指している`;
          case 'index-mismatch':
            return `- 索引行と本文が違うことを言っている`;
          case 'index-beyond-limit':
            return `- この索引行は MEMORY.md の読み込み上限(200 行 / 25KB)の外にあり、毎セッション読まれていない`;
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
        case 'how-restates':
          return `- How to apply restates the description (similarity ${s.value})`;
        case 'why-episodic':
          return `- Why contains episode-specific tokens: ${s.value}`;
        case 'has-exception':
          return `- the body has an exception / caveat: "${s.value}"`;
        case 'first-line-restates':
          return `- the first line restates the description (similarity ${s.value}; this is the normal shape)`;
        case 'body-over':
          return `- long for a feedback memory (${s.value} tok)`;
        case 'other-project':
          return `- the body points at a path under another registered project "${promptPath(s.value)}"`;
        case 'index-mismatch':
          return `- the index line and the body say different things`;
        case 'index-beyond-limit':
          return `- this index line is outside MEMORY.md's read limit (200 lines / 25KB) and is not read every session`;
      }
    })
    .join('\n');
}

/*
 * 1 件分の事実 + 本文。本文は diagnose.ts と同じく 12,000 字で切る。
 * `## file:` の basename は parseTriage が出力を突き合わせる照合キーなので promptPath を通さない
 * (加工すると返ってきた file 名と一致しなくなり、全件が対象外として捨てられる)。
 * 既知の限界: 改行入りのファイル名はプロンプト構造を崩し得るが、それにはローカル書き込みが
 * 必要(= その時点で memory 本文も書ける)ため、target と同様の表示写像化はしていない。
 */
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
  /*
   * 件ごとの wrong-project 移動先候補。プロンプトに載せる候補と parseTriage の検証は
   * 同じ集合でなければならないので、呼び出し側が両方に同じ関数を渡せるようにする
   */
  candidatesOf: (it: SkillItem) => string[] = (it) => otherProjectPaths(signalsOf(it)),
): string {
  /* orphan 判定は 1 変数に落として全分岐で使う(節ごとに条件が食い違うと自己矛盾したプロンプトになる) */
  const orphan = ctx.orphan ?? ctx.projectPath === null;
  const blocks = targets
    .map((it) => itemBlock(it, ctx.usageAvailable, lang, signalsOf(it)))
    .join('\n\n');
  const files = targets.map((it) => path.basename(it.path)).join(', ');
  /*
   * wrong-project の移動先候補。登録プロジェクトを全部載せるとトークンが嵩むうえ、
   * other-project シグナルの無い件は wrong-project にできない(採用時に格下げされる)ので、
   * 対象件のシグナルに実際に出たパスだけを「どの件で出たか」と一緒に列挙する。
   * パスはモデルに書かせず、この一覧からの選択にする(捏造した移動先を出させないため)。
   * orphan では wrong-project 自体を選べないので集計もしない(候補を見せると制限と矛盾する)。
   */
  const cands = new Map<string, string[]>();
  if (!orphan)
    for (const it of targets) {
      for (const p of candidatesOf(it)) {
        if (!cands.has(p)) cands.set(p, []);
        cands.get(p)!.push(path.basename(it.path));
      }
    }
  const candLines = [...cands]
    .map(
      ([p, hits]) =>
        '- ' +
        promptPath(p) +
        (lang === 'ja' ? '(該当: ' : ' (seen in: ') +
        // ファイル名も FS 由来の外部入力。要素ごとに 1 行化し、件数は上限で切る
        // (結合後にまとめて切るとファイル名が途中で壊れるため)
        hits.slice(0, 8).map(promptPath).join(', ') +
        (hits.length > 8 ? ', …' : '') +
        ')',
    )
    .join('\n');
  /* orphan は候補ブロックごと出さない(「候補なし」の 1 行だけ。判断 5 の制限と衝突させない) */
  const candidates = orphan
    ? (lang === 'ja'
        ? '(プロジェクト不明のため wrong-project は選べない。候補なし)'
        : '(unknown project: wrong-project cannot be chosen, so there are no destination candidates)') +
      '\n\n'
    : lang === 'ja'
      ? '# wrong-project の移動先候補(この一覧のパスだけを "target" に使える)\n' +
        (candLines ||
          '(候補なし。どの件にも「別の登録プロジェクトの配下パス」シグナルが無いので wrong-project は選べない)') +
        '\n' +
        '"target" は、その件の signals に出たパスをこの一覧の表記のままコピーして返すこと' +
        '(短縮・補完・生成はしない)。移動先の文面はツール側が組むので、パス以外は書かなくてよい。\n\n'
      : '# Destination candidates for wrong-project (only a path from this list may be used as "target")\n' +
        (candLines ||
          '(no candidates: no memory here has a "path under another registered project" signal, so wrong-project cannot be chosen)') +
        '\n' +
        'Copy the path that appears in the signals of that memory verbatim from this list into "target" ' +
        '(never shorten, complete or invent one). The wording around it is generated by the tool.\n\n';
  /*
   * orphan では常設文脈ごと省く。置き場所の判定(重複による delete・昇格先)をさせない以上
   * 材料としての用が無く、プロンプトのトークンを食うだけなので載せない。
   */
  const standing = orphan
    ? ''
    : lang === 'ja'
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
  /*
   * プロジェクト不明(orphan)セクション向けの追加節(判断 5)。
   * スラッグは逆引き不能なディレクトリ名のエンコードであって実在パスではないので、
   * モデルが所在や移動先を捏造しないよう明記し、verdict を鮮度側の 3 値だけに縛る。
   * 実体の在り処はサーバーが知っている確定事実なので、テンプレ表記に加えて実パスも 1 行で渡す
   * (モデルに推測させない)。鮮度の着地点も書かないと「obsolete なのに keep」が矛盾に見えてしまう。
   */
  const memDirLine = ctx.memDir
    ? (lang === 'ja'
        ? 'このセクションの memory ディレクトリ: '
        : 'memory directory of this section: ') +
      promptPath(ctx.memDir) +
      '\n'
    : '';
  const orphanNote =
    lang === 'ja'
      ? 'このセクションはプロジェクトへの逆引きに失敗している(プロジェクト名はディレクトリ名のエンコード表記であり、' +
        '非英数字は "-" に置き換わっている)。memory の実体は `~/.claude/projects/<スラッグ>/memory/` にある。' +
        '所在や移動先を推測しないこと。\n' +
        memDirLine +
        '置き場所の判定(別プロジェクトの話 = wrong-project / 重複による delete / ' +
        'to-claude-md・to-docs・to-skill への昇格)はできない。verdict は keep / shrink / update のみを使うこと。' +
        'それ以外を答えても採用されない。\n' +
        'state が historical / obsolete でも verdict は keep とし、その根拠は reason / issues に書くこと' +
        '(プロジェクトを特定できれば削除・移設の候補になる、という見立ては reason に残してよい)。\n'
      : 'This section failed to resolve back to a registered project (the project name is an encoded ' +
        'directory name where non-alphanumeric characters become "-", not an actual path). The memory bodies ' +
        'actually live under `~/.claude/projects/<slug>/memory/`; do not guess its location or a destination.\n' +
        memDirLine +
        'Placement judgements (wrong-project, delete for duplicates, promotion to CLAUDE.md / docs / a skill) ' +
        'are not possible here. verdict must be one of keep / shrink / update only; anything else will not be ' +
        'adopted.\n' +
        'Even when the state is historical or obsolete, the verdict stays keep: put the evidence in reason / ' +
        'issues (you may note in reason that it would be a candidate for deletion or a move once the project ' +
        'is identified).\n';
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
      // orphan では wrong-project 自体を禁じている(orphanNote)ので、行き方の説明も載せない
      (orphan
        ? ''
        : '| 別プロジェクトの話(signals に「別の登録プロジェクトの配下パス」がある件**のみ**選べる。' +
          'そのパスを "target" にそのまま返す) | wrong-project |\n') +
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
      '最終更新が新しく Write・Edit が続いている件は現役の作業メモなので、完了していない限り historical にしないこと。' +
      'feedback / user 型で、description(索引行)と本文(1 行目や How to apply)が**異なる境界や段階**を言っている場合' +
      '(例: 索引は「コミットで止める」、本文は「push まで進めて PR 作成の前で止める」)は outdated / update とし、' +
      '索引行の書き換え(body の index = rewrite)を含めること。索引 1 行で動く型では、索引側の文言が実際の行動を決めている。\n\n' +
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
      '# feedback / user 型の本文(verdict が shrink / update のとき)\n' +
      '本文は「1 行目(ルール)/ **Why:** / **How to apply:**」の定型です。散文で何を残すか書く代わりに、' +
      '次の表で分類して "body" を返してください(1 行目は常に残すので選択肢にありません):\n' +
      '| signals | 分類 |\n' +
      '|---|---|\n' +
      '| How to apply は description の再掲、かつ例外・境界なし | how = drop |\n' +
      '| 本文に例外(〜なら除く)や境界(どこまで進めてよいか・いつ止まるか)がある | how = keep-lines-only(keep_lines に本文からそのまま抜粋。生成しない。例外と境界の両方を拾う)。それ以外に固有の手順があるなら keep |\n' +
      '| Why にエピソード固有の語(ブランチ名 / #番号 / 日付 / ユーザーが指摘) | why = generalize(why_rewrite に固有名詞・日付・人名を含まない 1 文) |\n' +
      '| Why が「ユーザーが指摘した」だけで理由が無い | why = drop |\n' +
      '| Why が時間に依存しない理由を書いている | why = keep |\n' +
      '| description(索引行)が本文と異なる境界・段階を言っている | index = rewrite(index_rewrite に本文と一致する新しい description を 1 行。固有名詞・日付なし) |\n' +
      '| description が本文と一致している | index = keep |\n' +
      '迷ったら残す側(keep)に倒すこと。\n\n' +
      '# 出力\n' +
      '次の JSON 配列だけを出力してください(前置き・コードフェンス不要):\n' +
      '[{"file": "対象のファイル名(入力の file をそのまま)",\n' +
      '  "state": "current" | "outdated" | "historical" | "obsolete",\n' +
      '  "index_matches_body": true | false(索引行の description と本文が同じ境界・段階・内容を言っていれば true、違うことを言っていれば false。全件必須),\n' +
      '  "verdict": "keep" | "shrink" | "to-claude-md" | "to-docs" | "delete" | "wrong-project" | "to-skill" | "update",\n' +
      (orphan
        ? ''
        : '  "target": "wrong-project のときのみ必須。移動先候補の一覧から選んだパスをそのまま(他の verdict では省略)",\n') +
      '  "reason": "そう判断した理由(1〜3文。state の根拠を必ず含める)",\n' +
      '  "issues": ["判断の根拠になった事実(各30字程度、最大4件。無ければ空配列)"],\n' +
      '  "instruction": "Claude Code に貼る指示文(keep のときは空文字)",\n' +
      '  "body": {"why": "keep" | "generalize" | "drop", "why_rewrite": "generalize のときの 1 文(それ以外は空文字)",\n' +
      '           "how": "keep" | "keep-lines-only" | "drop", "keep_lines": ["本文からの抜粋(例外・境界)"],\n' +
      '           "index": "keep" | "rewrite", "index_rewrite": "rewrite のときの新しい description(それ以外は空文字)"}\n' +
      '          (feedback / user 型で verdict が shrink / update のときだけ。それ以外は省略)}]\n\n' +
      '制約:\n' +
      '- 対象ファイル(' +
      files +
      ')それぞれについて 1 要素ずつ、過不足なく出すこと\n' +
      '- state は上記 4 値、verdict は上記 8 値のみ。それ以外の値は使わない。state を省略しない\n' +
      (orphan
        ? '- verdict は keep / shrink / update のみを使う(それ以外はその件ごと不採用になる)\n'
        : '- wrong-project は signals に「別の登録プロジェクトの配下パス」がある件だけに使い、' +
          '"target" に候補一覧のパスをそのまま入れる。シグナルが無い件を wrong-project にしない' +
          '(移動先を推測で書かない)。候補外・欠落の "target" はその件ごと不採用になる\n') +
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
      promptPath(ctx.projectName) +
      (ctx.projectPath ? '(パス: ' + promptPath(ctx.projectPath) + ')' : '') +
      '\n' +
      (orphan
        ? orphanNote
        : 'この memory の持ち主は上のプロジェクトです。signals に「別の登録プロジェクトの配下パス」がある件は、' +
          'その参照が上のプロジェクトでの作業に必要なもの(例: 連携先の設定ファイル)でない限り wrong-project とし、' +
          'wrong-project にしない場合は reason にその根拠を書くこと。\n') +
      '\n' +
      candidates +
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
    // orphan では wrong-project 自体を禁じている(orphanNote)ので、行き方の説明も載せない
    (orphan
      ? ''
      : '| belongs to a different project (ONLY selectable when the signals of that memory show a path under ' +
        'another registered project; return that path as "target") | wrong-project |\n') +
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
    'note: never mark it historical unless the work is finished. For type feedback / user, when the description ' +
    '(the index line) and the body (first line or How to apply) state a DIFFERENT boundary or stage (e.g. the index says ' +
    '"stop at commit" while the body says "push is fine, stop before creating the PR"), it is outdated / update and the ' +
    'index line must be rewritten (body.index = rewrite) — for a memory that works from its index line, the index wording ' +
    'is what actually drives behaviour.\n\n' +
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
    '# Bodies of type feedback / user (when the verdict is shrink / update)\n' +
    'The body follows a fixed shape: first line (the rule) / **Why:** / **How to apply:**. Instead of ' +
    'describing in prose what to keep, classify with this table and return "body" (the first line is always kept, ' +
    'so it is not a choice):\n' +
    '| signals | classification |\n' +
    '|---|---|\n' +
    '| How to apply restates the description and there is no exception or boundary | how = drop |\n' +
    '| the body has an exception (unless ...) or a boundary (how far to go / when to stop) | how = keep-lines-only (quote them verbatim in keep_lines; never invent; take both exceptions and boundaries). keep if there are other specific steps |\n' +
    '| Why contains episode-specific tokens (branch, #number, date, "the user pointed out") | why = generalize (why_rewrite: one sentence with no names, dates or people) |\n' +
    '| Why is only "the user pointed it out" with no reason | why = drop |\n' +
    '| Why states a reason that does not depend on time | why = keep |\n' +
    '| the description (index line) states a different boundary / stage than the body | index = rewrite (index_rewrite: a new one-line description that matches the body; no names or dates) |\n' +
    '| the description matches the body | index = keep |\n' +
    'When in doubt, lean to keep.\n\n' +
    '# Output\n' +
    'Output ONLY this JSON array (no preamble, no code fences):\n' +
    '[{"file": "the target file name, exactly as given",\n' +
    '  "state": "current" | "outdated" | "historical" | "obsolete",\n' +
    '  "index_matches_body": true | false (true when the description in the index line says the same boundary / stage / content as the body, false when they differ; required for every element),\n' +
    '  "verdict": "keep" | "shrink" | "to-claude-md" | "to-docs" | "delete" | "wrong-project" | "to-skill" | "update",\n' +
    (orphan
      ? ''
      : '  "target": "required for wrong-project only: a path copied verbatim from the candidate list (omit for other verdicts)",\n') +
    '  "reason": "why (1-3 sentences; always include the evidence for the state)",\n' +
    '  "issues": ["facts behind the call (about 10 words each, max 4; empty array if none)"],\n' +
    '  "instruction": "instruction to paste into Claude Code (empty string when verdict is keep)",\n' +
    '  "body": {"why": "keep" | "generalize" | "drop", "why_rewrite": "one sentence when generalize (else empty)",\n' +
    '           "how": "keep" | "keep-lines-only" | "drop", "keep_lines": ["verbatim quotes from the body (exceptions and boundaries)"],\n' +
    '           "index": "keep" | "rewrite", "index_rewrite": "the new description when rewrite (else empty)"}\n' +
    '          (only for type feedback / user with verdict shrink / update; omit otherwise)}]\n\n' +
    'Constraints:\n' +
    '- Emit exactly one element for each target file (' +
    files +
    '), no more, no less.\n' +
    '- state must be one of the four values and verdict one of the eight values above; never invent ' +
    'another value, never omit state.\n' +
    (orphan
      ? '- verdict must be one of keep / shrink / update; anything else makes that element unusable.\n'
      : '- Use wrong-project only for a memory whose own signals show a path under another registered project, ' +
        'and put that path into "target" exactly as listed in the candidates. Never use wrong-project without ' +
        'that signal (never guess a destination); a missing or unlisted "target" makes the whole element unusable.\n') +
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
    promptPath(ctx.projectName) +
    (ctx.projectPath ? ' (path: ' + promptPath(ctx.projectPath) + ')' : '') +
    '\n' +
    (orphan
      ? orphanNote
      : 'The memories belong to the project above. When signals show paths under another registered project, ' +
        'the verdict is wrong-project unless that reference is needed for work in the project above (e.g. a ' +
        'config file of an integration); if you do not choose wrong-project, state the evidence in reason.\n') +
    '\n' +
    candidates +
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
/*
 * "body"(feedback の残す / 削る分類)の検証。要素自体は捨てず、不正なら body だけを落として
 * 散文 instruction にフォールバックさせる。exceptions は本文に実在する抜粋だけ残し(捏造を弾く)、
 * why_rewrite にエピソード固有の語が残っていれば「一般化できていない」ので body ごと落とす。
 */
export function parseBodyPlan(raw: unknown, bodyText: string): FeedbackBodyPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const why = e.why as FeedbackWhyPlan;
  const how = e.how as FeedbackHowPlan;
  // index は省略可(省略 = keep)。旧名 exceptions も keep_lines として読む(出力の揺れに寛容に)
  const index = (e.index ?? 'keep') as FeedbackIndexPlan;
  if (!WHY_PLANS.includes(why) || !HOW_PLANS.includes(how) || !INDEX_PLANS.includes(index))
    return null;
  const norm = (x: string) => x.replace(/\s+/g, '');
  const bodyNorm = norm(bodyText);
  const rawLines = Array.isArray(e.keep_lines)
    ? e.keep_lines
    : Array.isArray(e.exceptions)
      ? e.exceptions
      : [];
  const keepLines = rawLines
    .filter((x: unknown): x is string => typeof x === 'string')
    .map((x: string) => x.trim().slice(0, 200))
    .filter((x: string) => x && bodyNorm.includes(norm(x)))
    .slice(0, 4);
  // 例外・境界だけ残す指示なのに本文に実在する行が 1 つも無ければ、指示として成立しない
  if (how === 'keep-lines-only' && !keepLines.length) return null;
  let whyRewrite = '';
  if (why === 'generalize') {
    whyRewrite = String(e.why_rewrite || '')
      .trim()
      .slice(0, 200);
    if (!whyRewrite || episodicTokens(whyRewrite).length) return null;
  }
  let indexRewrite = '';
  if (index === 'rewrite') {
    indexRewrite = String(e.index_rewrite || '')
      .trim()
      .slice(0, 160);
    // 索引行は毎セッション注入なので固有名詞・日付は持ち込ませない
    if (!indexRewrite || episodicTokens(indexRewrite).length) return null;
  }
  return {
    why,
    ...(whyRewrite ? { whyRewrite } : {}),
    how,
    keepLines,
    index,
    ...(indexRewrite ? { indexRewrite } : {}),
  };
}

/*
 * 出力から JSON 配列を取り出す。コードフェンスだけでなく、弱いモデルが付ける前置き・後書き
 * (「メモリ 2 件を棚卸しました: [...]」)も許容する: まず全体を試し、だめなら最初の [ から
 * 最後の ] までを試す。どちらも失敗なら例外(呼び出し側で 400)。
 */
export function extractJsonArray(text: string): unknown {
  const stripped = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf('[');
    const end = stripped.lastIndexOf(']');
    if (start < 0 || end <= start) throw new Error('triage output has no JSON array');
    return JSON.parse(stripped.slice(start, end + 1));
  }
}

export function parseTriage(
  text: string,
  allowedFiles: string[],
  /* file → 本文(body の exceptions 検証用。渡さなければ body は付けない) */
  bodies: Map<string, string> = new Map(),
  /*
   * file → wrong-project の移動先候補(その件の other-project シグナルの値)。
   * 渡されない / 空の件は「機械シグナル無し」なので wrong-project を採用しない
   */
  candidates: Map<string, string[]> = new Map(),
  /* orphan: プロジェクト不明セクションの棚卸しか(判断 5。verdict を keep/shrink/update に制限) */
  opts: { orphan?: boolean } = {},
): Map<string, MemoryTriage> {
  const j = extractJsonArray(text);
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
    const reason = String(e?.reason || '')
      .trim()
      .slice(0, 400);
    // 欠落・非 boolean は undefined(シグナルを出さない)。モデルが省略しても要素は捨てない
    const idxMatch =
      typeof e?.index_matches_body === 'boolean'
        ? { indexMatchesBody: e.index_matches_body as boolean }
        : {};
    /*
     * プロジェクト不明(orphan)の verdict 制限(判断 5)。置き場所の判定は逆引き先が無いと
     * 前提が成立しないため、keep / shrink / update 以外はここで keep へ格下げする
     * (出力不正ではない: モデルは正しいスキーマで答えている)。wrong-project もここで弾くので、
     * 以降の候補照合(cands)には進まない。
     */
    if (opts.orphan && isOrphanRestricted(verdict)) {
      out.set(file, {
        verdict: 'keep',
        state,
        reason,
        issues,
        instruction: '',
        demoted: verdict,
        // 格下げの理由。orphan は一時的な環境条件なので、解消したら再診断に乗せる(selectStale)
        demotedBy: 'orphan',
        ...idxMatch,
      });
      continue;
    }
    /*
     * wrong-project のゲート。移動先は事実(機械シグナル)からしか決められないので:
     *   - シグナルが無い件は keep へ格下げし、demoted に元の verdict を残す(観察は続ける)
     *   - シグナルがある件も移動先は候補からの選択だけを受け取る(候補外・欠落は出力不正)
     * 格下げでは指示文を捨てる。捏造した移動先を含んでいるため貼れない
     */
    const cands = candidates.get(file) || [];
    let dest: Pick<MemoryTriage, 'target' | 'targetMemDir'> = {};
    if (verdict === 'wrong-project') {
      if (!cands.length) {
        out.set(file, {
          verdict: 'keep',
          state,
          reason,
          issues,
          instruction: '',
          demoted: 'wrong-project',
          // 内容側の理由(シグナルが無い)なので、本文が変わらない限り再診断はしない
          demotedBy: 'no-signal',
          ...idxMatch,
        });
        continue;
      }
      /*
       * 候補はプロンプトへ promptPath(改行落とし + 200 字切り)を通した「表示文字列」で
       * 載せているので、照合も表示文字列で行う(生パスで比べると、長い・改行入りのパスは
       * 一覧どおりにコピーされても必ず不一致になる)。採用するのは写像で戻した生パス。
       * 表示が衝突する候補は戻せない(どちらか決められない)ので null にして無効化する。
       */
      const byDisplay = new Map<string, string | null>();
      for (const c of cands) {
        const d = promptPath(c);
        // 表示が同じでも生パスまで同じなら衝突ではない(candidates は重複排除済みだが、公開関数として防御)
        byDisplay.set(d, byDisplay.has(d) && byDisplay.get(d) !== c ? null : c);
      }
      const answer = typeof e?.target === 'string' ? e.target.trim() : '';
      const target = byDisplay.get(promptPath(answer)) ?? null;
      if (!target) {
        out.set(file, invalidTriage());
        continue;
      }
      dest = { target, targetMemDir: targetMemDirOf(target) };
    }
    const instruction =
      verdict === 'keep' ? '' : normalizeInstruction(String(e?.instruction || ''));
    // 行き先だけ言って指示文が無い件は貼るものが無く、サマリ・試算・まとめコピーで数え方がずれる。
    // 不正な verdict と同じく「誤った提案を出すより欠けるほうが安全」で出力不正にする。
    // ただし移動先が確定した wrong-project は web がテンプレートで指示文を組むので、
    // モデルが散文を返さなくても貼るものは欠けない(プロンプトでも「パス以外は書かなくてよい」と伝えている)
    if (verdict !== 'keep' && !instruction && !dest.target) {
      out.set(file, invalidTriage());
      continue;
    }
    const bodyText = bodies.get(file);
    const body =
      bodyText !== undefined && (verdict === 'shrink' || verdict === 'update')
        ? parseBodyPlan(e?.body, bodyText)
        : null;
    out.set(file, {
      verdict,
      state,
      reason,
      issues,
      // 移動先が確定した wrong-project は web がテンプレートで指示文を組むので、モデルの散文は
      // キャッシュにも応答にも残さない(格下げ側と対称。捏造混じりの文面をコピーさせない)
      instruction: dest.target ? '' : instruction.slice(0, 1200),
      ...dest,
      ...(body ? { body } : {}),
      ...idxMatch,
    });
  }
  return out;
}

/*
 * 「索引と本文が食い違う」という AI の回答を機械的に結果へ反映する(行き先は上書きしない):
 *   - index-mismatch シグナルを付ける(verdict が keep でも UI に出る = 埋もれない)
 *   - feedback の分類で index = keep のままなら align(どちらが正しいか確認して揃える)に差し替える
 */
export function applyIndexMismatch(r: MemoryTriage, it: SkillItem): MemoryTriage {
  if (r.error || r.indexMatchesBody !== false) return r;
  const signals = [...(r.signals || [])];
  if (!signals.some((s) => s.kind === 'index-mismatch'))
    signals.push({ kind: 'index-mismatch', value: it.description.slice(0, 40) });
  const body = r.body && r.body.index === 'keep' ? { ...r.body, index: 'align' as const } : r.body;
  return { ...r, signals, ...(body ? { body } : {}) };
}

/*
 * ゲート導入前(v0.8.0)の wrong-project キャッシュか。移動先はモデルの散文任せで、
 * 捏造された移動先を含みうる。再診断の対象にする条件と、キャッシュを表示に載せない条件は
 * 同じでなければならない(片方だけ緩いと捏造がそのまま貼れてしまう)ので 1 箇所に置く。
 * demoted / error は現状 verdict が keep になるためここには来ないが、防御として条件に残す:
 * Phase C で demoted が元の verdict を保持する形に変わっても素通りしないため。
 */
export function isLegacyWrongProject(e: MemoryTriage): boolean {
  return e.verdict === 'wrong-project' && !e.target && !e.demoted && !e.error;
}

/*
 * プロジェクト不明(orphan)セクションの表示ゲート(判断 5)。parseTriage は生成時にこの制限を
 * かけるが、制限の導入前(Phase B まで)に生成されたキャッシュは wrong-project / delete / to-* が
 * demoted 無しで残り得るので、保存値は書き換えずに表示のたびに読み替える。
 * verdict が既に keep(= 新形式で格下げ済み、または元から keep)なら isOrphanRestricted が false を
 * 返すのでそのまま通る(冪等)。target / targetMemDir は置き場所判定の結果なので orphan では持たせず、
 * body(残す / 削る分類)も keep に対応しないので落とす。
 */
export function orphanTriage<T extends MemoryTriage>(e: T): T {
  if (e.error || !isOrphanRestricted(e.verdict)) return e;
  // delete 演算子ではなく分割代入で落とす(元オブジェクトを触らず、落とす鍵を 1 行で見せる)。
  // body は置き場所判定の結果ではないが keep には対応しない分類なので、防御として一緒に落とす
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 束縛は「落とす」ためだけで値は使わない
  const { target: _t, targetMemDir: _d, body: _b, ...rest } = e;
  return {
    ...(rest as T),
    verdict: 'keep',
    demoted: e.verdict,
    demotedBy: 'orphan',
    instruction: '',
  };
}

/*
 * 再診断の対象選定。stale 条件は diagnose.ts と同じく本文 hash + lang のみで、
 * 経過日・Read 実績・他メモリの構成変化ではキャッシュを無効化しない(force で全件)。
 * 例外: state(鮮度)を持たない旧形式のエントリは stale(次の差分診断で置き換わる)。
 * 出力不正のエントリは state が無くても stale にしない(同じ出力を繰り返すモデルで無限に呼び直さない)。
 * 例外 2: wrong-project ゲート導入前の wrong-project(target も demoted も無い)は stale。
 * 移動先が捏造だった事故の発端そのものなので自動で再診断に乗せる。
 * 例外 3: orphan を理由に格下げされたエントリは、そのセクションが orphan でなくなったら stale。
 * 未マウント・登録抹消といった環境条件が解消したのに、制限つきの診断結果が居座り続けないようにする。
 * 全件を stale にはしない(安全化と無関係な旧エントリに再診断コストを払わせない)。
 */
export function selectStale(
  items: SkillItem[],
  store: TriageStore,
  lang: Lang,
  force: boolean,
  /* そのセクションがプロジェクト不明か(判断 5。orphan 格下げを解消したときの再診断判定に使う) */
  opts: { orphan?: boolean } = {},
): SkillItem[] {
  if (force) return [...items];
  return items.filter((it) => {
    const cached = store[it.path];
    return (
      !cached ||
      cached.lang !== lang ||
      cached.hash !== triageHash(it) ||
      (!cached.state && !cached.error) ||
      isLegacyWrongProject(cached) ||
      (!opts.orphan && cached.demotedBy === 'orphan')
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
  opts: {
    force?: boolean;
    files?: string[];
    sections?: () => Section[];
    /* モデル呼び出しの注入点(既定は runClaude)。配線をテストから 1 本通すために開けてある */
    run?: (prompt: string) => Promise<string>;
  } = {},
): Promise<TriageResult[]> {
  const wanted = opts.files?.length ? new Set(opts.files.map((f) => path.basename(f))) : null;
  const targets = wanted
    ? sec.items.filter((it) => wanted.has(path.basename(it.path)))
    : [...sec.items];
  if (!targets.length) return [];

  // orphan 判定の真実源はセクション(scanMemory が付ける)。プロンプト・パース・表示ゲートで同じ値を使う
  const orphan = !!sec.orphan;
  const run = opts.run ?? ((prompt: string) => runClaude(prompt, model, 600000));
  const store = loadTriage();
  const stale = selectStale(targets, store, lang, !!opts.force, { orphan });
  if (stale.length) {
    // orphan は常設文脈(CLAUDE.md 見出し・skill 一覧)をプロンプトに載せない(置き場所判定を
    // しないため)ので、遅延フルスキャンごとスキップして無駄な走査を払わない
    const standing = orphan
      ? { rules: '', skills: '' }
      : collectTriageContext(sec, opts.sections?.() || []);
    const ctx: TriageContext = {
      projectName: sec.projectName,
      projectPath: sec.projectPath,
      orphan,
      // memory の実体の在り処。プロジェクト不明のときだけプロンプトに出す
      // (逆引きできない環境でモデルに所在を推測させないための、サーバー側の確定事実)
      memDir: sec.note,
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
    // orphan では wrong-project そのものを採用しないので、候補は集めない
    // (プロンプトにも parseTriage にも渡らない = 「選べる」と読める材料を一切出さない)
    const candidatesOf = orphan ? () => [] : (it: SkillItem) => candidatesFor(sec, signalsOf(it));
    const candidates = new Map<string, string[]>();
    if (!orphan)
      for (const it of stale) {
        const cands = candidatesOf(it);
        if (cands.length) candidates.set(path.basename(it.path), cands);
      }
    // body(残す / 削る分類)の検証には本文が要る。対象は feedback / user 型だけ
    const bodies = new Map<string, string>();
    for (const it of stale) {
      if (it.memoryType !== 'feedback' && it.memoryType !== 'user') continue;
      try {
        bodies.set(path.basename(it.path), parseFrontmatter(fs.readFileSync(it.path, 'utf8')).body);
      } catch {
        /* 読めない件は body 無し(散文にフォールバック) */
      }
    }
    // ctx(索引全文・常設文脈)はチャンクごとに付け直す(重複・別プロジェクト判定に必ず要る)
    const chunks = chunkByChars(
      stale,
      (it) => itemBlock(it, ctx.usageAvailable, lang, signalsOf(it)).length,
      PROMPT_MAX_CHARS,
    );
    for (const chunk of chunks) {
      const text = await run(buildPrompt(chunk, ctx, lang, signalsOf, candidatesOf));
      const parsed = parseTriage(
        text,
        chunk.map((it) => path.basename(it.path)),
        bodies,
        candidates,
        { orphan },
      );
      const generatedAt = new Date().toISOString();
      for (const it of chunk) {
        // AI が返さなかった件も出力不正として hash 付きで残す
        // (未診断のままだと差分診断のたびに再 call され続ける。force で再試行できる)
        const raw = parsed.get(path.basename(it.path)) || invalidTriage();
        const git = gitSignals.get(it.path) || [];
        const r = applyIndexMismatch({ ...raw, ...(git.length ? { signals: git } : {}) }, it);
        store[it.path] = {
          ...r,
          hash: triageHash(it),
          lang,
          model,
          generatedAt,
        };
        // 移動先ディレクトリは保存しない。読み手(attach / 結果組み立て)は常に target から
        // 都度算出するので、キャッシュに古い移動先を残すと誤参照の余地だけが増える
        delete store[it.path].targetMemDir;
      }
      // チャンクごとに保存する(後続チャンクが失敗しても済んだ分の call を無駄にしない)
      saveTriage(store);
    }
  }

  const results: TriageResult[] = [];
  for (const it of targets) {
    const e = store[it.path];
    if (!e) continue;
    const raw: TriageResult = {
      file: path.basename(it.path),
      path: it.path,
      verdict: e.verdict,
      ...(e.state ? { state: e.state } : {}),
      reason: e.reason,
      issues: e.issues,
      instruction: e.instruction,
      ...(e.signals?.length ? { signals: e.signals } : {}),
      ...(e.body ? { body: e.body } : {}),
      ...(e.indexMatchesBody !== undefined ? { indexMatchesBody: e.indexMatchesBody } : {}),
      // wrong-project の移動先(選択済み)と、格下げの記録(要確認の表示に使う)。
      // 移動先ディレクトリは attachMemoryTriage と同じくキャッシュ値ではなく target から都度算出
      ...(e.target ? { target: e.target, targetMemDir: targetMemDirOf(e.target) } : {}),
      ...(e.demoted ? { demoted: e.demoted } : {}),
      // 格下げ理由も載せる(表示ゲート経由の件は orphanTriage が付けるので、キャッシュ由来と対称に)
      ...(e.demotedBy ? { demotedBy: e.demotedBy } : {}),
      ...(e.error ? { error: e.error } : {}),
    };
    // orphan セクションは表示時にも verdict 制限をかける(制限導入前のキャッシュ対策。判断 5)
    results.push(orphan ? orphanTriage(raw) : raw);
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
      // ゲート導入前の wrong-project は付与しない(= 未診断扱い)。捏造された移動先を含む
      // 指示文を表示・コピーさせないためで、未診断の CTA と selectStale の再診断に自然に乗る。
      // orphan を理由に格下げされた診断も、そのセクションが orphan でなくなったら同じく未診断扱い
      // (制限つきの結果が、逆引きできるようになった後も居座らないように。selectStale と同じ条件)
      if (
        cached &&
        cached.lang === lang &&
        fs.existsSync(it.path) &&
        cached.hash === triageHash(it) &&
        !isLegacyWrongProject(cached) &&
        !(!sec.orphan && cached.demotedBy === 'orphan')
      ) {
        const raw: MemoryTriage = {
          verdict: cached.verdict,
          ...(cached.state ? { state: cached.state } : {}),
          reason: cached.reason,
          issues: cached.issues,
          instruction: cached.instruction,
          ...(cached.signals?.length ? { signals: cached.signals } : {}),
          ...(cached.body ? { body: cached.body } : {}),
          ...(cached.indexMatchesBody !== undefined
            ? { indexMatchesBody: cached.indexMatchesBody }
            : {}),
          // 移動先ディレクトリはキャッシュ値を信用せず target から都度算出する
          // (診断後に worktree 化・リネームがあると、固定値は実在しない slug を指すため)
          ...(cached.target
            ? { target: cached.target, targetMemDir: targetMemDirOf(cached.target) }
            : {}),
          ...(cached.demoted ? { demoted: cached.demoted } : {}),
          // 格下げ理由も載せる(表示ゲート経由の件は orphanTriage が付けるので、キャッシュ由来と対称に)
          ...(cached.demotedBy ? { demotedBy: cached.demotedBy } : {}),
          // 出力不正も「診断済み」として載せる(未診断と区別し、再診断を促す)
          ...(cached.error ? { error: cached.error } : {}),
        };
        // orphan セクションは表示時にも verdict 制限をかける(制限導入前のキャッシュ対策。判断 5)
        it.aiTriage = sec.orphan ? orphanTriage(raw) : raw;
      }
    }
  }
}
