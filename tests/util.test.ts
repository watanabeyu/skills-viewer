import { afterEach, describe, expect, it } from 'vitest';
import type { MemorySection, MemoryVerdict, SkillItem } from '../src/shared/types';
import type { KindFilter, UseFilter } from '../web/src/util';
import { itemKey } from '../web/src/api';
import {
  KIND_FILTERS,
  USE_FILTERS,
  asKindFilter,
  asUseFilter,
  estimateLabel,
  backlinksOf,
  brokenLinkCount,
  copyInstruction,
  diagnosisInstruction,
  factHeader,
  invocationOf,
  kindMatches,
  memoryListSearch,
  refMatches,
  sameNameOthers,
  skewedVerdict,
  sortItems,
  sortMemory,
  usageLine,
  usageMatches,
  buildFeedbackInstruction,
  effectiveInstruction,
  changeMarkOf,
  changeRows,
  changedProjectCount,
  claudeMdCounts,
  contextRows,
  contextTotal,
  duplicateNames,
  labelOfUseFilter,
  migrateLegacyParams,
  resolveProject,
  sessionSections,
  type FlatItem,
} from '../web/src/util';
import type { Section, SkillsData, SnapshotChanges } from '../src/shared/types';
import { setLang, t } from '../web/src/i18n';
import type { FeedbackBodyPlan } from '../src/shared/types';

/* 言語は各テストの後に必ず既定(en)へ戻す(setLang し忘れが後続テストへ漏れないように) */
afterEach(() => setLang('en'));

const base = (over: Partial<SkillItem> = {}): SkillItem => ({
  name: 'foo',
  description: 'desc',
  argumentHint: '',
  version: '',
  kind: 'skill',
  path: '/p/.claude/skills/foo/SKILL.md',
  files: [],
  ...over,
});

describe('usageLine (呼び出し例の表記)', () => {
  it('skill は /名前 + 引数ヒント', () => {
    expect(usageLine(base({ argumentHint: '<PR>' }))).toBe('/foo <PR>');
  });
  it('agent は @名前、hook / memory は空', () => {
    expect(usageLine(base({ kind: 'agent' }))).toBe('@foo');
    expect(usageLine(base({ kind: 'hook' }))).toBe('');
    expect(usageLine(base({ kind: 'memory' }))).toBe(''); // memory は起動形を持たない
  });
});

describe('invocationOf (起動経路の判定)', () => {
  it('実測が最優先', () => {
    expect(invocationOf(base({ typedCount: 3, autoCount: 1 }))).toEqual({
      kind: 'both',
      basis: 'measured',
    });
    expect(invocationOf(base({ typedCount: 3 }))).toEqual({ kind: 'human', basis: 'measured' });
    expect(invocationOf(base({ autoCount: 2 }))).toEqual({ kind: 'agent', basis: 'measured' });
  });
  it('実測が無ければ AI 判定にフォールバック', () => {
    expect(invocationOf(base({ aiInvocation: 'both' }))).toEqual({ kind: 'both', basis: 'ai' });
    expect(invocationOf(base())).toBeNull();
  });
});

describe('sortItems', () => {
  const items = [
    base({ name: 'b', useCount: 5, lastUsed: 10, updatedAt: 1 }),
    base({ name: 'a', useCount: 1, lastUsed: 30, updatedAt: 2 }),
    base({ name: 'c', updatedAt: 3 }),
  ];
  it('name / uses / recent / updated の各順', () => {
    expect(sortItems(items, 'name').map((i) => i.name)).toEqual(['a', 'b', 'c']);
    expect(sortItems(items, 'uses').map((i) => i.name)).toEqual(['b', 'a', 'c']);
    expect(sortItems(items, 'recent').map((i) => i.name)).toEqual(['a', 'b', 'c']);
    expect(sortItems(items, 'updated').map((i) => i.name)).toEqual(['c', 'a', 'b']);
  });
});

describe('usageMatches (使用実績フィルタ)', () => {
  const used = base({ useCount: 3 });
  const unused = base();
  const hook = base({ kind: 'hook' });
  it('all は常に通す', () => {
    expect(usageMatches(used, 'all', true)).toBe(true);
    expect(usageMatches(hook, 'all', false)).toBe(true);
  });
  it('used / unused を出し分ける(hook はどちらにも含めない)', () => {
    expect(usageMatches(used, 'used', true)).toBe(true);
    expect(usageMatches(unused, 'used', true)).toBe(false);
    expect(usageMatches(used, 'unused', true)).toBe(false);
    expect(usageMatches(unused, 'unused', true)).toBe(true);
    expect(usageMatches(hook, 'used', true)).toBe(false);
    expect(usageMatches(hook, 'unused', true)).toBe(false);
  });
  it('トランスクリプトが無い環境では unused に何も出さない', () => {
    expect(usageMatches(unused, 'unused', false)).toBe(false);
  });
});

