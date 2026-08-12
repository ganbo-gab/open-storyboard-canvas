import {
  CANVAS_NODE_TYPES,
  type CanvasNodeType,
} from '../domain/canvasNodes';
import type { CanvasEventBus } from './ports';

export const CANVAS_GENERATION_TRIGGER_NODE_TYPES = [
  CANVAS_NODE_TYPES.imageEdit,
  CANVAS_NODE_TYPES.aiVideo,
  CANVAS_NODE_TYPES.aiText,
  CANVAS_NODE_TYPES.aiAudio,
  CANVAS_NODE_TYPES.storyboardGen,
  CANVAS_NODE_TYPES.panorama,
] as const satisfies readonly CanvasNodeType[];

const GENERATION_TRIGGER_NODE_TYPE_SET = new Set<CanvasNodeType>(
  CANVAS_GENERATION_TRIGGER_NODE_TYPES,
);

export function supportsCanvasGenerationTrigger(nodeType: CanvasNodeType): boolean {
  return GENERATION_TRIGGER_NODE_TYPE_SET.has(nodeType);
}

export function subscribeCanvasGenerationTrigger(
  eventBus: CanvasEventBus,
  nodeType: CanvasNodeType,
  nodeId: string,
  trigger: () => void | Promise<void>,
): () => void {
  if (!supportsCanvasGenerationTrigger(nodeType)) {
    throw new Error(`Node type ${nodeType} has no registered generation trigger strategy.`);
  }
  return eventBus.subscribe('generation-node/trigger', ({ nodeId: requestedNodeId }) => {
    if (requestedNodeId === nodeId) {
      void trigger();
    }
  });
}
