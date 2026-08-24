import { afterEach, describe, expect, it } from 'vitest';
import type { MemorySection, MemoryVerdict, SkillItem } from '../src/shared/types';
import { itemKey } from '../web/src/api';
import {
  backlinksOf,
  brokenLinkCount,
  copyInstruction,
  factHeader,
  invocationOf,
  joinInstructions,
  kindMatches,
  memoryListSearch,
  refMatches,
  sameNameOthers,
  skewedVerdict,
  sortItems,
  sortMemory,
  usageLine,
  usageMatches,
  withPreamble,
  buildFeedbackInstruction,
  effectiveInstruction,
} from '../web/src/util';
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

describe('joinInstructions / withPreamble (まとめコピーの本文)', () => {
  const tri = (instruction: string): SkillItem['aiTriage'] => ({
    verdict: 'delete',
    reason: '',
    issues: [],
    instruction,
  });
  /* 移動先が確定した wrong-project は instruction が空でテンプレートが唯一の出典 */
  const wrongProject: SkillItem['aiTriage'] = {
    verdict: 'wrong-project',
    reason: '',
    issues: [],
    instruction: '',
    target: '/w/other',
    targetMemDir: '/h/.claude/projects/-w-other/memory',
  };
  const items = [
    mem('alpha', { aiTriage: tri('- alpha を消す') }),
    mem('beta', { aiTriage: tri('') }), // 提案なし(keep 相当)
    mem('gamma', { aiTriage: tri('- gamma を docs/ へ') }),
    mem('delta'), // 未診断
    mem('epsilon', { aiTriage: wrongProject }),
  ];
  const sec = memSection(items);
  const preamble = t('memory.triage.copyPreamble');

  it('前置きは本文の先頭に 1 回だけ付く', () => {
    const text = joinInstructions(sec);
    expect(text.startsWith(preamble + '\n\n')).toBe(true);
    expect(text.split(preamble)).toHaveLength(2); // 出現は 1 回
    expect(withPreamble('body')).toBe(preamble + '\n\nbody');
  });

  it('各件は「## name」見出しで区切る', () => {
    const text = joinInstructions(sec);
    expect(text).toContain('## alpha\n\n- alpha を消す');
    expect(text).toContain('## gamma\n\n- gamma を docs/ へ');
  });

  it('指示文が空の件・未診断の件は含めない', () => {
    const text = joinInstructions(sec);
    expect(text).not.toContain('## beta');
    expect(text).not.toContain('## delta');
  });

  /* instruction が空でも移動先が確定していればテンプレートで指示文が組まれるので、母集団に入る */
  it('instruction が空の wrong-project も見出し・対象ファイル一覧・テンプレート行が載る', () => {
    const text = joinInstructions(sec);
    expect(text).toContain('## epsilon\n\n- This memory is about /w/other');
    expect(text).toContain('/h/.claude/projects/-w-other/memory');
    expect(text).toContain(factHeader(sec, ['alpha.md', 'gamma.md', 'epsilon.md']));
  });
});

/* 判断 4(計画 13 Phase B): コピー本文の事実ヘッダはモデル出力ではなくスキャン結果から機械生成する */
describe('factHeader / copyInstruction (コピー本文の事実ヘッダ)', () => {
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

  it('まとめコピーは前置きの直後にヘッダ(対象ファイルは提案のある件だけ)', () => {
    const text = joinInstructions(sec);
    expect(text).toBe(
      t('memory.triage.copyPreamble') +
        '\n\n' +
        factHeader(sec, ['alpha.md']) +
        '\n\n## alpha\n\n- alpha を消す',
    );
  });

  it('単件コピーも同じヘッダを持つ(対象ファイルはその 1 件)', () => {
    const text = copyInstruction(sec, item);
    expect(text).toBe(
      t('memory.triage.copyPreamble') +
        '\n\n' +
        factHeader(sec, ['alpha.md']) +
        '\n\n- alpha を消す',
    );
  });
});

/* 判断 7(計画 13 Phase B): 偏りは verdict を上書きせず警告の材料にするだけ */
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
  it('view=memory を立て、詳細のタブ状態は捨てる(他の条件は保つ)', () => {
    const params = new URLSearchParams('q=foo&msort=body&tab=body&view=source');
    const next = new URLSearchParams(memoryListSearch(params));
    expect(next.get('view')).toBe('memory');
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
    ).toBe('- モデルの散文(捏造した移動先を含みうる)');
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
    ).toBe('- 散文');
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
