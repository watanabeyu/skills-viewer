/*
 * ヘッダーのプロジェクト切替(design-system 1.1)。中身は「今いるプロジェクト / 他のプロジェクト… /
 * すべてのプロジェクト」の 1 列で、どれを選んでも同じホームの骨格(README 6.2)。
 * 押せるので罫線付きのドロップダウン(▾)。選択は ?project=<Section.id | all>(設計判断 13 の安定 id)。
 */

import { useEffect, useRef, useState } from 'react';
import type { Section, SkillsData } from '../api';
import { fileName, type ProjectSel } from '../util';
import { t } from '../i18n';
import { SourceDot } from './Rows';

function Chevron() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M3 4.5l3 3 3-3" />
    </svg>
  );
}

function Lines() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M2 3.5h8M2 6h8M2 8.5h8" />
    </svg>
  );
}

export function ProjectSwitcher({
  data,
  project,
  onSelect,
}: {
  data: SkillsData;
  project: ProjectSel;
  /* null = cwd のプロジェクト(URL には書かない)。'all' = すべて */
  onSelect: (id: string | null) => void;
}) {
  const [openMenu, setOpenMenu] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!openMenu) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpenMenu(false);
    };
    const timer = window.setTimeout(() => document.addEventListener('click', handler), 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('click', handler);
    };
  }, [openMenu]);

  const projects = data.sections.filter((s) => s.source === 'project');
  const current = projects.find((s) => s.isCurrent) || null;
  const others = projects.filter((s) => !s.isCurrent);
  const cwdName = current?.projectName || fileName(data.cwd);
  const pick = (id: string | null) => {
    setOpenMenu(false);
    onSelect(id);
  };
  const row = (
    s: Section | null,
    label: string,
    path: string,
    id: string | null,
    /* 起動ディレクトリの行。cwd は既定の選択にすぎないので、特別扱いはこの印だけ(計画 16 判断 7) */
    cwd = false,
  ) => (
    <button key={id ?? 'cwd'} className="di" onClick={() => pick(id)}>
      <span className="l1">
        <SourceDot source="project" />
        {label}
        {cwd && <span className="proj-cur">{t('proj.current')}</span>}
        {s === null && id === null && <span className="meta"> · {t('proj.empty')}</span>}
      </span>
      <span className="l2">{path}</span>
    </button>
  );
  return (
    <span className="proj" ref={ref}>
      <button className="proj-btn" onClick={() => setOpenMenu((v) => !v)} title={t('proj.title')}>
        {project === 'all' ? (
          <>
            <Lines />
            <span>{t('proj.all')}</span>
          </>
        ) : (
          <>
            {/*
             * ラベルはサーバーが計算した対象(selected)を出す。0 件で Section が無いプロジェクトを
             * 選んでいても名前とパスが出る。cwd かどうかは印だけで区別する(計画 16 判断 3・7)
             */}
            <SourceDot source="project" />
            <span>{data.selected.name}</span>
            <span className="meta proj-path">{data.selected.path}</span>
            {data.selected.isCwd && <span className="proj-cur">{t('proj.current')}</span>}
          </>
        )}
        <Chevron />
      </button>
      {openMenu && (
        <div className="drop proj-drop">
          {row(current, cwdName, current?.note || data.cwd, null, true)}
          {others.length > 0 && <div className="dh">{t('proj.others')}</div>}
          {others.map((s) => row(s, s.projectName || '', s.note, s.id))}
          <div className="dsep" />
          <button className="di" onClick={() => pick('all')}>
            <span className="l1">
              <Lines />
              {t('proj.all')}
            </span>
            <span className="l2">{t('proj.allSub', { n: projects.length })}</span>
          </button>
        </div>
      )}
    </span>
  );
}