describe('itemKey', () => {
  it('同一ファイル・同一イベント名の hook 同士でもキーが衝突しない', () => {
    // 重複キーがあると React がソート変更・グループ化切替の並べ替えで DOM を壊す
    const h1 = base({
      kind: 'hook',
      name: 'PostToolUse (Write|Edit)',
      path: '/p/.claude/settings.json',
      description: 'a.sh',
    });
    const h2 = base({
      kind: 'hook',
      name: 'PostToolUse (Write|Edit)',
      path: '/p/.claude/settings.json',
      description: 'b.sh',
    });
    expect(itemKey(h1)).not.toBe(itemKey(h2));
  });

  it('hook 以外は path#name(URL 互換を維持)', () => {
    expect(itemKey(base())).toBe('/p/.claude/skills/foo/SKILL.md#foo');
  });
});

describe('kindMatches / sameNameOthers', () => {
  it('kind フィルタ', () => {
    expect(kindMatches(base(), 'all')).toBe(true);
    expect(kindMatches(base({ kind: 'agent' }), 'agent')).toBe(true);
    expect(kindMatches(base({ kind: 'agent' }), 'skill')).toBe(false);
  });

  it('同名の別定義を short name で見つける(自分自身と hook は除外)', () => {
    const me = { ...base(), key: 'k1' };
    const all = [
      me,
      { ...base({ path: '/other/SKILL.md' }), key: 'k2' },
      { ...base({ name: 'plugin:foo', path: '/pl.md' }), key: 'k3' },
      { ...base({ kind: 'hook' as const, path: '/s.json' }), key: 'k4' },
      { ...base({ name: 'unrelated' }), key: 'k5' },
    ];
    expect(sameNameOthers(me, all).map((x) => x.key)).toEqual(['k2', 'k3']);
  });
});

/* ---- memory 軸(plan 10 Phase D)の純関数 ---- */

const mem = (name: string, over: Partial<SkillItem> = {}): SkillItem =>
  base({ name, kind: 'memory', path: `/m/${name}.md`, ...over });

/* 事実ヘッダの元になる 1 プロジェクト分のセクション(note = memory ディレクトリの実パス) */
const memSection = (items: SkillItem[]): MemorySection => ({
  id: '-w-alpha',
  projectPath: '/w/alpha',
  projectName: 'alpha',
  note: '/h/.claude/projects/-w-alpha/memory',
  usageAvailable: true,
  indexTokens: 0,
  items,
});

describe('sortMemory (memory 軸の並び順)', () => {
  const items = [
    mem('b', { indexTokens: 30, bodyTokens: 900, updatedAt: 200 }),
    mem('a', { indexTokens: 30, bodyTokens: 100, updatedAt: 100 }),
    mem('c', { indexTokens: 50, bodyTokens: 500 }),
  ];
  it('index は索引トークンが多い順、同値は名前順', () => {
    expect(sortMemory(items, 'index').map((i) => i.name)).toEqual(['c', 'a', 'b']);
  });
  it('body は本文トークンが多い順', () => {
    expect(sortMemory(items, 'body').map((i) => i.name)).toEqual(['b', 'c', 'a']);
  });
  it('updated は更新が古い順(更新日不明は末尾)', () => {
    expect(sortMemory(items, 'updated').map((i) => i.name)).toEqual(['a', 'b', 'c']);
  });
  /* サーバーは stat に失敗した項目に updatedAt: 0 を載せるので、0 も「不明」として末尾に置く */
  it('updatedAt: 0(stat 失敗)は最古ではなく不明として末尾', () => {
    const withZero = [...items, mem('z', { updatedAt: 0 })];
    expect(sortMemory(withZero, 'updated').map((i) => i.name)).toEqual(['a', 'b', 'c', 'z']);
  });
  it('name は名前順', () => {
    expect(sortMemory(items, 'name').map((i) => i.name)).toEqual(['a', 'b', 'c']);
  });
  /*
   * 計画 13 Phase D round2: 読み込み上限(200 行 / 25KB)の外にある索引行は実際には注入されない。
   * 「減らす価値が高い順」を意図した並びなので 0 として扱う(セクション合計の数え方と同じ)。
   */
  it('index は上限外(indexBeyondLimit)の索引行を 0 として並べる', () => {
    const withBeyond = [...items, mem('x', { indexTokens: 99, indexBeyondLimit: true })];
    expect(sortMemory(withBeyond, 'index').map((i) => i.name)).toEqual(['c', 'a', 'b', 'x']);
  });
  it('元の配列を変更しない', () => {
    const before = items.map((i) => i.name);
    sortMemory(items, 'index');
    expect(items.map((i) => i.name)).toEqual(before);
  });
});

describe('refMatches (参照フィルタ)', () => {
  const read = mem('r', { useCount: 2 });
  const unread = mem('u');
  it('all は常に通す(計測不能でも)', () => {
    expect(refMatches(read, 'all', true)).toBe(true);
    expect(refMatches(unread, 'all', false)).toBe(true);
  });
  it('read / unread を Read 回数で出し分ける', () => {
    expect(refMatches(read, 'read', true)).toBe(true);
    expect(refMatches(unread, 'read', true)).toBe(false);
    expect(refMatches(read, 'unread', true)).toBe(false);
    expect(refMatches(unread, 'unread', true)).toBe(true);
  });
  it('トランスクリプトが無いプロジェクトは「未参照」ではなく判定不能なので、どちらにも含めない', () => {
    expect(refMatches(read, 'read', false)).toBe(false);
    expect(refMatches(unread, 'unread', false)).toBe(false);
  });
});

