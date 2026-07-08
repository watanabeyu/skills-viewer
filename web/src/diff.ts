/* 行単位の LCS diff(依存ゼロ)。SKILL.md 程度のサイズ(数百行)を想定 */

export type DiffLine =
  { type: 'ctx' | 'add' | 'del'; text: string } | { type: 'skip'; count: number };

export function diffLines(aText: string, bText: string): DiffLine[] {
  const a = aText.split('\n');
  const b = bText.split('\n');
  // LCS テーブル
  const n = a.length,
    m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const raw: Exclude<DiffLine, { type: 'skip' }>[] = [];
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      raw.push({ type: 'ctx', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      raw.push({ type: 'del', text: a[i] });
      i++;
    } else {
      raw.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) {
    raw.push({ type: 'del', text: a[i++] });
  }
  while (j < m) {
    raw.push({ type: 'add', text: b[j++] });
  }

  // 変更から離れた連続 ctx(7行以上)は「… N 行同一 …」に畳む(前後3行は残す)
  const out: DiffLine[] = [];
  let run: string[] = [];
  const flushRun = (isEdge: boolean) => {
    if (run.length > 7) {
      const head = isEdge ? 0 : 3;
      const tail = out.length === 0 ? 0 : 3; // 先頭境界では前文脈不要
      // 単純化: 前後3行を残して中央を畳む(先頭・末尾境界は片側のみ)
      const keepHead = out.length === 0 ? 0 : 3;
      const keepTail = isEdge ? 0 : 3;
      void head;
      void tail;
      for (let k = 0; k < keepHead; k++) out.push({ type: 'ctx', text: run[k] });
      out.push({ type: 'skip', count: run.length - keepHead - keepTail });
      for (let k = run.length - keepTail; k < run.length; k++)
        out.push({ type: 'ctx', text: run[k] });
    } else {
      for (const t of run) out.push({ type: 'ctx', text: t });
    }
    run = [];
  };
  for (const line of raw) {
    if (line.type === 'ctx') {
      run.push(line.text);
      continue;
    }
    flushRun(false);
    out.push(line);
  }
  flushRun(true);
  return out;
}
