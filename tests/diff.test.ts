import { describe, expect, it } from 'vitest';
import { diffLines } from '../web/src/diff';

describe('diffLines (同名 skill の行 diff)', () => {
  it('同一テキストは add/del を含まない', () => {
    const lines = diffLines('a\nb\nc', 'a\nb\nc');
    expect(lines.some((l) => l.type === 'add' || l.type === 'del')).toBe(false);
  });

  it('追加行と削除行を検出する', () => {
    const lines = diffLines('a\nb\nc', 'a\nX\nc');
    expect(lines).toContainEqual({ type: 'del', text: 'b' });
    expect(lines).toContainEqual({ type: 'add', text: 'X' });
    expect(lines).toContainEqual({ type: 'ctx', text: 'a' });
  });

  it('長い同一区間は skip に畳む', () => {
    const common = Array.from({ length: 30 }, (_, i) => 'line' + i).join('\n');
    const lines = diffLines(common + '\nEND-A', common + '\nEND-B');
    const skip = lines.find((l) => l.type === 'skip');
    expect(skip).toBeDefined();
    expect(lines).toContainEqual({ type: 'del', text: 'END-A' });
    expect(lines).toContainEqual({ type: 'add', text: 'END-B' });
  });

  it('片方が空でも壊れない', () => {
    const lines = diffLines('', 'a\nb');
    expect(lines.filter((l) => l.type === 'add')).toHaveLength(2);
  });
});
