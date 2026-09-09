/* SKILL.md 用の最小 markdown レンダラ(依存ゼロ・HTML エスケープ込み) */

export const esc = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  );

/*
 * URL の文字クラスから \uE000 を除く。renderMemoryBody が [[x]] をこの私用領域文字に退避して
 * レンダリング後に HTML へ差し戻すため、取り込まれると href 属性値の中や <a> の中に <a> が入って壊れる。
 */
function mdInlines(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(
      /\[([^\]\uE000]+)\]\((https?:[^)\uE000]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>',
    )
    .replace(
      /(^|\s)(https?:\/\/[^\s<)\uE000]+)/g,
      '$1<a href="$2" target="_blank" rel="noopener">$2</a>',
    );
}

export function mdRender(src: string): string {
  const lines = src.split(/\r?\n/);
  let html = '';
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (para.length) {
      html += '<p>' + mdInlines(para.join(' ')) + '</p>';
      para = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      html += '<pre><code>' + esc(buf.join('\n')) + '</code></pre>';
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      flush();
      html += `<h${h[1].length}>` + mdInlines(h[2]) + `</h${h[1].length}>`;
      i++;
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      flush();
      const items: { nested: boolean; text: string }[] = [];
      const ordered = /^\s*\d+\./.test(line);
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        const nested = /^\s{2,}/.test(lines[i]);
        items.push({ nested, text: lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, '') });
        i++;
        // 継続行(次のリスト項目でも空行・見出し・フェンスでもない行)は直前項目に連結
        while (
          i < lines.length &&
          lines[i].trim() &&
          !/^\s*([-*+]|\d+\.)\s+/.test(lines[i]) &&
          !/^#{1,4}\s|^```/.test(lines[i])
        ) {
          items[items.length - 1].text += ' ' + lines[i].trim();
          i++;
        }
      }
      const tag = ordered ? 'ol' : 'ul';
      let out = `<${tag}>`;
      let sub: string[] = [];
      const flushSub = () => {
        if (sub.length) {
          out += '<ul>' + sub.map((t) => '<li>' + mdInlines(t) + '</li>').join('') + '</ul>';
          sub = [];
        }
      };
      for (const it of items) {
        if (it.nested) {
          sub.push(it.text);
          continue;
        }
        flushSub();
        out += '<li>' + mdInlines(it.text) + '</li>';
      }
      flushSub();
      html += out + `</${tag}>`;
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      html += '<blockquote>' + mdInlines(buf.join(' ')) + '</blockquote>';
      continue;
    }
    if (/^(---+|\*\*\*+)\s*$/.test(line)) {
      flush();
      html += '<hr>';
      i++;
      continue;
    }
    if (!line.trim()) {
      flush();
      i++;
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return html;
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
    const h = line.match(/^(#{1,4})\s+(.*)/);
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
