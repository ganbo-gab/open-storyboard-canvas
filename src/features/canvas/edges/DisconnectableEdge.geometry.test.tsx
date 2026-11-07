// @vitest-environment jsdom
import { useLayoutEffect, useRef } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { Position, ReactFlowProvider, useStoreApi, type EdgeProps } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { DisconnectableEdge } from './DisconnectableEdge';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const INITIAL: EdgeProps = { id: 'edge', source: 'source', target: 'target', sourceX: 0, sourceY: 0, targetX: 200, targetY: 100, sourcePosition: Position.Right, targetPosition: Position.Left, selected: true };
function Surface({ edge }: { edge: EdgeProps }) {
  const root = useRef<HTMLDivElement>(null);
  const store = useStoreApi();
  useLayoutEffect(() => { store.setState({ domNode: root.current, width: 800, height: 600 }); }, [store]);
  return <div ref={root}><div className="react-flow__edgelabel-renderer" /><svg><g><DisconnectableEdge {...edge} /></g></svg></div>;
}
function mount() {
  const mounted = render(<ReactFlowProvider><Surface edge={INITIAL} /></ReactFlowProvider>);
  return { ...mounted, move: (edge: EdgeProps) => mounted.rerender(<ReactFlowProvider><Surface edge={edge} /></ReactFlowProvider>) };
}
function paths(container: HTMLElement) {
  return [...container.querySelectorAll<SVGPathElement>('.react-flow__edge-path, .react-flow__edge-interaction, .canvas-edge__flow, .canvas-edge__hit')];
}

beforeEach(() => {
  useSettingsStore.setState({ canvasEdgeRoutingMode: 'spline' });
  useCanvasStore.getState().setCanvasData([
    { id: 'source', type: 'uploadNode', position: { x: 0, y: 0 }, data: { imageUrl: null, aspectRatio: '1:1' } },
    { id: 'target', type: 'aiTextNode', position: { x: 200, y: 100 }, data: { prompt: 'Fixture' } },
  ], [{ id: 'edge', source: 'source', target: 'target' }]);
});
afterEach(cleanup);

describe('edge artwork geometry transport', () => {
  it('keeps visible, interaction and highlight paths aligned with both moved endpoints', () => {
    const mounted = mount();
    const initialPaths = paths(mounted.container);
    expect(initialPaths).toHaveLength(4);
    const oldPath = initialPaths[0].getAttribute('d');
    mounted.move({ ...INITIAL, sourceX: 20, sourceY: 30, targetX: 220, targetY: 130 });
    const movedPaths = paths(mounted.container);
    expect(movedPaths.every((path, index) => path === initialPaths[index])).toBe(true);
    const updatedPath = movedPaths[0].getAttribute('d');
    expect(updatedPath).not.toBe(oldPath);
    expect(updatedPath).toMatch(/^M20,30/);
    expect(updatedPath).toMatch(/220,130\s*$/);
    expect(movedPaths.every(path => path.getAttribute('d') === updatedPath)).toBe(true);
    const cut = mounted.container.querySelector<HTMLButtonElement>('.canvas-edge__cut');
    expect(cut?.style.transform).toContain('translate(120px, 80px)');
  });

  it('refreshes metadata and geometry together without restoring an obsolete cached path', () => {
    const mounted = mount();
    mounted.move({ ...INITIAL, sourceX: 20, sourceY: 30, targetX: 220, targetY: 130 });
    mounted.move({ ...INITIAL, sourceX: 40, sourceY: 60, targetX: 240, targetY: 160, markerEnd: 'url(#fixture-marker)', style: { stroke: 'red' }, selected: false });
    const artwork = paths(mounted.container);
    expect(artwork[0].getAttribute('marker-end')).toBe('url(#fixture-marker)');
    expect(artwork[0].style.stroke).toBe('red');
    expect(artwork.every(path => path.getAttribute('d')?.startsWith('M40,60'))).toBe(true);
    expect(artwork.every(path => /240,160\s*$/.test(path.getAttribute('d') ?? ''))).toBe(true);
    expect(mounted.container.querySelector('.canvas-edge__cut')).toBeNull();
  });

  it('keeps the moving scissors control connected to the real canonical delete action', () => {
    const mounted = mount();
    mounted.move({ ...INITIAL, sourceX: 80, sourceY: 100, targetX: 280, targetY: 200 });
    const cut = mounted.container.querySelector<HTMLButtonElement>('.canvas-edge__cut');
    if (!cut) throw new Error('Selected edge control is missing');
    expect(cut.style.transform).toContain('translate(180px, 150px)');
    act(() => fireEvent.click(cut));
    expect(useCanvasStore.getState().edges).toEqual([]);
  });
});
