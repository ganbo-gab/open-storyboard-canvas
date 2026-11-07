import { useCallback, useRef } from 'react';
import type { NodePositionChange } from '@xyflow/react';

import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import type { CanvasClipboardApi } from '@/features/canvas/clipboard/useCanvasClipboard';
import { useCanvasStore } from '@/stores/canvasStore';
import { beginAlignmentDrag } from './alignment';
import { IS_MAC } from './shortcuts';

const ALT_DRAG_COPY_Z_INDEX = 2000;

interface AltDragState {
  startPositions: Map<string, { x: number; y: number }>;
  copyIdBySource: Map<string, string>;
}

function buildChanges(state: AltDragState, delta: { x: number; y: number }, dragging: boolean) {
  const changes: NodePositionChange[] = [];
  for (const [sourceId, start] of state.startPositions) {
    changes.push({ id: sourceId, type: 'position', position: start, dragging });
    const copyId = state.copyIdBySource.get(sourceId);
    if (copyId) {
      changes.push({ id: copyId, type: 'position', position: { x: start.x + delta.x, y: start.y + delta.y }, dragging });
    }
  }
  return changes;
}

/**
 * ⌥-drag duplicates: on drag start the selection is copied in place, then the originals are
 * pinned to their start positions while the copies follow the pointer. One undo step.
 */
export function useAltDragCopy(
  clipboard: Pick<CanvasClipboardApi, 'duplicateNodes'>,
  scheduleCanvasPersist: (delayMs?: number) => void
) {
  const stateRef = useRef<AltDragState | null>(null);

  const onNodeDragStart = useCallback((event: MouseEvent | TouchEvent, node: CanvasNode) => {
    beginAlignmentDrag(IS_MAC ? event.metaKey : event.ctrlKey);
    stateRef.current = null;
    if (!event.altKey) return;
    const { nodes } = useCanvasStore.getState();
    const selectedIds = nodes.filter((item) => item.selected).map((item) => item.id);
    const sourceIds = selectedIds.includes(node.id) ? selectedIds : [node.id];
    const startPositions = new Map<string, { x: number; y: number }>();
    for (const sourceId of sourceIds) {
      const source = nodes.find((item) => item.id === sourceId);
      if (source) startPositions.set(sourceId, { ...source.position });
    }
    if (startPositions.size === 0) return;

    const duplicated = clipboard.duplicateNodes(sourceIds, {
      explicitOffset: { x: 0, y: 0 },
      disableOffsetIteration: true,
      suppressPersist: true,
      suppressSelect: true,
    });
    if (!duplicated) return;
    const copyIdBySource = new Map<string, string>();
    for (const sourceId of sourceIds) {
      const copyId = duplicated.idMap.get(sourceId);
      if (copyId) copyIdBySource.set(sourceId, copyId);
    }
    if (copyIdBySource.size === 0) return;
    beginAlignmentDrag(IS_MAC ? event.metaKey : event.ctrlKey, copyIdBySource.values());

    const copyIds = new Set(copyIdBySource.values());
    useCanvasStore.setState((state) => ({
      nodes: state.nodes.map((item) => (copyIds.has(item.id)
        ? { ...item, zIndex: ALT_DRAG_COPY_Z_INDEX, style: { ...(item.style ?? {}), zIndex: ALT_DRAG_COPY_Z_INDEX } }
        : item)),
    }));
    stateRef.current = { startPositions, copyIdBySource };
  }, [clipboard]);

  const onNodeDrag = useCallback((_event: MouseEvent | TouchEvent, node: CanvasNode) => {
    const state = stateRef.current;
    const start = state?.startPositions.get(node.id);
    if (!state || !start) return;
    const delta = { x: node.position.x - start.x, y: node.position.y - start.y };
    useCanvasStore.getState().onNodesChange(buildChanges(state, delta, true));
  }, []);

  const onNodeDragStop = useCallback((_event: MouseEvent | TouchEvent, node: CanvasNode) => {
    const state = stateRef.current;
    stateRef.current = null;
    const start = state?.startPositions.get(node.id);
    if (!state || !start) return;
    const delta = { x: node.position.x - start.x, y: node.position.y - start.y };
    const store = useCanvasStore.getState();
    store.onNodesChange(buildChanges(state, delta, false));
    store.setSelectedNodeIds([...state.copyIdBySource.values()]);
    scheduleCanvasPersist(0);
  }, [scheduleCanvasPersist]);

  return { onNodeDragStart, onNodeDrag, onNodeDragStop };
}
