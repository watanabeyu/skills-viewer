import type { MemorySection, SkillItem, SkillsData } from '../api';
import {
  brokenLinkCount,
  matches,
  refMatches,
  relDaysLabel,
  sortMemory,
  MEM_COLOR,
  type MemorySortKey,
  type RefFilter,
} from '../util';
import { t } from '../i18n';
import { KindBadge } from './GridView';
import { MemoryHeading, MemoryTypeBadge, TokFacts, UnreadBadge, readsLine } from './MemoryBits';

/* 比較バーの最大幅(モック実測)。最大値のバーをこの幅にして他を比例させる */
const CMP_MAX_PX = 122;
const CMP_OTHER_COLOR = '#c9c2b4';

function CmpRow({
  label,
  value,
  max,
  color,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
}) {
  const width = max > 0 ? Math.round((value / max) * CMP_MAX_PX) : 0;
  return (
    <div className="row">
      <span className="lab">{label}</span>
      <span className="bar" style={{ width, background: color }} />
      <span className="num">{value.toLocaleString()}</span>
    </div>
  );
}

/*
 * コストバー。常時コスト(索引 × 件数)と従量コスト(本文)を分けて見せ、
 * 「減らせる変数は件数だけ」を注記で明示する。比較バーで他の常時注入元と並べる。
 */
function CostBar({
  sec,
  pluginTok,
  userTok,
  onOpenTriage,
}: {
  sec: MemorySection;
  pluginTok: number;
  userTok: number;
  onOpenTriage: (id: string) => void;
}) {
  const n = sec.items.length;
  const bodyTok = sec.items.reduce((sum, it) => sum + (it.bodyTokens || 0), 0);
  const readCount = sec.items.filter((it) => !!it.useCount).length;
  // 分母は上限内の件数。合計(sec.indexTokens)が上限外を除いた値なので、
  // 全件で割ると「1 件あたり」が実際より小さく出る(0 除算にも注意)
  const inLimit = n - (sec.indexBeyondCount || 0);
  const per = inLimit > 0 ? Math.round(sec.indexTokens / inLimit) : 0;
  const max = Math.max(sec.indexTokens, pluginTok, userTok);
  const unit = t('memory.cost.unit');
  const beyond = sec.indexBeyondCount || 0;
  return (
    <div className="costbar">
      <div className="cell">
        <span className="k">{t('memory.cost.indexK')}</span>
        <span className="v">
          {sec.indexTokens.toLocaleString()}
          <span className="u"> {unit}</span>
        </span>
        <span className="note">
          {t('memory.cost.indexNote', { n })}
          {beyond > 0 && '\n' + t('memory.cost.indexBeyond', { n: beyond })}
        </span>
      </div>
      <div className="cell">
        <span className="k">{t('memory.cost.bodyK')}</span>
        <span className="v dim">
          {bodyTok.toLocaleString()}
          <span className="u"> {unit}</span>
        </span>
        <span className="note">
          {sec.usageAvailable
            ? t('memory.cost.bodyNote', { k: readCount, n })
            : t('memory.cost.bodyNoteNA')}
        </span>
      </div>
      <div className="cell">
        <span className="k">{t('memory.cost.perK')}</span>
        <span className="v">
          ≈{per.toLocaleString()}
          <span className="u"> {unit}</span>
        </span>
        <span className="note">{t('memory.cost.perNote')}</span>
      </div>
      <div className="spacer" />
      <div className="act">
        {/* 棚卸しはプロジェクト単位(重複・別プロジェクト混入は全件を同時に見ないと判定できない) */}
        <button
          className="chip"
          title={t('memory.triage.sectionTitle')}
          onClick={() => onOpenTriage(sec.id)}
        >
          {t('memory.triage.section')}
        </button>
      </div>
      <div className="cmp" title={t('memory.cmpTitle')}>
        <CmpRow
          label={t('memory.cmp.memory')}
          value={sec.indexTokens}
          max={max}
          color={MEM_COLOR}
        />
        <CmpRow
          label={t('memory.cmp.plugin')}
          value={pluginTok}
          max={max}
          color={CMP_OTHER_COLOR}
        />
        <CmpRow label={t('memory.cmp.user')} value={userTok} max={max} color={CMP_OTHER_COLOR} />
      </div>
    </div>
  );
}

