import { afterEach, describe, expect, it } from 'vitest';
import { apiErrorMessage, getLang, setLang, t } from '../web/src/i18n';
import { headingOf, scopeLabelOf } from '../web/src/util';
import type { Section } from '../src/shared/types';

// Node 環境(localStorage なし)では既定 'en'。テスト間で言語をリークさせない
afterEach(() => setLang('en'));

describe('t (辞書引き + 置換)', () => {
  it('言語切替で訳が変わる', () => {
    expect(getLang()).toBe('en');
    expect(t('detail.delete')).toBe('Delete');
    setLang('ja');
    expect(t('detail.delete')).toBe('削除');
  });

  it('{name} プレースホルダを置換する', () => {
    expect(t('app.count', { shown: 3, total: 10 })).toBe('3 / 10 items');
  });

  it('params に無いプレースホルダはそのまま残す(設定例文の {path} など)', () => {
    expect(t('settings.customNeedsPath')).toContain('{path}');
  });
});

describe('apiErrorMessage (エラーコード → 表示文言)', () => {
  it('既知コードは detail 付きで翻訳する', () => {
    setLang('ja');
    expect(apiErrorMessage({ error: 'not-managed-path', detail: '/x' }, 400)).toBe(
      '管理対象外のパスです: /x',
    );
  });

  it('未知コードは code: detail をそのまま出す', () => {
    expect(apiErrorMessage({ error: 'mystery', detail: 'why' }, 400)).toBe('mystery: why');
  });

  it('コードが無ければ HTTP ステータス', () => {
    expect(apiErrorMessage({}, 502)).toBe('HTTP 502');
  });
});

describe('headingOf / scopeLabelOf (構造化 Section から見出しを組み立て)', () => {
  const proj: Section = {
    id: 'proj-0',
    source: 'project',
    projectName: 'monorepo',
    isCurrent: true,
    note: '/w/monorepo',
    items: [],
  };
  const user: Section = { id: 'user', source: 'user', note: '/h/.claude', items: [] };

  it('project は名前 + (current)、それ以外は source 名', () => {
    expect(headingOf(proj)).toBe('project — monorepo (current)');
    expect(headingOf({ ...proj, isCurrent: false })).toBe('project — monorepo');
    expect(headingOf(user)).toBe('user');
  });

  it('scopeLabelOf は project 名 or source 名', () => {
    expect(scopeLabelOf(proj)).toBe('monorepo');
    expect(scopeLabelOf(user)).toBe('user');
  });
});
