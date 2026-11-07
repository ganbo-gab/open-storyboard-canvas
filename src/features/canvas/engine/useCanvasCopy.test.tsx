// @vitest-environment jsdom
import { createRef } from 'react';
import { cleanup, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useCanvasHotkeys } from './useCanvasHotkeys';
import type { CanvasActions } from './canvasActions';
import { useCanvasStore } from '@/stores/canvasStore';
const no = () => {};
function setup() {
  const copy = vi.fn();
  const actions: CanvasActions = { zoomIn: no, zoomOut: no, zoomTo: no, fitView: no, focusNodes: no,
    undo: no, redo: no, selectAll: no, clearSelection: no, copySelection: copy, duplicateSelection: no,
    deleteSelection: no, groupSelection: no, ungroupSelection: no, connectSelection: no, generateSelection: no,
    layoutSelection: no, organizeCanvas: no, viewportCenter: () => ({ x: 0, y: 0 }), createNode: () => null, openAddMenu: no,
    clipboard: { copyNodes: no, duplicateNodes: () => null, pasteFromShortcut: async () => false, pasteAt: async () => {}, copyText: async () => {} } };
  const wrapper = createRef<HTMLElement>(); wrapper.current = document.body;
  renderHook(() => useCanvasHotkeys(actions, wrapper, { current: null })); return copy;
}
afterEach(cleanup);
it('handles an OS menu copy event while preserving native text editing and modal ownership', () => {
  useCanvasStore.setState({ nodes: [{ id: 'a', type: 'imageNode', selected: true, position: { x: 0, y: 0 }, data: { imageUrl: null, aspectRatio: '1:1' } }], activeDirectorStudioNodeId: null });
  const copy = setup();
  fireEvent.copy(document.body); expect(copy).toHaveBeenCalledOnce();
  const input = document.createElement('input'); document.body.append(input); fireEvent.copy(input); input.remove();
  const dialog = document.createElement('div'); dialog.setAttribute('aria-modal', 'true'); document.body.append(dialog); fireEvent.copy(document.body); dialog.remove();
  expect(copy).toHaveBeenCalledOnce();
});
