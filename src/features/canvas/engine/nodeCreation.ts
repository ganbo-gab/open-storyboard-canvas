import { resolveCollisionFreeNodePosition } from '@/features/canvas/application/canvasCommandGraph';
import type { CanvasPlacementViewport } from '@/features/canvas/application/canvasNodePlacement';
import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import { getGeneratedTextForConnection } from '@/features/canvas/application/nodeText';
import {
  CANVAS_COMMAND_VERSION,
  type CanvasCommand,
  type CanvasNodeCreateConfiguration,
} from '@/features/canvas/domain/canvasCommands';
import { CANVAS_NODE_TYPES, type CanvasNodeType } from '@/features/canvas/domain/canvasNodes';
import type { FlowPoint, PendingConnection } from '@/features/canvas/state/canvasUiStore';
import { useCanvasStore } from '@/stores/canvasStore';

function createNodeId(type: CanvasNodeType): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  return `${type}-${random}`;
}

/**
 * The one path for user-created nodes (menus, rail, palette, connection drops): a single
 * command transaction creates the node and, when it came from a connection drag, the edge —
 * so it is one undo step and passes the same validation the Agent uses. The node is selected.
 */
export function createCanvasNode(input: {
  type: CanvasNodeType;
  position: FlowPoint;
  configuration?: CanvasNodeCreateConfiguration;
  connection?: PendingConnection;
  /** Without it the node lands exactly at `position` (pointer drops); with it (rail, starters,
   * palette) it shifts to the nearest empty slot that stays inside this visible area. */
  freePlacement?: { viewport: CanvasPlacementViewport | null };
}): string | null {
  const nodeId = createNodeId(input.type);
  let configuration = input.configuration;
  if (input.connection?.handleType === 'source' && input.type === CANVAS_NODE_TYPES.textAnnotation) {
    // A text node pulled out of a text source starts with that text (same undo step).
    const { nodes } = useCanvasStore.getState();
    const source = nodes.find((node) => node.id === input.connection?.nodeId);
    const content = source ? getGeneratedTextForConnection(source, nodes) : '';
    if (content) configuration = { ...configuration, content };
  }
  const create: Extract<CanvasCommand, { type: 'node.create' }> = {
    type: 'node.create',
    version: CANVAS_COMMAND_VERSION,
    input: {
      nodeType: input.type,
      nodeId,
      position: input.position,
      configuration,
    },
  };
  if (input.freePlacement) {
    create.input.position = resolveCollisionFreeNodePosition(
      create,
      useCanvasStore.getState().nodes,
      input.freePlacement.viewport,
    );
  }
  const commands: CanvasCommand[] = [create];
  if (input.connection) {
    commands.push({
      type: 'edge.connect',
      version: CANVAS_COMMAND_VERSION,
      input: input.connection.handleType === 'source'
        ? { sourceNodeId: input.connection.nodeId, targetNodeId: nodeId }
        : { sourceNodeId: nodeId, targetNodeId: input.connection.nodeId },
    });
  }
  const result = canvasCommandRegistry.executeTransaction({
    id: `ui-create-${nodeId}`,
    origin: 'ui',
    expectedRevision: canvasCommandRegistry.getRevision(),
    commands,
  });
  if (!result.ok) {
    console.warn('[canvas] node creation rejected', result);
    return null;
  }
  useCanvasStore.getState().setSelectedNode(nodeId);
  return nodeId;
}

/** A text node wired downstream of a text source receives that text. */
export function appendSourceTextToTextNode(sourceId: string, targetId: string): void {
  const { nodes, updateNodeData } = useCanvasStore.getState();
  const source = nodes.find((node) => node.id === sourceId);
  const target = nodes.find((node) => node.id === targetId);
  if (!source || target?.type !== CANVAS_NODE_TYPES.textAnnotation) return;
  const text = getGeneratedTextForConnection(source, nodes);
  if (!text) return;
  const current = 'content' in target.data ? target.data.content : undefined;
  const existing = typeof current === 'string' ? current.trim() : '';
  updateNodeData(targetId, { content: existing ? `${existing}\n${text}` : text });
}
