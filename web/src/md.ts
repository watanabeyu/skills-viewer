/* SKILL.md 用の最小 markdown レンダラ(依存ゼロ・HTML エスケープ込み) */

const esc = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  );

function mdInlines(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(
      /\[([^\]]+)\]\((https?:[^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>',
    )
    .replace(
      /(^|\s)(https?:\/\/[^\s<)]+)/g,
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
