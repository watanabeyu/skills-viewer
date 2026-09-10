/*
 * 一覧ツールバーの部品(design-system 1.4 の見出し行 .hd-r と .blk-tools に載るコントロール)。
 * ホーム ③「使えるもの」と「すべてのプロジェクト」に同じ select / 検索欄が別々に書かれていたので、
 * コントロール 1 つを 1 部品として 1 か所に寄せた。
 *
 * 寄せたのはコントロールの組み立て方(class・文言・状態依存の on)だけで、並べ方は各画面に残す:
 * 何を出すか(使用実績は usage 次第、種類は select かセグメントか)と見出し脇に何を書くかは
 * 画面ごとの関心で、ここに畳むと分岐だらけの部品になる。
 * setParam へ渡す値の規則(既定値は null にして URL から消す)は各コントロールが自分で持つ
 * ── 既定値はその選択肢の一覧と一体で、呼び出し側に散らすと URL の意味がずれる。
 */

import {
  KIND_FILTERS,
  USE_FILTERS,
  labelOfUseFilter,
  type KindFilter,
  type SortKey,
  type UseFilter,
} from '../util';
import { t, type MsgKey } from '../i18n';
import { useNarrow } from './Rows';

type SetParam = (key: string, value: string | null) => void;

const SORT_KEYS: [SortKey, MsgKey][] = [
  ['name', 'sort.name'],
  ['uses', 'sort.uses'],
  ['recent', 'sort.recent'],
  ['updated', 'sort.updated'],
  ['tokens', 'sort.tokens'],
];

/* 種類の絞り込み(select 版)。ホーム ③ は同じ絞り込みをセグメント(Seg)で出す */
export function KindSelect({ kind, setParam }: { kind: KindFilter; setParam: SetParam }) {
  return (
    <select
      className={'sel' + (kind !== 'all' ? ' on' : '')}
      value={kind}
      onChange={(e) => setParam('kind', e.target.value === 'all' ? null : e.target.value)}
    >
      {KIND_FILTERS.map((key) => (
        <option key={key} value={key}>
          {t('filter.kindPrefix', { v: key === 'all' ? t('kind.all') : key })}
        </option>
      ))}
    </select>
  );
}

/* 使用実績の絞り込み。トランスクリプトが無い環境では出さない(判定できない軸を選ばせない) */
export function UseSelect({
  use,
  usage,
  setParam,
}: {
  use: UseFilter;
  usage: boolean;
  setParam: SetParam;
}) {
  if (!usage) return null;
  return (
    <select
      className={'sel' + (use !== 'all' ? ' on' : '')}
      value={use}
      title={t('filter.unusedTitle')}
      onChange={(e) => setParam('use', e.target.value === 'all' ? null : e.target.value)}
    >
      {USE_FILTERS.map((key) => (
        <option key={key} value={key}>
          {t('filter.usePrefix', { v: labelOfUseFilter(key) })}
        </option>
      ))}
    </select>
  );
}

/* 並び順。既定の name のときだけ URL から消す */
export function SortSelect({ sort, setParam }: { sort: SortKey; setParam: SetParam }) {
  return (
    <select
      className="sel"
      value={sort}
      onChange={(e) => setParam('sort', e.target.value === 'name' ? null : e.target.value)}
      title={t('sort.title')}
    >
      {SORT_KEYS.map(([key, msgKey]) => (
        <option key={key} value={key}>
          {t('sort.prefix', { v: t(msgKey) })}
        </option>
      ))}
    </select>
  );
}

/* 名前 + 説明 + 使用実績のインクリメンタル検索。幅 1280 未満は短いプレースホルダに差し替える */
export function SearchBox({ q, setParam }: { q: string; setParam: SetParam }) {
  const narrow = useNarrow();
  return (
    <label className="search">
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5L14 14" />
      </svg>
      <input
        placeholder={t(narrow ? 'act.searchShort' : 'act.search')}
        value={q}
        onChange={(e) => setParam('q', e.target.value || null)}
      />
    </label>
  );
}

/*
 * 検索欄の隣のセグメント(ホーム ③ は種類、「すべてのプロジェクト」は並び)。
 * 選択肢と押したときの反映は画面ごとに違うので外から渡し、ここは見た目と現在値の on だけを持つ。
 */
export function Seg<T extends string>({
  options,
  value,
  onPick,
  title,
}: {
  options: [T, string][];
  value: T;
  onPick: (v: T) => void;
  title?: string;
}) {
  return (
    <span className="seg" title={title}>
      {options.map(([v, label]) => (
        <button key={v} className={value === v ? 'on' : ''} onClick={() => onPick(v)}>
          {label}
        </button>
      ))}
    </span>
  );
}
