// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { selectBatchStack } from '@/features/canvas/application/stacks';
import { BatchStackControl } from './BatchStackControl';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
it('collapses onto the selected result and restores the whole batch in one undo', () => {
  useCanvasStore.setState({ nodes: [], edges: [], revision: 0, selectedNodeId: null, history: { past: [], future: [] }, dragHistorySnapshot: null });
  const first = useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.exportImage, { x: 0, y: 0 }, { batchId: 'batch', batchIndex: 0, batchTotal: 2, imageUrl: '/a.png' });
  const second = useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.exportImage, { x: 400, y: 0 }, { batchId: 'batch', batchIndex: 1, batchTotal: 2, imageUrl: '/b.png' });
  useCanvasStore.setState({ history: { past: [], future: [] } });
  render(<BatchStackControl nodeId={second} batchId="batch" index={2} total={2} collapsed={false} selected />);
  fireEvent.click(screen.getByRole('button', { name: 'rework.canvas.stack.collapse' }));
  expect(selectBatchStack(useCanvasStore.getState().nodes, 'batch')).toMatchObject({ collapsed: true, primaryId: second });
  expect(useCanvasStore.getState().history.past).toHaveLength(1);
  useCanvasStore.getState().undo();
  expect(selectBatchStack(useCanvasStore.getState().nodes, 'batch')).toMatchObject({ collapsed: false, primaryId: first });
  expect(useCanvasStore.getState().nodes.every((node) => !node.hidden)).toBe(true);
});
