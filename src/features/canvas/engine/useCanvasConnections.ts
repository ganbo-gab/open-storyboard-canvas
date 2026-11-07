import { useCallback, useEffect, useRef } from 'react';
import {
  useReactFlow,
  type Connection,
  type Edge,
  type FinalConnectionState,
  type OnConnectStartParams,
} from '@xyflow/react';

import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import { explainConnection as explainNodeConnection, type ConnectionExplanation } from '@/features/canvas/application/canvasConnectionRules';
import { clearBrowserTextSelection } from '@/features/canvas/application/textSelection';
import { CANVAS_COMMAND_VERSION } from '@/features/canvas/domain/canvasCommands';
import {
  getConnectMenuNodeTypes,
  nodeCanStartManualConnection,
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
  const stopHoverRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopHoverRef.current?.(), []);

  /** While dragging, explain why the card under the pointer would refuse the connection. */
  const trackRejectedTarget = useCallback(() => {
    let frame = 0;
    let point: FlowPoint | null = null;
    const evaluate = () => {
      frame = 0;
      const start = startRef.current;
      if (!start || !point) return;
      const hoveredId = getNodeIdFromTarget(document.elementFromPoint(point.x, point.y));
      const ui = useCanvasUiStore.getState();
      if (!hoveredId || hoveredId === start.nodeId) {
        ui.setConnectionReject(null);
        return;
      }
      const { nodes, edges } = useCanvasStore.getState();
      const [sourceId, targetId] = start.handleType === 'source' ? [start.nodeId, hoveredId] : [hoveredId, start.nodeId];
      const explanation = explainNodeConnection(
        nodes.find((node) => node.id === sourceId),
        nodes.find((node) => node.id === targetId),
        { nodes, edges },
      );
      const reason = !explanation.ok
        ? explanation.reason
        : canStartFrom(sourceId) ? null : { type: 'sourceNotConnectable' as const };
      ui.setConnectionReject(reason ? { nodeId: hoveredId, reason } : null);
    };
    const onMove = (event: PointerEvent) => {
      point = { x: event.clientX, y: event.clientY };
      if (!frame) frame = requestAnimationFrame(evaluate);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(frame);
    };
  }, []);

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

  const explainConnection = useCallback((connection: Connection | Edge): ConnectionExplanation => {
    const { nodes, edges } = useCanvasStore.getState();
    const source = nodes.find((node) => node.id === connection.source);
    const target = nodes.find((node) => node.id === connection.target);
    const explanation = explainNodeConnection(source, target, {
      sourceHandle: connection.sourceHandle,
      targetHandle: connection.targetHandle,
      nodes,
      edges,
    });
    if (explanation.ok && !canStartFrom(connection.source)) {
      return { ok: false, reason: { type: 'sourceNotConnectable' } };
    }
    return explanation;
  }, []);

  const isValidConnection = useCallback((connection: Connection | Edge) => (
    explainConnection(connection).ok
  ), [explainConnection]);

  const onConnect = useCallback((connection: Connection) => {
    if (!explainConnection(connection).ok) return;
    void connect(connection.source, connection.target);
  }, [connect, explainConnection]);

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
    stopHoverRef.current?.();
    stopHoverRef.current = trackRejectedTarget();
  }, [trackRejectedTarget]);

  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    const start = startRef.current;
    startRef.current = null;
    stopHoverRef.current?.();
    stopHoverRef.current = null;
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
      const { nodes, edges } = useCanvasStore.getState();
      const [sourceId, targetId] = start.handleType === 'source'
        ? [start.nodeId, dropNodeId]
        : [dropNodeId, start.nodeId];
      const source = nodes.find((node) => node.id === sourceId);
      const target = nodes.find((node) => node.id === targetId);
      if (explainNodeConnection(source, target, { nodes, edges }).ok && canStartFrom(sourceId)) {
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

  return { onConnect, onConnectStart, onConnectEnd, isValidConnection, explainConnection };
}
