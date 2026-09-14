/*
 * SKILL.md / CLAUDE.md / memory 本文の markdown レンダラ(web だけで使う。server は import しない)。
 *
 * v0.9.0 までは自前の最小レンダラだったが、CLAUDE.md は SKILL.md より長く構造も多い
 * (5 段目以降の見出し・入れ子のリスト・表・強調)ので、取りこぼしが「読みづらい」に直結した。
 * markdown-it(devDependency。Vite がバンドルするので公開パッケージの dependencies は空のまま)に
 * 置き換え、規則は CommonMark に任せる。
 *
 * 出力は表示専用なので、読み込む側に有利なものは全部切る:
 * - html: false — 本文の生 HTML はタグごとエスケープ(clone したリポジトリの CLAUDE.md が script を仕込めない)
 * - 画像は描かない — 外部画像の読み込み = 表示しただけで外へ出る通信。`![alt](src)` は文字どおり出す
 * - リンクは http(s) だけ <a>(target=_blank / rel=noopener)。相対パスや `javascript:` は文字のまま
 *   (相対パスを <a> にすると SPA のルータが拾って壊れたページへ飛ぶ)
 * - linkify は fuzzyLink を切る — 既定では `apps/e2e/README.md` の `.md` を TLD と見なして
 *   http://README.md へのリンクにしてしまう。`https://` で始まるものだけ拾う
 */

import MarkdownIt from 'markdown-it';

export const esc = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  );

const isHttp = (href: string) => /^https?:\/\//i.test(href);

const md = new MarkdownIt({ html: false, linkify: true });
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });

/* memory の [[x]] を退避した印(renderMemoryBody)。リンクの中に入ると <a> の中に <a> ができる */
const HOLE = '\uE000';

/* 画像は `![alt](src)` の字面をそのまま出す(image のルールを外すと `!` + リンクに化けるので描画側で潰す) */
md.renderer.rules.image = (tokens, idx) => {
  const tok = tokens[idx];
  return '![' + esc(tok.content) + '](' + esc(String(tok.attrGet('src') ?? '')) + ')';
};

/*
 * link_open / link_close の描画。<a> にするのは http(s) で、リンク文字列にも href にも
 * 退避文字が無いものだけ。それ以外は <span> にする(閉じタグも同じトークン配列にあるので、
 * 開きで見つけた閉じの tag を先に書き換えておく。リンクは入れ子にならない)
 */
md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  const tok = tokens[idx];
  const href = String(tok.attrGet('href') ?? '');
  const closeAt = tokens.findIndex((t, i) => i > idx && t.type === 'link_close');
  const inner = closeAt < 0 ? [] : tokens.slice(idx + 1, closeAt);
  const hole = href.includes(HOLE) || inner.some((t) => t.content.includes(HOLE));
  if (isHttp(href) && !hole) {
    tok.attrSet('target', '_blank');
    tok.attrSet('rel', 'noopener');
  } else {
    tok.tag = 'span';
    tok.attrs = null;
    if (closeAt >= 0) tokens[closeAt].tag = 'span';
  }
  return self.renderToken(tokens, idx, options);
};

/*
 * 本文 → HTML。全テキストは markdown-it がエスケープする(html: false)。
 * memory の [[x]] は呼び出し側が私用領域の文字(\uE000)に退避してから渡し、描画後に差し戻す。
 * その文字はエスケープの対象でも記法でもないので、そのまま通り抜ける
 */
export function mdRender(src: string): string {
  return md.render(src);
}

/* frontmatter を分離して返す */
export function splitFrontmatter(raw: string): { frontmatter: string | null; body: string } {
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!fm) return { frontmatter: null, body: raw };
  return { frontmatter: fm[1], body: raw.slice(fm[0].length) };
}

/*
 * 見出しの一覧(フロー図未生成時の代替表示。design-system 0.6「構造そのもの」)。
 * レンダラと同じ規則でコードフェンス内の # は見出しに数えない。text はインラインの
 * 装飾(`code` / **強調**)を剥がした素の文字列。
 */
export interface MdHeading {
  level: number;
  text: string;
}

export function mdHeadings(src: string): MdHeading[] {
  const out: MdHeading[] = [];
  let inFence = false;
  for (const line of src.split(/\r?\n/)) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (!h) continue;
    const text = h[2]
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\s+#+\s*$/, '')
      .trim();
    if (text) out.push({ level: h[1].length, text });
  }
  return out;
}

/*
 * 全文の先頭だけを見せて残りを「続きを表示(残り n 行)」に畳むための分割。
 * minLines 以降の最初の空行(コードフェンスの外)で切る。切れる場所が無い、または残りが
 * 短い(minRest 行未満)ときは畳まず全文を返す(rest が空)。
 */
export function splitPreview(
  body: string,
  minLines = 12,
  minRest = 8,
): { head: string; rest: string; restLines: number } {
  const lines = body.split(/\r?\n/);
  let inFence = false;
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i])) inFence = !inFence;
    if (i >= minLines && !inFence && !lines[i].trim()) {
      cut = i;
      break;
    }
  }
  if (cut < 0 || lines.length - cut < minRest) return { head: body, rest: '', restLines: 0 };
  return {
    head: lines.slice(0, cut).join('\n'),
    rest: lines.slice(cut).join('\n'),
    restLines: lines.length - cut,
  };
}