describe('backlinksOf / brokenLinkCount ([[link]] の被リンクとリンク切れ)', () => {
  // ファイル名 ≠ frontmatter name のケース(旧形式のファイル名が残っている)を含める
  const wiki = mem('wiki-mcp-curl', { path: '/m/reference_wiki_mcp_curl.md' });
  const handoff = mem('handoff', { links: ['wiki-mcp-curl', 'nope'] });
  const deploy = mem('deploy', { links: ['reference_wiki_mcp_curl', 'handoff'] });
  const lonely = mem('lonely', { links: ['lonely'] });
  const items = [wiki, handoff, deploy, lonely];

  it('被リンクは name 一致とファイル名一致のどちらでも拾う', () => {
    expect(backlinksOf(wiki, items).map((i) => i.name)).toEqual(['handoff', 'deploy']);
    expect(backlinksOf(handoff, items).map((i) => i.name)).toEqual(['deploy']);
  });
  it('自分自身へのリンクは被リンクに数えない', () => {
    expect(backlinksOf(lonely, items)).toEqual([]);
  });
  it('リンク切れ数は同プロジェクト内で解決できない発リンクの数', () => {
    expect(brokenLinkCount(handoff, items)).toBe(1); // nope
    expect(brokenLinkCount(deploy, items)).toBe(0);
    expect(brokenLinkCount(wiki, items)).toBe(0); // links 無し
  });
});

/*
 * 判断 7(計画 15 Phase B): 指示文は「事実ヘッダ(機械生成)+ 本文 + 末尾の確認手順」。
 * 前置きを独立して見せることも、まとめてコピーすることもしない(単件ずつ貼る)。
 */
describe('factHeader / copyInstruction (指示文の構成)', () => {
  const item = mem('alpha', {
    aiTriage: { verdict: 'delete', reason: '', issues: [], instruction: '- alpha を消す' },
  });
  const sec = memSection([item, mem('beta')]);

  it('memory ディレクトリ・プロジェクト・対象ファイルを 2 行で出す', () => {
    expect(factHeader(sec, ['a.md', 'b.md'])).toBe(
      'Target: /h/.claude/projects/-w-alpha/memory (project: /w/alpha)\nTarget files: a.md, b.md',
    );
  });

  it('プロジェクト不明は「不明」ラベル(memory ディレクトリは出す)', () => {
    setLang('ja');
    expect(factHeader({ ...sec, projectPath: null }, ['a.md'])).toBe(
      '対象: /h/.claude/projects/-w-alpha/memory(プロジェクト: 不明)\n対象ファイル: a.md',
    );
  });

  it('事実ヘッダ → 本文 → 確認手順 の順に並ぶ', () => {
    expect(copyInstruction(sec, item)).toBe(
      factHeader(sec, ['alpha.md']) +
        '\n\n' +
        // 指示文の先頭には機械生成のフルパスアンカーが付く(手選択コピー対策)
        t('memory.triage.tpl.target', { path: '/m/alpha.md' }) +
        '\n- alpha を消す' +
        '\n\n' +
        t('memory.triage.copyPreamble'),
    );
  });

  it('確認手順は末尾に 1 回だけ付く', () => {
    const steps = t('memory.triage.copyPreamble');
    const text = copyInstruction(sec, item);
    expect(text.endsWith(steps)).toBe(true);
    expect(text.split(steps)).toHaveLength(2);
  });
});

/* skill の発動診断も同じ形。本文は改善案の有無で「次に変える」/「変える場合に残すもの」に分かれる */
describe('diagnosisInstruction (発動診断の指示文)', () => {
  const flat = (over: Partial<SkillItem> = {}): FlatItem => ({
    ...base(over),
    key: 'k',
    secId: 'proj-0',
    source: 'project',
    scopeLabel: 'alpha',
    hasMd: true,
  });
  const header =
    t('diag.instr.hdr', { dir: '/w/alpha', scope: 'alpha' }) +
    '\n' +
    t('diag.instr.file', { path: '/p/.claude/skills/foo/SKILL.md' });

  it('未診断は空文字(ブロックごと出さない)', () => {
    expect(diagnosisInstruction(flat(), '/w/alpha')).toBe('');
  });

  it('改善案があれば description の置き換えを指示する', () => {
    const text = diagnosisInstruction(
      flat({
        aiDiagnosis: { verdict: 'weak', issues: ['発動条件が無い'], improved: 'Use when X' },
      }),
      '/w/alpha',
    );
    expect(text.startsWith(header + '\n\n')).toBe(true);
    expect(text).toContain(t('diag.instr.replace', { file: 'SKILL.md', text: 'Use when X' }));
    expect(text).toContain(t('diag.instr.issues', { list: '発動条件が無い' }));
    expect(text).toContain(t('diag.instr.scope', { name: 'foo' }));
    expect(text.endsWith(t('memory.triage.copyPreamble'))).toBe(true);
  });

  it('改善案が無い(現行と同じ)ときは「変える場合に残すもの」を書く', () => {
    const text = diagnosisInstruction(
      flat({ aiDiagnosis: { verdict: 'good', issues: [], improved: 'desc' } }),
      '/w/alpha',
    );
    expect(text).toContain(t('diag.instr.noChange'));
    expect(text).toContain(t('diag.instr.keepWhat', { desc: 'desc' }));
    expect(text).not.toContain(t('diag.instr.replace', { file: 'SKILL.md', text: 'desc' }));
  });
});

