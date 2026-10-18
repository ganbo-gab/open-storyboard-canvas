import { useCallback, useRef } from 'react';
import {
  useReactFlow,
  type Connection,
  type Edge,
  type FinalConnectionState,
  type OnConnectStartParams,
} from '@xyflow/react';

import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import { validateCanvasConnection } from '@/features/canvas/application/canvasConnectionRules';
import { clearBrowserTextSelection } from '@/features/canvas/application/textSelection';
import { CANVAS_COMMAND_VERSION } from '@/features/canvas/domain/canvasCommands';
import {
  getConnectMenuNodeTypes,
  nodeCanStartManualConnection,
  nodeHasSourceHandle,
  nodeHasTargetHandle,
} from '@/features/canvas/domain/nodeRegistry';
import { useCanvasUiStore, type FlowPoint } from '@/features/canvas/state/canvasUiStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { getNodeIdFromTarget } from './domTargets';
import { appendSourceTextToTextNode } from './nodeCreation';

function clientPointOf(event: MouseEvent | TouchEvent): FlowPoint | null {
  if ('clientX' in event) return { x: event.clientX, y: event.clientY };
  const touch = event.changedTouches[0] ?? event.touches[0];
  return touch ? { x: touch.clientX, y: touch.clientY } : null;
}

function canStartFrom(nodeId: string | null | undefined): boolean {
  if (!nodeId) return false;
  const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId);
  return Boolean(node && nodeCanStartManualConnection(node.type));
}

/**
 * Connections: every user edge goes through the `edge.connect` command (validation, undo,
 * Agent parity). Dropping anywhere on a compatible node's card connects; dropping on empty
 * canvas opens the add-node menu pre-wired to the dragged handle.
 */
export function useCanvasConnections(scheduleCanvasPersist: (delayMs?: number) => void) {
  const reactFlow = useReactFlow();
  const startRef = useRef<{ nodeId: string; handleType: 'source' | 'target'; fromClient: FlowPoint } | null>(null);

  const connect = useCallback(async (sourceId: string, targetId: string) => {
    const result = await canvasCommandRegistry.execute({
      type: 'edge.connect',
      version: CANVAS_COMMAND_VERSION,
      input: { sourceNodeId: sourceId, targetNodeId: targetId },
    }, 'ui');
    if (!result.ok) return false;
    appendSourceTextToTextNode(sourceId, targetId);
    scheduleCanvasPersist(0);
    return true;
  }, [scheduleCanvasPersist]);

  const isValidConnection = useCallback((connection: Connection | Edge) => {
    if (!connection.source || !connection.target || !canStartFrom(connection.source)) return false;
    const { nodes, edges } = useCanvasStore.getState();
    return validateCanvasConnection(connection.source, connection.target, nodes, edges).valid;
  }, []);

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target || !canStartFrom(connection.source)) return;
    void connect(connection.source, connection.target);
  }, [connect]);

  const onConnectStart = useCallback((event: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
    clearBrowserTextSelection();
    const ui = useCanvasUiStore.getState();
    ui.closeMenus();
    startRef.current = null;
    if (!params.nodeId || !params.handleType) return;
    if (params.handleType === 'source' && !canStartFrom(params.nodeId)) return;

    const handle = event.target instanceof Element ? event.target.closest('.react-flow__handle') : null;
    const handleRect = handle?.getBoundingClientRect();
    const point = clientPointOf(event);
    const fromClient = handleRect
      ? { x: handleRect.left + handleRect.width / 2, y: handleRect.top + handleRect.height / 2 }
      : point;
    if (!fromClient) return;
    startRef.current = { nodeId: params.nodeId, handleType: params.handleType, fromClient };
    ui.setConnecting({ nodeId: params.nodeId, handleType: params.handleType });
  }, []);

  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    const start = startRef.current;
    startRef.current = null;
    useCanvasUiStore.getState().setConnecting(null);
    clearBrowserTextSelection();
    requestAnimationFrame(() => clearBrowserTextSelection());
    if (state.isValid || !start) return;

    const point = clientPointOf(event);
    if (!point) return;

    // The whole card is a drop target, not only the tiny handle.
    const dropNodeId = getNodeIdFromTarget(event.target)
      ?? getNodeIdFromTarget(document.elementFromPoint(point.x, point.y));
    if (dropNodeId) {
      if (dropNodeId === start.nodeId) return;
      const { nodes } = useCanvasStore.getState();
      const [sourceId, targetId] = start.handleType === 'source'
        ? [start.nodeId, dropNodeId]
        : [dropNodeId, start.nodeId];
      const source = nodes.find((node) => node.id === sourceId);
      const target = nodes.find((node) => node.id === targetId);
      if (
        source && target
        && nodeCanStartManualConnection(source.type)
        && nodeHasSourceHandle(source.type)
        && nodeHasTargetHandle(target.type)
      ) {
        void connect(sourceId, targetId);
      }
      return;
    }

    const allowedTypes = getConnectMenuNodeTypes(start.handleType);
    if (allowedTypes.length === 0) return;
    useCanvasUiStore.getState().openAddMenu({
      clientX: point.x,
      clientY: point.y,
      flowPosition: reactFlow.screenToFlowPosition(point),
      allowedTypes,
      connection: { nodeId: start.nodeId, handleType: start.handleType, fromClient: start.fromClient },
    });
  }, [connect, reactFlow]);

  return { onConnect, onConnectStart, onConnectEnd, isValidConnection };
}
