/*
 * CLAUDE.md の `@import` 参照を本文から拾う規則。**server と web の単一ソース**。
 *
 * server(src/server/claude-md.ts)は実際に展開し、web(web/src/claudemd.ts)は本文中の
 * 展開位置に印を置く。web は「本文に現れた順」と「サーバーが返した配列の順」を index で
 * 突き合わせるので、両者の規則が 1 文字でもずれると以降の対応が全部 1 つずれ、
 * 実在する @import の行に別のファイルの tok が付く。だから規則はここ 1 か所にしか置かない。
 *
 * 除外の規則は公式に合わせる(https://code.claude.com/docs/en/memory.md):
 * 「Import parsing skips Markdown code spans and fenced code blocks. … writing `@README`
 * keeps the text literal, while @README outside backticks imports the file」。
 * つまりバッククォート(コードスパン)とフェンスの中だけを外し、拡張子もスラッシュも無い
 * `@README` `@Makefile` も参照として扱う。
 */

/* 参照 1 件の長さの上限。これを超えるものはパスではなく、解決の試行が無駄になる */
const MAX_REF_LENGTH = 1024;

/* 末尾の句読点を落とす。正規表現(`[.,;:)\]]+$`)は「.」の長い連なりでバックトラックし、
 * 200KB の 1 行で数秒ブロックする。末尾から数えるだけにして入力長に線形にする */
function trimTail(s: string): string {
  let end = s.length;
  while (end > 0 && '.,;:)]'.includes(s[end - 1])) end--;
  return s.slice(0, end);
}

/* ``` と ~~~ のどちらもフェンス。開始行・終了行そのものは本文として見ない */
export const isFenceLine = (line: string): boolean => /^\s*(```|~~~)/.test(line);

/* 1 行に含まれる参照。フェンスの内側かどうかは呼び出し側が判断する */
export function refsOfLine(line: string): string[] {
  const refs: string[] = [];
  // コードスパンは中身ごと落とす(`@README` は文字どおりの表記で参照ではない)
  for (const m of line.replace(/`[^`]*`/g, ' ').matchAll(/(^|\s)@(\S+)/g)) {
    const ref = trimTail(m[2]);
    if (ref && ref.length <= MAX_REF_LENGTH) refs.push(ref);
  }
  return refs;
}

/*
 * 先頭の frontmatter を落とした本文。web は frontmatter を別枠で描くので印を置けない。
 * server がここを数えて web が数えないと index がずれるため、両者ともこの本文だけを見る
 * (`.claude/rules/*.md` の `description: applies to @types/node` のような値で実際に起きる)。
 */
export function bodyWithoutFrontmatter(raw: string): string {
  if (!/^---\r?\n/.test(raw)) return raw;
  const end = raw.indexOf('\n---', 4);
  if (end < 0) return raw;
  const nl = raw.indexOf('\n', end + 1);
  return nl < 0 ? '' : raw.slice(nl + 1);
}

/* 本文全体から参照を順に拾う(フェンスの内側は見ない) */
export function importRefs(body: string, limit = Infinity): string[] {
  const refs: string[] = [];
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (isFenceLine(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const ref of refsOfLine(line)) {
      refs.push(ref);
      if (refs.length >= limit) return refs;
    }
  }
  return refs;
}