/* 判断 7(計画 13 Phase B): 偏りは verdict を上書きせず警告の材料にするだけ */
describe('estimateLabel (削減試算の文言分岐)', () => {
  const item = (verdict: MemoryVerdict, over: Partial<SkillItem> = {}) =>
    mem('el-' + verdict, {
      indexTokens: 30,
      bodyTokens: 200,
      aiTriage: { verdict, reason: '', issues: [], instruction: '- x' },
      ...over,
    });

  it('to-user-claude-md は「全プロジェクト」注記つきの専用文言(estApplyUserClaude)を使う', () => {
    const label = estimateLabel(item('to-user-claude-md'));
    expect(label).toContain('EVERY project'); // 既定言語 en。全プロジェクト注入の 2 軸目
    expect(label).toContain('always-on'); // 常時注入の 1 軸目
    expect(label).toContain('200');
  });

  it('to-claude-md は従来の estApplyClaude(1 プロジェクトの常時注入)のまま', () => {
    const label = estimateLabel(item('to-claude-md'));
    expect(label).toContain('always-on');
    expect(label).not.toContain('EVERY project');
  });

  it('上限外 + delete 系は estApplyBeyond(索引 ±0 の理由)を優先する', () => {
    const label = estimateLabel(item('delete', { indexBeyondLimit: true }));
    expect(label).toBe(t('memory.triage.estApplyBeyond'));
  });
});

describe('skewedVerdict (提案の偏り検知)', () => {
  const at = (verdict: MemoryVerdict, over: Partial<SkillItem['aiTriage']> = {}) => ({
    aiTriage: { verdict, reason: '', issues: [], instruction: '- x', ...over },
  });
  const items = (n: number, verdict: MemoryVerdict) =>
    Array.from({ length: n }, (_, i) => mem('m' + verdict + i, at(verdict)));

  it('非 keep が 5 件以上で 8 割以上が同一なら、その verdict を返す', () => {
    expect(skewedVerdict(items(5, 'wrong-project'))).toBe('wrong-project');
    // 5 件中 4 件(80%)は境界で警告あり
    expect(skewedVerdict([...items(4, 'wrong-project'), ...items(1, 'delete')])).toBe(
      'wrong-project',
    );
  });

  it('件数が足りない・偏っていないときは警告しない', () => {
    expect(skewedVerdict(items(4, 'wrong-project'))).toBeNull(); // 4 件
    // 6 件中 4 件(66%)は偏りとみなさない
    expect(skewedVerdict([...items(4, 'wrong-project'), ...items(2, 'delete')])).toBeNull();
  });

  it('素の keep と出力不正は母数に入れない', () => {
    const kept = mem('k', at('keep'));
    // error は verdict を持つ形でも除外される(keep で渡すと keep 除外のほうで落ちて検証にならない)
    const broken = mem('e', at('wrong-project', { error: 'invalid-output' as const }));
    expect(skewedVerdict([...items(5, 'delete'), kept, broken])).toBe('delete');
    expect(skewedVerdict([...items(4, 'delete'), kept, broken])).toBeNull();
  });

  it('格下げ済み(demoted)は元の verdict として数える(全件格下げの事故ケースでもバナーが出る)', () => {
    const demoted = (i: number) => mem('d' + i, at('keep', { demoted: 'wrong-project' as const }));
    expect(skewedVerdict(Array.from({ length: 5 }, (_, i) => demoted(i)))).toBe('wrong-project');
    // 格下げと生き残りの wrong-project が混ざっても 1 つの偏りとして数える
    expect(skewedVerdict([...items(3, 'wrong-project'), demoted(0), demoted(1)])).toBe(
      'wrong-project',
    );
  });

  /*
   * プロジェクト不明セクションでの格下げ(判断 5)も同じく元の verdict で数える。
   * 全件が格下げされる状況こそ「診断の前提(プロジェクトの特定)を疑え」という警告の出しどころなので、
   * 格下げ理由が orphan でもバナーを抑制しない(判断 7)
   */
  it('orphan で全件格下げ(delete)でも偏り警告を出す', () => {
    const demotedDelete = (i: number) =>
      mem('od' + i, at('keep', { demoted: 'delete' as const, demotedBy: 'orphan' as const }));
    expect(skewedVerdict(Array.from({ length: 5 }, (_, i) => demotedDelete(i)))).toBe('delete');
  });
});

