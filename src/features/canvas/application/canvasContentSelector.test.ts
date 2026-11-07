import { describe, expect, it } from 'vitest';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { createCanvasContentSelector } from './canvasContentSelector';

function node(id: string): CanvasNode {
  return { id, type: 'textAnnotationNode', position: { x: 0, y: 0 }, data: { content: id } };
}

describe('canvas content projection', () => {
  it('keeps metadata indexes stable through drag, resize and selection-only updates', () => {
    const select = createCanvasContentSelector();
    const initial = [node('a'), node('b')];
    expect(select(initial)).toBe(initial);
    const moving = initial.map((item) => ({ ...item, position: { x: 50, y: 20 }, dragging: true, selected: true, measured: { width: 640, height: 300 } }));
    expect(select(moving)).toBe(initial);
    expect(select(moving)).toBe(initial);
  });

  it('publishes new content for immutable data changes and node replacement', () => {
    const select = createCanvasContentSelector();
    const initial = [node('a')];
    select(initial);
    const edited = [{ ...initial[0], data: { content: 'changed' } }];
    expect(select(edited)).toBe(edited);
    const replaced = [{ ...edited[0], type: 'aiTextNode' as const }];
    expect(select(replaced)).toBe(replaced);
  });

  it('invalidates membership, order and parent changes without retaining an old project', () => {
    const select = createCanvasContentSelector();
    const initial = [node('a'), node('b')];
    select(initial);
    const reordered = [...initial].reverse();
    expect(select(reordered)).toBe(reordered);
    const reparented = [{ ...reordered[0], parentId: 'group' }, reordered[1]];
    expect(select(reparented)).toBe(reparented);
    const empty: CanvasNode[] = [];
    expect(select(empty)).toBe(empty);
    const anotherProject = [node('c')];
    expect(select(anotherProject)).toBe(anotherProject);
  });
});