/* skill カードと同じ骨格。参照行は起動形の代わりに Read 実績を出す */
function MemoryCard({
  it,
  sec,
  onOpen,
}: {
  it: SkillItem;
  sec: MemorySection;
  onOpen: (path: string) => void;
}) {
  const broken = brokenLinkCount(it, sec.items);
  return (
    <button className="card mem-card" onClick={() => onOpen(it.path)}>
      <span className="scope-mini">
        <span className="dot5" style={{ background: MEM_COLOR }} />
        {sec.projectName}
      </span>
      <div className="top">
        <span className="nm">{it.name}</span>
        <span className="top-r">
          {broken > 0 && (
            <span className="warn-badge" title={t('memory.brokenBadgeTitle', { n: broken })}>
              ⚠ {broken}
            </span>
          )}
        </span>
      </div>
      <div className="chips">
        <KindBadge it={it} />
        <MemoryTypeBadge it={it} />
        <UnreadBadge show={sec.usageAvailable && !it.useCount} />
      </div>
      <p className="desc">{it.description}</p>
      <div className="usage">{readsLine(it, sec.usageAvailable)}</div>
      <div className="meta">
        <span>{relDaysLabel(it.updatedAt)}</span>
        <span className="meta-r">
          <TokFacts it={it} cls="tok" bold />
        </span>
      </div>
    </button>
  );
}

/* memory 軸の一覧本体(view=memory)。プロジェクトごとに 見出し → コストバー → 3 列カード */
export function MemoryGrid({
  data,
  q,
  sort,
  // ref は React の予約 prop 名(memo / forwardRef で剥がされる)なので prop 名は refFilter
  refFilter,
  onOpen,
  onOpenTriage,
}: {
  data: SkillsData;
  q: string;
  sort: MemorySortKey;
  refFilter: RefFilter;
  onOpen: (path: string) => void;
  onOpenTriage: (id: string) => void;
}) {
  // 比較バー用: この環境で毎セッション注入される plugin / user skill の name + description 合計
  const tokOf = (source: string) =>
    data.sections
      .filter((s) => s.source === source)
      .flatMap((s) => s.items)
      .reduce((sum, it) => sum + (it.tokens || 0), 0);
  const pluginTok = tokOf('plugin');
  const userTok = tokOf('user');

  // セクション順はサーバー側で確定済み(current 先頭 → 名前順 → プロジェクト不明末尾)
  const sections = (data.memory || [])
    .map((sec) => ({
      sec,
      items: sortMemory(
        sec.items.filter((it) => matches(it, q) && refMatches(it, refFilter, sec.usageAvailable)),
        sort,
      ),
    }))
    .filter((s) => s.items.length > 0);

  if (!sections.length)
    return (
      <div className="grid-pad">
        <div className="empty">{t('list.empty')}</div>
      </div>
    );

  return (
    <div className="grid-pad">
      {sections.map(({ sec, items }) => (
        <div key={sec.id}>
          <MemoryHeading
            sec={sec}
            count={items.length}
            tokLabel={t('sec.tokens', { n: sec.indexTokens.toLocaleString() })}
          />
          {/* コストはフィルタと無関係に全件が毎セッション注入されるので sec 全体で計算する */}
          <CostBar sec={sec} pluginTok={pluginTok} userTok={userTok} onOpenTriage={onOpenTriage} />
          <div className="grid">
            {items.map((it) => (
              <MemoryCard key={it.path} it={it} sec={sec} onOpen={onOpen} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