describe('memoryListSearch (memory 一覧へ戻る URL)', () => {
  it('詳細のタブ状態は捨てる(他の条件は保つ)。view は v0.9.0 で廃止したので立てない', () => {
    const params = new URLSearchParams('q=foo&msort=body&tab=body');
    const next = new URLSearchParams(memoryListSearch(params));
    expect(next.get('view')).toBeNull();
    expect(next.get('tab')).toBeNull();
    expect(next.get('q')).toBe('foo');
    expect(next.get('msort')).toBe('body');
  });
  it('渡された params は変更しない', () => {
    const params = new URLSearchParams('tab=body');
    memoryListSearch(params);
    expect(params.get('tab')).toBe('body');
  });
});

describe('buildFeedbackInstruction / effectiveInstruction (テンプレート指示文)', () => {
  const base = {
    name: 'worktree-reuse',
    description: 'レビュー対応は元ブランチで直接作業',
    argumentHint: '',
    version: '',
    kind: 'memory' as const,
    path: '/m/feedback_worktree_reuse.md',
    files: [],
    memoryType: 'feedback' as const,
  };
  const withPlan = (plan: FeedbackBodyPlan, verdict: 'shrink' | 'update' | 'keep' = 'update') => ({
    ...base,
    aiTriage: {
      verdict,
      state: 'outdated' as const,
      reason: '',
      issues: [],
      instruction: '- 散文',
      body: plan,
    },
  });

  it('ja: 分類からモデル非依存の 5 行を組む', () => {
    setLang('ja');
    const text = buildFeedbackInstruction(base, {
      why: 'generalize',
      whyRewrite: 'レビュー対応は同じ PR の続きだから',
      how: 'drop',
      keepLines: [],
      index: 'rewrite',
      indexRewrite: 'レビュー対応は push まで進めて PR 作成の前で止まる',
    });
    expect(text.split('\n')).toEqual([
      '- feedback_worktree_reuse.md の本文を次の構成に置き換える(索引行は変更しない)',
      '- 1 行目(ルール)はそのまま残す: 「レビュー対応は元ブランチで直接作業」',
      '- Why を次の 1 文に書き換える(固有名詞・日付を落とす): 「レビュー対応は同じ PR の続きだから」',
      '- How to apply は description の再掲なので削除する',
      '- MEMORY.md の索引行の description を「レビュー対応は push まで進めて PR 作成の前で止まる」に書き換える(本文と異なる境界を言っているため)',
    ]);
  });

  it('en: 例外だけ残す分類は抜粋を列挙する', () => {
    const text = buildFeedbackInstruction(base, {
      why: 'keep',
      how: 'keep-lines-only',
      keepLines: ['unless hotfix', 'except CI'],
      index: 'keep',
    });
    expect(text).toContain('- Keep Why as is');
    expect(text).toContain(
      '- In How to apply keep only the exceptions / boundaries: 「unless hotfix」 / 「except CI」',
    );
    expect(text).toContain('- Do not change the MEMORY.md index line');
    // server が align に差し替えた場合は「確認して揃える」の行になる
    expect(
      buildFeedbackInstruction(base, { why: 'keep', how: 'keep', keepLines: [], index: 'align' }),
    ).toContain('- The MEMORY.md index line and the body say different things');
  });

  /* 判断 3(計画 13 Phase B): wrong-project の移動先は server 確定の事実で、文面だけ web が組む */
  const wpItem = {
    ...base,
    aiTriage: {
      verdict: 'wrong-project' as const,
      reason: '',
      issues: [],
      instruction: '- モデルの散文(捏造した移動先を含みうる)',
      target: '/w/other',
      targetMemDir: '/h/.claude/projects/-w-other/memory',
    },
  };

  it('wrong-project は ja / en とも移動元・移動先・対象ファイルをテンプレートに埋める', () => {
    for (const lang of ['ja', 'en'] as const) {
      setLang(lang);
      const text = effectiveInstruction(wpItem);
      // 3 値のどれか 1 つでもプレースホルダを取りこぼすと、貼り先が対象を特定できない
      expect(text).toContain('/w/other');
      expect(text).toContain('/h/.claude/projects/-w-other/memory');
      expect(text).toContain('feedback_worktree_reuse.md');
    }
  });

  it('wrong-project は target / targetMemDir があれば散文でなくテンプレートを使う', () => {
    setLang('ja');
    expect(effectiveInstruction(wpItem).split('\n')).toEqual([
      t('memory.triage.tpl.target', { path: wpItem.path }),
      '- この memory は /w/other の話なので、feedback_worktree_reuse.md を /h/.claude/projects/-w-other/memory へ移す',
      '- 移動先に同じ内容が無いか確認してから移す',
      '- このプロジェクトの MEMORY.md の該当索引行を削除する',
      // 索引行が無いと移動先で毎セッション注入されない(移したのに使われない)ので追加まで指示する
      '- 移動先の MEMORY.md に索引行を追加する(description は現行の索引行を流用)',
      '- 他メモリからの [[link]] を張り替える',
    ]);
    // 移動先が確定していない(server が付けなかった)ときだけ散文にフォールバック
    expect(
      effectiveInstruction({
        ...wpItem,
        aiTriage: { ...wpItem.aiTriage, target: undefined, targetMemDir: undefined },
      }),
    ).toBe(
      t('memory.triage.tpl.target', { path: wpItem.path }) +
        '\n- モデルの散文(捏造した移動先を含みうる)',
    );
  });

  it('effectiveInstruction: body があればテンプレート、無ければ AI の散文、keep や出力不正は空', () => {
    const plan: FeedbackBodyPlan = { why: 'drop', how: 'drop', keepLines: [], index: 'keep' };
    expect(effectiveInstruction(withPlan(plan))).toContain('Replace the body of');
    expect(effectiveInstruction(withPlan(plan, 'keep'))).toBe('');
    expect(
      effectiveInstruction({
        ...base,
        aiTriage: { verdict: 'to-docs', reason: '', issues: [], instruction: '- 散文' },
      }),
    ).toBe(t('memory.triage.tpl.target', { path: base.path }) + '\n- 散文');
    expect(
      effectiveInstruction({
        ...base,
        aiTriage: {
          verdict: 'keep',
          reason: '',
          issues: [],
          instruction: '',
          error: 'invalid-output',
        },
      }),
    ).toBe('');
  });
});

