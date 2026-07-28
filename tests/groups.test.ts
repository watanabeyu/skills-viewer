import { describe, expect, it } from 'vitest';
import { groupTargets, groupsHash, parseGroups } from '../src/server/groups';
import type { Section, SkillItem } from '../src/shared/types';

const mkItem = (over: Partial<SkillItem>): SkillItem => ({
  name: 'x',
  description: 'desc',
  argumentHint: '',
  version: '',
  kind: 'skill',
  path: '/tmp/x/SKILL.md',
  files: [],
  ...over,
});

const mkSection = (id: string, items: SkillItem[]): Section => ({
  id,
  source: 'user',
  note: '',
  items,
});

describe('groupTargets (分類対象の抽出)', () => {
  it('hook と category 持ちを除外し、name で重複排除して名前順に返す', () => {
    const sections = [
      mkSection('user', [
        mkItem({ name: 'b-review', description: 'レビューする' }),
        mkItem({ name: 'a-plan', description: '設計する' }),
        mkItem({ name: 'manual-one', description: '手動', category: '運用' }),
        mkItem({ name: 'PostToolUse', description: 'cmd', kind: 'hook' }),
      ]),
      mkSection('proj-0', [mkItem({ name: 'b-review', description: '別スコープの同名定義' })]),
    ];
    const targets = groupTargets(sections);
    expect(targets.map((t) => t.name)).toEqual(['a-plan', 'b-review']);
    // 先に見つかった定義の description を使う
    expect(targets[1].description).toBe('レビューする');
  });

  it('description は 200 字で切る', () => {
    const sections = [mkSection('user', [mkItem({ name: 'long', description: 'あ'.repeat(300) })])];
    expect(groupTargets(sections)[0].description).toHaveLength(200);
  });
});

describe('groupsHash', () => {
  it('同じ対象なら同じハッシュ、description が変わればハッシュも変わる', () => {
    const a = [{ name: 'x', description: 'd1' }];
    expect(groupsHash(a)).toBe(groupsHash([{ name: 'x', description: 'd1' }]));
    expect(groupsHash(a)).not.toBe(groupsHash([{ name: 'x', description: 'd2' }]));
  });
});

describe('parseGroups (haiku 出力のパース)', () => {
  const names = ['a-plan', 'b-review'];

  it('正常な JSON を構造化して返す', () => {
    const out = parseGroups(
      JSON.stringify({
        groups: [
          { id: 'planning', label: '企画・要件', emoji: '📐' },
          { id: 'review', label: 'レビュー・検証', emoji: '🔍' },
        ],
        assign: { 'a-plan': 'planning', 'b-review': 'review' },
      }),
      names,
    );
    expect(out.groups).toEqual([
      { id: 'planning', label: '企画・要件', emoji: '📐' },
      { id: 'review', label: 'レビュー・検証', emoji: '🔍' },
    ]);
    expect(out.assign).toEqual({ 'a-plan': 'planning', 'b-review': 'review' });
  });

  it('コードフェンス付き JSON も剥がしてパースする', () => {
    const out = parseGroups(
      '```json\n{"groups":[{"id":"ops","label":"運用"}],"assign":{"a-plan":"ops"}}\n```',
      names,
    );
    expect(out.groups[0].id).toBe('ops');
  });

  it('一覧に無い name への割当(幻覚)と未定義グループへの割当は捨てる', () => {
    const out = parseGroups(
      JSON.stringify({
        groups: [{ id: 'ops', label: '運用' }],
        assign: { 'a-plan': 'ops', ghost: 'ops', 'b-review': 'undefined-group' },
      }),
      names,
    );
    expect(out.assign).toEqual({ 'a-plan': 'ops' });
  });

  it('id はスラッグに正規化し、正規化後の値で割当も照合する', () => {
    const out = parseGroups(
      JSON.stringify({
        groups: [{ id: 'Review & QA', label: 'レビュー' }],
        assign: { 'b-review': 'Review & QA' },
      }),
      names,
    );
    expect(out.groups[0].id).toBe('review-qa');
    expect(out.assign['b-review']).toBe('review-qa');
  });

  it('id 重複・label 空のグループは捨てる', () => {
    const out = parseGroups(
      JSON.stringify({
        groups: [
          { id: 'ops', label: '運用' },
          { id: 'ops', label: '重複' },
          { id: 'empty', label: '' },
        ],
        assign: {},
      }),
      names,
    );
    expect(out.groups).toHaveLength(1);
  });

  it('グループが 1 件も取れない出力はエラー', () => {
    expect(() => parseGroups(JSON.stringify({ groups: [], assign: {} }), names)).toThrow();
    expect(() => parseGroups('ただの文章', names)).toThrow();
  });
});
