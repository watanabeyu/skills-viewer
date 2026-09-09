import { afterEach, describe, expect, it } from 'vitest';
import { DICTS, apiErrorMessage, getLang, setLang, t } from '../web/src/i18n';
import type { MsgKey } from '../web/src/i18n';
import { headingOf, scopeLabelOf } from '../web/src/util';
import type { Section } from '../src/shared/types';

// Node 環境(localStorage なし)では既定 'en'。テスト間で言語をリークさせない
afterEach(() => setLang('en'));

describe('t (辞書引き + 置換)', () => {
  it('言語切替で訳が変わる', () => {
    expect(getLang()).toBe('en');
    expect(t('detail.openEditor')).toBe('Open in editor');
    setLang('ja');
    expect(t('detail.openEditor')).toBe('エディタで開く');
  });

  it('{name} プレースホルダを置換する', () => {
    expect(t('chg.count', { n: 3 })).toBe('3 changes');
  });

  it('params に無いプレースホルダはそのまま残す(設定例文の {path} など)', () => {
    expect(t('settings.customNeedsPath')).toContain('{path}');
  });
});

/*
 * 文言だけを訳したときに {name} を落とす / 綴り違いで置換されないまま出す事故を止める。
 * t は params に無いプレースホルダをそのまま残す実装なので、片方の言語でだけ壊れていても
 * 画面に「{n}」が出るまで気づけない。キー単位で集合比較して機械的に落とす。
 */
describe('辞書のプレースホルダ整合', () => {
  const placeholders = (s: string) => new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));

  it.each(Object.keys(DICTS.en) as MsgKey[])('%s の {name} が en / ja で一致する', (key) => {
    expect([...placeholders(DICTS.ja[key])].sort()).toEqual(
      [...placeholders(DICTS.en[key])].sort(),
    );
  });
});

describe('apiErrorMessage (エラーコード → 表示文言)', () => {
  it('既知コードは detail 付きで翻訳する', () => {
    setLang('ja');
    expect(apiErrorMessage({ error: 'not-readable-path', detail: '/x' }, 400)).toBe(
      '読み取り対象外のパスです: /x',
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

/*
 * usageTitle(共有ストアの合算注記)。表示ヘルパだが純関数なのでここで固定する
 * (関数を消す・注記を落とす退行で 742 テストが緑のままだった穴を塞ぐ番犬)
 */
import { usageTitle } from '../web/src/components/MemoryBits';
import type { MemorySection } from '../src/shared/types';

describe('usageTitle (共有ストアの合算注記)', () => {
  const sec = () => ({ items: [] }) as unknown as MemorySection;
  it('共有ストアなら base に合算注記を連結する(2 行)', () => {
    const title = usageTitle({ sharedStore: true } as unknown as MemorySection, 'base');
    expect(title!.split('\n')[0]).toBe('base');
    expect(title).toContain(t('memory.usage.sharedTitle'));
  });
  it('共有ストアで base 無しなら注記だけを返す', () => {
    expect(usageTitle({ sharedStore: true } as unknown as MemorySection)).toBe(
      t('memory.usage.sharedTitle'),
    );
  });
  it('共有ストアでなければ base をそのまま / base も無ければ undefined(title="" を吐かない)', () => {
    expect(usageTitle(sec(), 'base')).toBe('base');
    expect(usageTitle(sec())).toBeUndefined();
  });
});

/*
 * 使われなくなったキーの番犬。型(Record<MsgKey, string>)は「不足」を捕まえるが「余り」は捕まえない。
 * v0.9.0 で画面を組み替えた際に、退役した画面のキーが en / ja 両方に 34 件残っていた
 * (レビュー 2026-09-09 の指摘)。辞書が 2 倍に膨らむので機械的に落とす。
 */
describe('辞書に未使用キーが残っていない', () => {
  /*
   * 動的に組み立てるキーの接頭辞。ここに属するキーはコード中にリテラルで現れない。
   * 免除は接頭辞ごと丸ごとなので、実際にリテラルで書かれている家系(view. / kind.)は
   * 入れない ── 入れるとその家系の未使用キーを永久に見逃す(レビュー 2 周目の指摘)。
   */
  const DYNAMIC_PREFIXES = [
    'lint.',
    'apiError.',
    'invocation.',
    'rel.',
    'memory.state.',
    'memory.word.',
    'memory.signal.',
    'memory.type.',
    'memory.triage.verdict.',
    'memory.triage.est',
    'hook.ev.',
    'cmd.kind.',
    'settings.aiModelNote.',
  ];

  const webSources = async (): Promise<string> => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = path.join(import.meta.dirname, '..', 'web', 'src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) walk(fp);
        else if (/\.tsx?$/.test(e.name) && e.name !== 'i18n.ts') files.push(fp);
      }
    };
    walk(root);
    return files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  };

  it('en のキーはすべてコード中で参照されている', async () => {
    const blob = await webSources();
    // 引用符 3 種で見る(t("x") や t(`x`) で書かれた参照を「未使用」と誤判定しないため)
    const referenced = (k: string) =>
      blob.includes(`'${k}'`) || blob.includes(`"${k}"`) || blob.includes(`\`${k}\``);
    const unused = (Object.keys(DICTS.en) as MsgKey[]).filter(
      (k) => !referenced(k) && !DYNAMIC_PREFIXES.some((p) => k.startsWith(p)),
    );
    expect(unused).toEqual([]);
  });

  /*
   * 「余り」だけでなく「不足」も見る。動的に組み立てるキーは参照が文字列として現れないので、
   * 辞書から落ちても番犬は鳴かず、画面にキー名がそのまま出る
   * (`cmd.skipped.*` を足すつもりで免除だけ書き、文言を落としていた実例がある)。
   */
  it('動的接頭辞にはキーが 1 件以上ある(免除だけが残っていない)', () => {
    const keys = Object.keys(DICTS.en);
    const dead = DYNAMIC_PREFIXES.filter((p) => !keys.some((k) => k.startsWith(p)));
    expect(dead).toEqual([]);
  });
});