/* ---- ホーム(計画 15 Phase D) ---- */

const secOf = (over: Partial<Section>): Section => ({
  id: 'user',
  source: 'user',
  note: '/h/.claude',
  items: [],
  ...over,
});
const projA = secOf({
  id: 'proj--w-alpha',
  source: 'project',
  projectName: 'alpha',
  isCurrent: true,
  note: '/w/alpha',
  items: [base({ path: '/w/alpha/.claude/skills/foo/SKILL.md' })],
});
const projB = secOf({
  id: 'proj--w-beta',
  source: 'project',
  projectName: 'beta',
  note: '/w/beta',
  items: [base({ name: 'bar', path: '/w/beta/.claude/skills/bar/SKILL.md' })],
});
const userSec = secOf({
  items: [base({ name: 'foo', path: '/h/.claude/skills/foo/SKILL.md', tokens: 10 })],
});
const pluginSec = secOf({ id: 'plugin', source: 'plugin', note: '/h/.claude/plugins' });
const builtinSec = secOf({ id: 'builtin', source: 'built-in', note: '' });
const sections = [projA, projB, userSec, pluginSec, builtinSec];

const dataOf = (over: Partial<SkillsData> = {}): SkillsData => ({
  generatedAt: '',
  cwd: '/w/alpha',
  sections,
  aiStale: 0,
  aiAvailable: true,
  usageAvailable: true,
  changes: null,
  claudeMd: { layers: [], tokens: 0 },
  budget: { used: 0, limit: 2000, source: 'default' },
  context: {
    claudeMd: { tok: 1180 },
    memoryIndex: { tok: 310, lines: 2, limitLines: 200, limitBytes: 25 * 1024 },
    descriptions: { tok: 3370, count: 21, hiddenCount: 2, limit: 2000 },
  },
  ...over,
});

describe('resolveProject (?project= の解決。設計判断 13)', () => {
  it('all はそのまま、既知の id はそのセクション', () => {
    expect(resolveProject('all', sections)).toBe('all');
    expect(resolveProject('proj--w-beta', sections)).toBe(projB);
  });
  it('省略・user・未知の id は cwd のプロジェクトに落とす', () => {
    expect(resolveProject(null, sections)).toBe(projA);
    expect(resolveProject('user', sections)).toBe(projA);
    expect(resolveProject('proj-0', sections)).toBe(projA);
    expect(resolveProject('proj--w-gone', sections)).toBe(projA);
  });
  it('cwd のプロジェクトにアイテムが無ければ null(セクション自体が無い)', () => {
    expect(resolveProject(null, [userSec, pluginSec, builtinSec])).toBeNull();
  });
});

describe('migrateLegacyParams (v0.8 の view / grouped / unused の互換)', () => {
  it('旧キーが無ければ null(何もしない)', () => {
    expect(migrateLegacyParams(new URLSearchParams('q=x&project=all'))).toBeNull();
  });
  it('view=group / flat は全プロジェクトの並びへ写し、旧キーは消す', () => {
    const m = migrateLegacyParams(new URLSearchParams('view=group&q=x'))!;
    expect(m.params.get('project')).toBe('all');
    expect(m.params.get('by')).toBe('group');
    expect(m.params.get('view')).toBeNull();
    expect(m.params.get('q')).toBe('x');
    expect(m.memory).toBe(false);
    expect(migrateLegacyParams(new URLSearchParams('view=flat'))!.params.get('by')).toBe('flat');
  });
  it('view=source は既定なので消すだけ。view=memory は memory 画面への遷移を求める', () => {
    const src = migrateLegacyParams(new URLSearchParams('view=source'))!;
    expect(src.params.toString()).toBe('');
    const mem = migrateLegacyParams(new URLSearchParams('view=memory&msort=body'))!;
    expect(mem.memory).toBe(true);
    expect(mem.params.get('view')).toBeNull();
    expect(mem.params.get('msort')).toBe('body');
  });
  it('grouped=0(v0.5.0)はフラット、unused=1(v0.3.0)は use=unused', () => {
    const g = migrateLegacyParams(new URLSearchParams('grouped=0'))!;
    expect(g.params.get('project')).toBe('all');
    expect(g.params.get('by')).toBe('flat');
    expect(g.params.get('grouped')).toBeNull();
    const u = migrateLegacyParams(new URLSearchParams('unused=1'))!;
    expect(u.params.get('use')).toBe('unused');
    expect(u.params.get('unused')).toBeNull();
    // 新キーが既にあれば旧キーで上書きしない
    expect(migrateLegacyParams(new URLSearchParams('unused=1&use=used'))!.params.get('use')).toBe(
      'used',
    );
  });
});

