import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { collectInputReferences } from '@/features/canvas/application/graphReferenceResolver';
import { prepareNodeImageFromFile } from '@/features/canvas/application/imageData';
import { useCanvasStore } from '@/stores/canvasStore';

/** Pasted reference images land this far left of the generator. */
const PASTED_REFERENCE_OFFSET_X = 300;

/** A pasted image becomes an upload node wired into the generator; resolves to its `@` token. */
export async function pasteImageAsReference(nodeId: string, file: File): Promise<string | null> {
  const prepared = await prepareNodeImageFromFile(file);
  const { addNode, addEdge, nodes } = useCanvasStore.getState();
  const position = nodes.find((node) => node.id === nodeId)?.position ?? { x: 0, y: 0 };
  const uploadId = addNode(
    CANVAS_NODE_TYPES.upload,
    { x: position.x - PASTED_REFERENCE_OFFSET_X, y: position.y },
    { imageUrl: prepared.imageUrl, previewImageUrl: prepared.previewImageUrl, aspectRatio: prepared.aspectRatio || '1:1', sourceFileName: file.name },
  );
  addEdge(uploadId, nodeId);
  const state = useCanvasStore.getState();
  return collectInputReferences(nodeId, state.nodes, state.edges).find((reference) => reference.sourceNodeId === uploadId)?.token ?? null;
}
