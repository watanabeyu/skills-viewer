import type {
  FeedbackBodyPlan,
  MemorySection,
  MemoryVerdict,
  Section,
  SkillGroup,
  SkillItem,
  Source,
} from './api';
import { itemKey } from './api';
import { t } from './i18n';

export const SRC_COLOR: Record<Source, string> = {
  'built-in': '#2a6fdb',
  user: '#1f8a5b',
  project: '#c07a1f',
  plugin: '#7b5bd6',
};
export const SRC_TINT: Record<Source, string> = {
  'built-in': 'rgba(42,111,219,.10)',
  user: 'rgba(31,138,91,.10)',
  project: 'rgba(192,122,31,.13)',
  plugin: 'rgba(123,91,214,.10)',
};

export type SortKey = 'name' | 'uses' | 'recent' | 'updated' | 'tokens';

/* 一覧の表示軸: ソース別(置き場所)/ 用途別(AI グルーピング)/ メモリ(自動メモリのみ)/ フラット */
export type ViewMode = 'source' | 'group' | 'memory' | 'flat';

/* memory セクションのアクセント色(skill の SRC_COLOR に相当。AI マークと同系色) */
export const MEM_COLOR = '#b0836a';

export interface FlatItem extends SkillItem {
  key: string;
  secId: string;
  source: Source;
  scopeLabel: string;
  manage: boolean;
  hasMd: boolean;
}

/* セクション見出し(サーバーは構造化データのみ返し、表示文字列はここで組み立てる) */
export function headingOf(s: Section): string {
  return s.source === 'project'
    ? 'project — ' + (s.projectName || '') + (s.isCurrent ? ' (current)' : '')
    : s.source;
}

/* 短い所属ラベル(project は プロジェクト名のみ) */
export function scopeLabelOf(s: Section): string {
  return s.source === 'project' ? s.projectName || '' : s.source;
}

export function flatten(sections: Section[]): FlatItem[] {
  return sections.flatMap((s) =>
    s.items.map((it) => ({
      ...it,
      key: itemKey(it),
      secId: s.id,
      source: s.source,
      scopeLabel: scopeLabelOf(s),
      manage: !!s.manage && it.kind !== 'hook', // hook は設定エントリなのでコピー/削除不可
      hasMd: it.path.endsWith('.md'),
    })),
  );
}

/* 呼び出し例。agent は @メンション、hook / memory は起動形が無いので空 */
export const usageLine = (it: SkillItem) => {
  if (it.kind === 'hook' || it.kind === 'memory') return '';
  if (it.kind === 'agent') return '@' + it.name;
  return '/' + it.name + (it.argumentHint ? ' ' + it.argumentHint : '');
};

export const KIND_LABEL: Partial<Record<SkillItem['kind'], string>> = {
  command: 'command',
  agent: 'agent',
  hook: 'hook',
  memory: 'memory',
};

export type KindFilter = 'all' | SkillItem['kind'];

export const kindMatches = (it: SkillItem, kind: KindFilter) => kind === 'all' || it.kind === kind;

/*
 * 未使用判定。トランスクリプトが1件も無い環境では全件未使用になり無意味なので
 * usageAvailable が前提。hook は起動記録の対象外なので常に false。
 */
export const isUnused = (it: SkillItem, usageAvailable: boolean) =>
  usageAvailable && it.kind !== 'hook' && !it.useCount;

/* 使用実績フィルタ。used / unused とも起動記録の対象外である hook は含めない */
export type UseFilter = 'all' | 'used' | 'unused';

export const usageMatches = (it: SkillItem, f: UseFilter, usageAvailable: boolean) => {
  if (f === 'used') return it.kind !== 'hook' && !!it.useCount;
  if (f === 'unused') return isUnused(it, usageAvailable);
  return true;
};

/* 用途別表示の1グループ(手動 category 由来 or AI 生成 or その他) */
export interface PurposeGroup {
  id: string;
  label: string;
  emoji?: string;
  manual?: boolean;
  items: FlatItem[];
}

/*
 * 用途グループ別に集約する。表示順は 手動 category(名前順)→ AI グループ(サーバー順)→ その他。
 * 割当が無い/未知グループを指す/hook のアイテムは「その他」に落とす(隠さない)。
 * items の並び順は保持する(呼び出し側で sortItems 済みの前提)。
 */
