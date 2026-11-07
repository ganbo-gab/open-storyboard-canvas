// @vitest-environment jsdom
import { useLayoutEffect, useRef } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { ReactFlowProvider, useStoreApi, type ReactFlowState } from '@xyflow/react';
import type { StoreApi } from 'zustand';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useCanvasAlignmentStore } from '@/features/canvas/state/canvasUiStore';
import { AlignmentGuidesOverlay } from './AlignmentGuidesOverlay';
import {
  GUIDE_DASH_PERIOD,
  GUIDE_LEGACY_EXTENT,
  GUIDE_VIEWPORT_PADDING_PX,
  resolveGuideSpanEnd,
  resolveGuideSpanStart,
} from './alignmentGuideSpan';

const EPSILON = 1e-6;
let flow: Pick<StoreApi<ReactFlowState>, 'setState'> | undefined;

/** Asserts a span covers the padded viewport, overshoots by less than one dash period and keeps the legacy phase. */
function expectViewportSpan(start: number, end: number, translate: number, zoom: number, size: number) {
  const visibleStart = (-GUIDE_VIEWPORT_PADDING_PX - translate) / zoom;
  const visibleEnd = (size + GUIDE_VIEWPORT_PADDING_PX - translate) / zoom;
  expect(start).toBeLessThanOrEqual(visibleStart + EPSILON);
  expect(start).toBeGreaterThan(visibleStart - GUIDE_DASH_PERIOD);
  expect(end).toBeGreaterThanOrEqual(visibleEnd - EPSILON);
  expect(end).toBeLessThan(visibleEnd + GUIDE_DASH_PERIOD);
  expect((start + GUIDE_LEGACY_EXTENT) % GUIDE_DASH_PERIOD).toBe(0);
}

function Surface() {
  const root = useRef<HTMLDivElement>(null);
  const store = useStoreApi();
  flow = store;
  useLayoutEffect(() => { store.setState({ domNode: root.current, width: 800, height: 600, transform: [100, 50, 2] }); }, [store]);
  return <div ref={root}><div className="react-flow__viewport-portal" /><AlignmentGuidesOverlay /></div>;
}

function line(container: HTMLElement, index: number) {
  const element = container.querySelectorAll('.canvas-alignment-guides line')[index];
  if (!element) throw new Error(`Missing guide line ${index}`);
  return (name: string) => Number(element.getAttribute(name));
}

function setFlow(state: Partial<ReactFlowState>) {
  const store = flow;
  if (!store) throw new Error('Surface is not mounted');
  act(() => store.setState(state));
}

beforeEach(() => {
  flow = undefined;
  useCanvasAlignmentStore.getState().setAlignmentGuides(null);
});
afterEach(cleanup);

describe('viewport-bounded alignment guide span', () => {
  it('covers the padded viewport with the legacy dash phase at fractional and large zooms', () => {
    for (const zoom of [0.1, 0.37, 1, 1.25, 4]) {
      for (const translate of [-54_321.5, -3.3, 0, 2, 127, 43_210.7]) {
        const start = resolveGuideSpanStart(translate, zoom, 900);
        const end = resolveGuideSpanEnd(translate, zoom, 900);
        expectViewportSpan(start, end, translate, zoom, 900);
      }
    }
  });

  it('stays inside the legacy interval and draws nothing where the legacy line never reached', () => {
    // Viewport straddles the legacy start/end: clipped, still increasing and non-empty.
    expect(resolveGuideSpanStart(1_000_100, 1, 800)).toBe(-GUIDE_LEGACY_EXTENT);
    expect(resolveGuideSpanEnd(1_000_100, 1, 800)).toBeGreaterThan(-GUIDE_LEGACY_EXTENT);
    expect(resolveGuideSpanEnd(-999_700, 1, 800)).toBe(GUIDE_LEGACY_EXTENT);
    expect(resolveGuideSpanStart(-999_700, 1, 800)).toBeLessThan(GUIDE_LEGACY_EXTENT);
    // Entirely outside on either side: empty, never reversed geometry.
    for (const translate of [2_000_000, -2_000_000]) {
      expect(resolveGuideSpanStart(translate, 1, 800) < resolveGuideSpanEnd(translate, 1, 800)).toBe(false);
    }
  });

  it('yields an empty span for an unmeasured pane or unusable transform', () => {
    for (const [translate, zoom, size] of [[0, 1, 0], [0, 1, Number.NaN], [0, 0, 800], [0, Number.NaN, 800], [Number.POSITIVE_INFINITY, 1, 800]]) {
      expect(resolveGuideSpanStart(translate, zoom, size) < resolveGuideSpanEnd(translate, zoom, size)).toBe(false);
    }
  });

  it('follows pan, zoom and resize with unchanged guide coordinates and releases on clear', () => {
    const { container } = render(<ReactFlowProvider><Surface /></ReactFlowProvider>);
    act(() => useCanvasAlignmentStore.getState().setAlignmentGuides({ x: [10], y: [20] }));
    const column = line(container, 0);
    const row = line(container, 1);
    expect([column('x1'), column('x2'), row('y1'), row('y2')]).toEqual([10, 10, 20, 20]);
    expectViewportSpan(column('y1'), column('y2'), 50, 2, 600);
    expectViewportSpan(row('x1'), row('x2'), 100, 2, 800);

    setFlow({ transform: [-900, 50, 2] });
    expectViewportSpan(line(container, 1)('x1'), line(container, 1)('x2'), -900, 2, 800);
    setFlow({ transform: [-900, -400, 0.37] });
    expectViewportSpan(line(container, 0)('y1'), line(container, 0)('y2'), -400, 0.37, 600);
    setFlow({ width: 1600, height: 300 });
    expectViewportSpan(line(container, 0)('y1'), line(container, 0)('y2'), -400, 0.37, 300);
    expectViewportSpan(line(container, 1)('x1'), line(container, 1)('x2'), -900, 0.37, 1600);
    expect(line(container, 0)('x1')).toBe(10);
    expect(line(container, 1)('y1')).toBe(20);

    act(() => useCanvasAlignmentStore.getState().setAlignmentGuides(null));
    expect(container.querySelector('.canvas-alignment-guides')).toBeNull();
  });
});