describe('changeMarkOf / changeRows (① 増えた・変わった)', () => {
  const changes: SnapshotChanges = {
    added: [
      {
        name: 'foo',
        kind: 'skill',
        path: '/w/alpha/.claude/skills/foo/SKILL.md',
        source: 'project',
        author: 'tanaka',
        authoredAt: '2026-09-06T00:00:00Z',
      },
      {
        name: 'bar',
        kind: 'skill',
        path: '/w/beta/.claude/skills/bar/SKILL.md',
        source: 'project',
      },
    ],
    updated: [
      { name: 'foo', kind: 'skill', path: '/h/.claude/skills/foo/SKILL.md', source: 'user' },
    ],
    removed: [{ name: 'old', kind: 'command', path: '/h/.claude/commands/old.md', source: 'user' }],
  };

  it('kind + path で突き合わせ、増えた = add / 変わった = mod。消えたものは一覧に無いので出ない', () => {
    expect(changeMarkOf(projA.items[0], changes)).toBe('add');
    expect(changeMarkOf(userSec.items[0], changes)).toBe('mod');
    expect(changeMarkOf(base({ path: '/x/none.md' }), changes)).toBeNull();
    expect(changeMarkOf(projA.items[0], null)).toBeNull();
    // path が同じでも kind が違えば別物
    expect(changeMarkOf(base({ kind: 'command', path: projA.items[0].path }), changes)).toBeNull();
  });

  it('順は 増えた → 変わった → 消えた。project の項目はプロジェクトへ逆引きされる', () => {
    const rows = changeRows(dataOf({ changes }), 'all');
    expect(rows.map((r) => r.mark)).toEqual(['add', 'add', 'mod', 'del']);
    expect(rows[0].section).toBe(projA);
    expect(rows[0].scopeLabel).toBe('alpha');
    expect(rows[0].item).toBe(projA.items[0]);
    expect(rows[0].when).toBe(Date.parse('2026-09-06T00:00:00Z'));
    expect(rows[1].section).toBe(projB);
    expect(rows[2].scopeLabel).toBe('user');
    expect(rows[3].item).toBeUndefined();
    expect(changedProjectCount(rows)).toBe(2);
  });

  it('プロジェクトを選ぶと、そのプロジェクトのものと user / plugin だけに絞る', () => {
    const rows = changeRows(dataOf({ changes }), projA);
    expect(rows.map((r) => r.entry.name)).toEqual(['foo', 'foo', 'old']);
    expect(rows.map((r) => r.entry.source)).toEqual(['project', 'user', 'user']);
  });

  it('差分が無ければ空(① は「変化なし」の 1 行に畳む)', () => {
    expect(changeRows(dataOf(), 'all')).toEqual([]);
  });

  it('memory の変化は MemorySection.projectPath 経由でプロジェクトを引く', () => {
    const memChanges: SnapshotChanges = {
      added: [
        {
          name: 'note',
          kind: 'memory',
          path: '/h/.claude/projects/-w-alpha/memory/note.md',
          source: 'project',
        },
      ],
      updated: [],
      removed: [],
    };
    const memory: MemorySection[] = [
      {
        id: '-w-alpha',
        projectPath: '/w/alpha',
        projectName: 'alpha',
        note: '/h/.claude/projects/-w-alpha/memory',
        isCurrent: true,
        usageAvailable: false,
        indexTokens: 0,
        items: [
          base({
            name: 'note',
            kind: 'memory',
            path: '/h/.claude/projects/-w-alpha/memory/note.md',
          }),
        ],
      },
    ];
    const rows = changeRows(dataOf({ changes: memChanges, memory }), projA);
    expect(rows).toHaveLength(1);
    expect(rows[0].section).toBe(projA);
    expect(rows[0].item?.kind).toBe('memory');
    // 別プロジェクトを選ぶと出ない
    expect(changeRows(dataOf({ changes: memChanges, memory }), projB)).toHaveLength(0);
  });
});