export function groupByPurpose(
  items: FlatItem[],
  groups: SkillGroup[] | undefined,
): PurposeGroup[] {
  const manual = new Map<string, FlatItem[]>();
  const ai = new Map<string, FlatItem[]>();
  const other: FlatItem[] = [];
  const known = new Set((groups || []).map((g) => g.id));
  for (const it of items) {
    if (it.category) {
      if (!manual.has(it.category)) manual.set(it.category, []);
      manual.get(it.category)!.push(it);
    } else if (it.aiGroup && known.has(it.aiGroup)) {
      if (!ai.has(it.aiGroup)) ai.set(it.aiGroup, []);
      ai.get(it.aiGroup)!.push(it);
    } else {
      other.push(it);
    }
  }
  const out: PurposeGroup[] = [...manual.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((cat) => ({ id: 'cat:' + cat, label: cat, manual: true, items: manual.get(cat)! }));
  for (const g of groups || []) {
    if (ai.has(g.id)) out.push({ ...g, items: ai.get(g.id)! });
  }
  if (other.length) out.push({ id: '__other', label: t('group.other'), items: other });
  return out;
}

/* 同名の別定義(diff 比較の対象)。short name で突き合わせ、hook は対象外 */
export function sameNameOthers<T extends SkillItem & { key: string }>(it: T, all: T[]): T[] {
  const short = it.name.split(':').pop();
  return all.filter(
    (x) =>
      x.key !== it.key &&
      x.kind !== 'hook' &&
      it.kind !== 'hook' &&
      x.name.split(':').pop() === short,
  );
}

export const fmtDate = (ms?: number) => {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/*
 * 経過日ラベル(memory の「どれだけ更新されていないか」用)。日付そのものより鮮度が重要なので相対表記。
 */
export function relDaysLabel(ms?: number): string {
  if (!ms) return '';
  const days = Math.floor((Date.now() - ms) / 86400000);
  return days <= 0 ? t('memory.today') : t('memory.stale', { n: days });
}

/* M/D 表記(カードの「最終 8/14」用。年は鮮度判断に不要なので省く) */
export const fmtMD = (ms?: number) => {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

/* memory 軸の並び順。既定は索引トークン(常時コスト)が多い順 = 減らす価値が高い順 */
export type MemorySortKey = 'index' | 'body' | 'updated' | 'name';

export function sortMemory<T extends SkillItem>(items: T[], sort: MemorySortKey): T[] {
  const arr = [...items];
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  // 読み込み上限(200 行 / 25KB)の外にある索引行は実際には注入されないので 0 として並べる
  // (「減らす価値が高い順」の意図と、セクション合計 indexTokens の数え方に揃える)
  const indexCost = (it: T) => (it.indexBeyondLimit ? 0 : it.indexTokens || 0);
  if (sort === 'index') arr.sort((a, b) => indexCost(b) - indexCost(a) || byName(a, b));
  else if (sort === 'body')
    arr.sort((a, b) => (b.bodyTokens || 0) - (a.bodyTokens || 0) || byName(a, b));
  // 更新が古い順(棚卸し候補が先頭に来る)。更新日不明は末尾。
  // サーバーは stat 失敗時に updatedAt: 0 を載せるので、?? ではなく falsy で不明扱いにする
  else if (sort === 'updated')
    arr.sort((a, b) => (a.updatedAt || Infinity) - (b.updatedAt || Infinity) || byName(a, b));
  else arr.sort(byName);
  return arr;
}

/*
 * 参照フィルタ(本文が Read されたか)。トランスクリプトが無いプロジェクトは「未参照」ではなく
 * 判定不能なので、read / unread のどちらにも含めない(all だけが通す)。
 */
export type RefFilter = 'all' | 'read' | 'unread';

export const refMatches = (it: SkillItem, f: RefFilter, usageAvailable: boolean) => {
  if (f === 'read') return usageAvailable && !!it.useCount;
  if (f === 'unread') return usageAvailable && !it.useCount;
  return true;
};

/* 被リンク: 同プロジェクトの他 memory の [[x]] がこの memory を name かファイル名で指しているもの */
export function backlinksOf<T extends SkillItem>(it: T, items: T[]): T[] {
  const base = fileBase(it.path);
  return items.filter(
    (o) => o.path !== it.path && (o.links || []).some((n) => n === it.name || n === base),
  );
}

/* リンク切れ数: 発リンクのうち同プロジェクト内で解決できないもの(解決規則は memoryResolver と同一) */
export function brokenLinkCount(it: SkillItem, items: SkillItem[]): number {
  const resolve = memoryResolver(items);
  return (it.links || []).filter((n) => !resolve(n)).length;
}

/* memory の実パスからファイル名を取る(API の files 指定・[[link]] 解決で使う) */
export const fileName = (p: string) => p.split(/[\\/]/).pop() || '';
/* 拡張子なしのファイル名。[[x]] は frontmatter name とファイル名の両方で書かれ得る */
export const fileBase = (p: string) => fileName(p).replace(/\.md$/, '');

/*
 * [[x]] の解決器。本文レンダリング・リンク切れ数えの両方が同じ規則で解決するよう 1 箇所に置く
 * (name 一致とファイル名一致のどちらでも解決する)。
 */
export const memoryResolver =
  (items: SkillItem[]) =>
  (name: string): SkillItem | undefined =>
    items.find((m) => m.name === name || fileBase(m.path) === name);

/*
 * 棚卸し診断の削減試算(機械層で算出。AI には数値を出させない)。
 * index = 常時コスト(MEMORY.md の索引行)の増減、always = 毎セッション注入に変わる分。
 * keep(変更なし)・shrink(本文を縮める)・update(本文を書き直す)は索引 ±0 なので数値を出さず null。
 */
export function triageEstimate(it: SkillItem): { index: number; always: number } | null {
  const v = it.aiTriage?.verdict;
  // 読み込み上限(200 行 / 25KB)の外にある索引行は元から注入されていないので、消しても常時コストは
  // 減らない。セクション合計(MemorySection.indexTokens)と同じ規則にしないと、
  // 「適用後 = 合計 + 差分」が上限外の件のぶんだけ負に振れる
  const index = it.indexBeyondLimit ? 0 : it.indexTokens || 0;
  // 索引行が消える分。0 のときは -0 を作らない(表示・合算では同値だが値の比較で 0 と食い違う)
  const drop = index === 0 ? 0 : -index;
  // to-skill は SKILL.md 側(元から常時注入されている description ではなく本文)へ移すので、
  // memory 側は索引が消えるだけ = to-docs と同じ試算になる
  if (v === 'delete' || v === 'to-docs' || v === 'wrong-project' || v === 'to-skill')
    return { index: drop, always: 0 };
  // CLAUDE.md 行きは索引 1 行が消える代わりに本文全体が毎セッション注入になる(多くの場合は増加)。
  // user scope の CLAUDE.md 行きも 1 プロジェクト分の会計としては同じ式(増える先が全プロジェクトに
  // 変わるだけで、この画面が見ているプロジェクトの毎セッション増分は本文 tok)
  if (v === 'to-claude-md' || v === 'to-user-claude-md')
    return { index: drop, always: it.bodyTokens || 0 };
  return null;
}

/*
 * feedback 本文の分類(body)から指示文を決定的に組む。AI の散文ではなくテンプレートなので、
 * モデルが haiku でも opus でも体裁と網羅性が同じになる。ルール行は description(索引の文言)で示す。
 */
export function buildFeedbackInstruction(it: SkillItem, plan: FeedbackBodyPlan): string {
  const file = fileName(it.path);
  const lines = [
    t('memory.triage.tpl.replace', { file }),
    t('memory.triage.tpl.rule', { rule: it.description }),
  ];
  if (plan.why === 'keep') lines.push(t('memory.triage.tpl.whyKeep'));
  else if (plan.why === 'generalize')
    lines.push(t('memory.triage.tpl.whyGeneralize', { text: plan.whyRewrite || '' }));
  else lines.push(t('memory.triage.tpl.whyDrop'));
  if (plan.how === 'keep') lines.push(t('memory.triage.tpl.howKeep'));
  else if (plan.how === 'keep-lines-only')
    lines.push(
      t('memory.triage.tpl.howLines', {
        list: plan.keepLines.map((x) => '「' + x + '」').join(' / '),
      }),
    );
  else lines.push(t('memory.triage.tpl.howDrop'));
  // 索引行は毎セッション注入される側。description が本文と食い違うときだけ書き換えを指示する
  if (plan.index === 'rewrite')
    lines.push(t('memory.triage.tpl.indexRewrite', { text: plan.indexRewrite || '' }));
  else if (plan.index === 'align') lines.push(t('memory.triage.tpl.indexAlign'));
  else lines.push(t('memory.triage.tpl.index'));
  return lines.join('\n');
}

/*
 * wrong-project の指示文もテンプレートで組む。移動先(target / targetMemDir)は機械シグナルを
 * 根拠に server が確定させた事実で、モデルには候補からの選択しかさせていない。ここでは
 * 言語文面だけを足す(捏造された移動先が指示文に混ざらないように、散文は使わない)。
 */
export function buildWrongProjectInstruction(
  it: SkillItem,
  target: string,
  targetMemDir: string,
): string {
  return [
    t('memory.triage.tpl.wpMove', { file: fileName(it.path), target, dir: targetMemDir }),
    t('memory.triage.tpl.wpCheck'),
    t('memory.triage.tpl.wpIndex'),
    // 索引行の無い memory は毎セッション注入されない = 「移したのに使われない」で終わるので、
    // 削除だけでなく移動先への索引行の追加まで必ず指示する
    t('memory.triage.tpl.wpIndexAdd'),
    t('memory.triage.tpl.wpLink'),
  ].join('\n');
}

/* 表示・コピーに使う指示文。分類(body)があればテンプレート、無ければ AI の散文 */
export function effectiveInstruction(it: SkillItem): string {
  const tri = it.aiTriage;
  if (!tri || tri.error || tri.verdict === 'keep') return '';
  if (tri.body && (tri.verdict === 'shrink' || tri.verdict === 'update'))
    return buildFeedbackInstruction(it, tri.body);
  if (tri.verdict === 'wrong-project' && tri.target && tri.targetMemDir)
    return buildWrongProjectInstruction(it, tri.target, tri.targetMemDir);
  return tri.instruction;
}

/* 試算の符号付き表記(0 は増減なしを明示するため ±0) */
export const signed = (n: number) =>
  (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(n).toLocaleString();

/*
 * 削減試算のラベル。機械層で計算する(AI に数値を出させない)。
 * shrink / update は索引が変わらないので数値でなく文言だけ、keep は空。
 * コンポーネントでなくここに置くのは、verdict × 上限外の分岐(特に to-user-claude-md の
 * 「全プロジェクト」注記)をテストで固定するため(コンポーネントテスト基盤は無い)。
 */
export function estimateLabel(it: SkillItem): string {
  if (it.aiTriage?.verdict === 'shrink') return t('memory.triage.estShrink');
  if (it.aiTriage?.verdict === 'update') return t('memory.triage.estUpdate');
  const est = triageEstimate(it);
  if (!est) return '';
  // 読み込み上限の外にある索引行は元から注入されていないので、消しても常時コストは減らない。
  // 「索引 ±0」だけだと変更なしに見えるため、減らない理由まで書く(delete / to-docs / … 系)
  if (it.indexBeyondLimit && est.always === 0) return t('memory.triage.estApplyBeyond');
  // user scope の CLAUDE.md 行きは増える先が全プロジェクトなので、同じ式でも文言を分ける
  if (it.aiTriage?.verdict === 'to-user-claude-md' && est.always > 0)
    return t('memory.triage.estApplyUserClaude', {
      n: signed(est.index),
      m: est.always.toLocaleString(),
    });
  if (est.always > 0)
    return t('memory.triage.estApplyClaude', {
      n: signed(est.index),
      m: est.always.toLocaleString(),
    });
  return t('memory.triage.estApply', { n: signed(est.index) });
}

/* 提案(指示文)のある memory だけ。サマリ・まとめコピーが同じ母集団を見るよう 1 箇所に置く */
export const instructionsOf = (items: SkillItem[]) =>
  items.filter((it) => effectiveInstruction(it));

/*
 * コピーする指示文には「まず確認してから実行」の前置きを付ける。貼り先の Claude Code に
 * dry run(読み取り → 作業内容の提示 → 承認)を求めるためで、毎回手で書き足さなくて済むようにする。
 */
export const withPreamble = (body: string) => t('memory.triage.copyPreamble') + '\n\n' + body;

/*
 * コピー本文の事実ヘッダ。どの memory ディレクトリ・どのプロジェクトの・どのファイルの話かは
 * スキャン結果から機械生成する(AI に書かせない)。貼り先が対象を取り違えないための土台なので、
 * まとめコピーにも単件コピーにも同じ形で付ける。
 */
export const factHeader = (sec: MemorySection, files: string[]) =>
  t('memory.triage.hdr.dir', {
    dir: sec.note,
    project: sec.projectPath ?? t('memory.triage.hdr.unknownProject'),
  }) +
  '\n' +
  t('memory.triage.hdr.files', { files: files.join(', ') });

/* 提案のある行だけを `## name` 見出し付きで連結(まとめてコピー用)。前置き + 事実ヘッダは先頭に 1 回だけ */
export const joinInstructions = (sec: MemorySection) => {
  const items = instructionsOf(sec.items);
  return withPreamble(
    factHeader(
      sec,
      items.map((it) => fileName(it.path)),
    ) +
      '\n\n' +
      items.map((it) => '## ' + it.name + '\n\n' + effectiveInstruction(it)).join('\n\n'),
  );
};

/* 単件コピーの本文(前置き + 事実ヘッダ + その 1 件の指示文) */
export const copyInstruction = (sec: MemorySection, it: SkillItem) =>
  withPreamble(factHeader(sec, [fileName(it.path)]) + '\n\n' + effectiveInstruction(it));

/*
 * 提案が 1 種類に偏っているか(非 keep が 5 件以上で、その 8 割以上が同じ行き先)。
 * v0.8.0 で全件に誤った wrong-project が出た事故のような「プロジェクトの特定ミス」は
 * 偏りとして現れるため、verdict は上書きせず警告だけを出す材料にする。
 * 出力不正(error)は行き先を持たないので母数から外す。
 * 格下げ済み(demoted)は verdict 上は keep だが、モデルの答えとしては偏りの証拠そのものなので
 * 元の verdict として数える(発端の「全件シグナル無し wrong-project」でもバナーが出るように)。
 */
export function skewedVerdict(items: SkillItem[]): MemoryVerdict | null {
  const verdicts = items
    .map((it) => it.aiTriage)
    .filter((tri) => tri && !tri.error)
    .map((tri) => tri!.demoted ?? tri!.verdict)
    .filter((v) => v !== 'keep');
  if (verdicts.length < 5) return null;
  const counts = new Map<MemoryVerdict, number>();
  for (const v of verdicts) counts.set(v, (counts.get(v) || 0) + 1);
  const [top] = [...counts].sort((a, b) => b[1] - a[1]);
  return top[1] / verdicts.length >= 0.8 ? top[0] : null;
}

/* memory 一覧(view=memory)へ戻る URL。詳細のタブ状態は持ち越さない(次のカードが本文タブで開くのを防ぐ) */
export function memoryListSearch(params: URLSearchParams): string {
  const next = new URLSearchParams(params);
  next.set('view', 'memory');
  next.delete('tab');
  return next.toString();
}

/* クリップボードコピー(指示文の貼り付け用。失敗はボタン側で握り潰さず呼び出し元へ) */
export const copyText = (text: string): Promise<void> => navigator.clipboard.writeText(text);

export const matches = (it: SkillItem, q: string) =>
  !q ||
  (it.name + ' ' + it.description + ' ' + usageLine(it) + ' ' + (it.aiSummary || ''))
    .toLowerCase()
    .includes(q);

/*
 * 起動経路の判定。実測(トランスクリプト)を最優先し、実測が無いものは AI 分類にフォールバック。
 * human = 人間が意図して /x と打つ起点、agent = 他 skill・エージェントから呼ばれる部品。
 */
export type Invocation = 'human' | 'agent' | 'both';

export function invocationOf(it: SkillItem): { kind: Invocation; basis: 'measured' | 'ai' } | null {
  const typed = it.typedCount || 0;
  const auto = it.autoCount || 0;
  if (typed > 0 && auto > 0) return { kind: 'both', basis: 'measured' };
  if (typed > 0) return { kind: 'human', basis: 'measured' };
  if (auto > 0) return { kind: 'agent', basis: 'measured' };
  if (it.aiInvocation) return { kind: it.aiInvocation, basis: 'ai' };
  return null;
}

/* 言語切替に追従するよう、定数マップでなく都度 t() を引く */
export const invocationLabel = (kind: Invocation): string => t(`invocation.${kind}`);

export function invocationTitle(it: SkillItem): string {
  const parts: string[] = [];
  if ((it.typedCount || 0) + (it.autoCount || 0) > 0) {
    parts.push(t('invocation.measured', { typed: it.typedCount || 0, auto: it.autoCount || 0 }));
  }
  if (it.aiInvocation) {
    parts.push(
      t('invocation.ai', { label: invocationLabel(it.aiInvocation) }) +
        (it.aiInvocationReason ? `(${it.aiInvocationReason})` : ''),
    );
  }
  return parts.join(' · ');
}

export function sortItems<T extends SkillItem>(items: T[], sort: SortKey): T[] {
  const arr = [...items];
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  if (sort === 'uses') arr.sort((a, b) => (b.useCount || 0) - (a.useCount || 0) || byName(a, b));
  else if (sort === 'recent')
    arr.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0) || byName(a, b));
  else if (sort === 'updated')
    arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || byName(a, b));
  else if (sort === 'tokens') arr.sort((a, b) => (b.tokens || 0) - (a.tokens || 0) || byName(a, b));
  else arr.sort(byName);
  return arr;
}
