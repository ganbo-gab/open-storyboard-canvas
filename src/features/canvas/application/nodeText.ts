import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';

export function getGeneratedTextForConnection(sourceNode: CanvasNode, nodes: CanvasNode[]): string {
  if (sourceNode.type === CANVAS_NODE_TYPES.textAnnotation) {
    const content = (sourceNode.data as { content?: unknown }).content;
    return typeof content === 'string' ? content.trim() : '';
  }

  if (sourceNode.type === CANVAS_NODE_TYPES.jsonCard) {
    const data = sourceNode.data as { parsedJson?: unknown; rawContent?: unknown };
    if (data.parsedJson !== null && data.parsedJson !== undefined) {
      try {
        return JSON.stringify(data.parsedJson, null, 2);
      } catch {
        return String(data.parsedJson);
      }
    }
    return typeof data.rawContent === 'string' ? data.rawContent.trim() : '';
  }

  if (sourceNode.type === CANVAS_NODE_TYPES.aiText) {
    const resultNodeId = (sourceNode.data as { resultNodeId?: unknown }).resultNodeId;
    const resultNode = typeof resultNodeId === 'string'
      ? nodes.find((node) => node.id === resultNodeId)
      : null;
    const resultContent = resultNode?.type === CANVAS_NODE_TYPES.textAnnotation
      ? (resultNode.data as { content?: unknown }).content
      : null;
    if (typeof resultContent === 'string' && resultContent.trim()) {
      return resultContent.trim();
    }
    const fallbackResult = nodes.find((node) => (
      node.type === CANVAS_NODE_TYPES.textAnnotation
      && (node.data as { sourceAiNodeId?: unknown }).sourceAiNodeId === sourceNode.id
    ));
    const fallbackContent = fallbackResult
      ? (fallbackResult.data as { content?: unknown }).content
      : null;
    return typeof fallbackContent === 'string' ? fallbackContent.trim() : '';
  }

  return '';
}