describe('contextRows (② セッションの文脈の分岐。README 6.3)', () => {
  it('3 内訳。CLAUDE.md 群には上限(バー)が無く、description は 1% 予算との比で超過を判定', () => {
    const rows = contextRows(dataOf());
    expect(rows.map((r) => r.key)).toEqual(['claudeMd', 'memory', 'descriptions']);
    expect(rows[0].ratio).toBeNull();
    expect(rows[1].ratio).toBeCloseTo(2 / 200);
    expect(rows[1].over).toBe(false);
    expect(rows[2].ratio).toBeCloseTo(3370 / 2000);
    expect(rows[2].over).toBe(true);
    expect(contextTotal(rows)).toBe(1180 + 310 + 3370);
  });
  it('memory が無ければ MEMORY.md の行を出さない', () => {
    const d = dataOf();
    d.context.memoryIndex = { tok: 0, lines: 0, limitLines: 200, limitBytes: 25 * 1024 };
    const rows = contextRows(d);
    expect(rows.map((r) => r.key)).toEqual(['claudeMd', 'descriptions']);
    expect(contextTotal(rows)).toBe(1180 + 3370);
  });
  it('claudeMdCounts は段ごとの件数(project は project / project-dot / local の和)', () => {
    const f = (p: string) => ({
      path: p,
      ownTokens: 1,
      tokens: 1,
      updatedAt: '',
      headings: [],
      imports: [],
    });
    const n = claudeMdCounts({
      tokens: 0,
      layers: [
        { kind: 'managed', label: '', files: [], tokens: 0 },
        { kind: 'user', label: '', files: [f('/h/.claude/CLAUDE.md')], tokens: 0 },
        { kind: 'project', label: '', files: [], tokens: 0 },
        { kind: 'project-dot', label: '', files: [f('/w/a/.claude/CLAUDE.md')], tokens: 0 },
        { kind: 'local', label: '', files: [f('/w/a/CLAUDE.local.md')], tokens: 0 },
        { kind: 'rules', label: '', files: [], tokens: 0 },
      ],
    });
    expect(n).toEqual({ user: 1, project: 2, rules: 0 });
  });
});

describe('sessionSections / duplicateNames (③ 効いているもの・同名)', () => {
  it('選んだプロジェクト → user → plugin → built-in。他プロジェクトは含めない', () => {
    expect(sessionSections(sections, projA).map((s) => s.id)).toEqual([
      'proj--w-alpha',
      'user',
      'plugin',
      'builtin',
    ]);
    expect(sessionSections(sections, null).map((s) => s.id)).toEqual(['user', 'plugin', 'builtin']);
  });
  it('同名の別定義を short name でまとめ、置き場所を並べる', () => {
    const all: FlatItem[] = [
      {
        ...projA.items[0],
        key: 'a',
        secId: projA.id,
        source: 'project',
        scopeLabel: 'alpha',
        hasMd: true,
      },
      {
        ...userSec.items[0],
        key: 'u',
        secId: 'user',
        source: 'user',
        scopeLabel: 'user',
        hasMd: true,
      },
      {
        ...projB.items[0],
        key: 'b',
        secId: projB.id,
        source: 'project',
        scopeLabel: 'beta',
        hasMd: true,
      },
      {
        ...base({ name: 'x:foo', kind: 'hook' }),
        key: 'h',
        secId: 'user',
        source: 'user',
        scopeLabel: 'user',
        hasMd: false,
      },
    ];
    expect(duplicateNames(all)).toEqual([{ name: 'foo', scopes: ['alpha', 'user'] }]);
  });
});

/*
 * クエリの検証。未知の値をそのまま filter に渡すと一覧が空になり、select も空欄で
 * 「何も無い」と「絞り込みすぎ」の区別が付かなくなる(v0.8 の挙動)。
 * KIND_FILTERS / USE_FILTERS は select の選択肢そのものなので、型の全値を網羅していることも見る。
 */
describe('asKindFilter / asUseFilter (URL クエリの検証)', () => {
  it('既知の値はそのまま、未知と null は all に落とす', () => {
    expect(asKindFilter('hook')).toBe('hook');
    expect(asKindFilter('bogus')).toBe('all');
    expect(asKindFilter(null)).toBe('all');
    expect(asUseFilter('unused')).toBe('unused');
    expect(asUseFilter('bogus')).toBe('all');
    expect(asUseFilter(null)).toBe('all');
  });

  it('選択肢が型の全値を網羅している(select に欠けがない)', () => {
    const kinds: KindFilter[] = ['all', 'skill', 'command', 'agent', 'hook'];
    const uses: UseFilter[] = ['all', 'used', 'unused'];
    expect([...KIND_FILTERS].sort()).toEqual([...kinds].sort());
    expect([...USE_FILTERS].sort()).toEqual([...uses].sort());
  });
});

/*
 * labelOfUseFilter は今まで i18n の未使用キー番犬(i18n.test.ts)に引っかかることでしか
 * 守られておらず、対応そのもの(all/used/unused → どのキーか)は未検証だった。
 * USE_FILTERS の順序(select の並び)は上の網羅テストが sort してしまうので別に固定する。
 */
describe('labelOfUseFilter (使用実績フィルタのラベル)', () => {
  it('3 値それぞれが異なる非空文字列を返す', () => {
    const labels = USE_FILTERS.map(labelOfUseFilter);
    expect(labels.every((l) => l.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(3);
  });

  it('en / ja のどちらでも kind. / filter. のキー名がそのまま出ない(訳抜け検出)', () => {
    for (const lang of ['en', 'ja'] as const) {
      setLang(lang);
      for (const v of USE_FILTERS) {
        const label = labelOfUseFilter(v);
        expect(label.startsWith('kind.')).toBe(false);
        expect(label.startsWith('filter.')).toBe(false);
      }
    }
  });

  it('USE_FILTERS は all → used → unused の順(select の並び)', () => {
    expect(USE_FILTERS).toEqual(['all', 'used', 'unused']);
  });
});
