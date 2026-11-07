import { resolveAsset } from '@/features/assets/application/assetCatalog';
import { canvasNodeFactory } from '@/features/canvas/application/canvasServices';
import { validateCanvasConnection } from '@/features/canvas/application/canvasConnectionRules';
import { CANVAS_NODE_TYPES, type CanvasEdge } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

/** One capture group is one canvas transaction, including provenance edges. */
export async function publishStageCaptures(stageId: string, assetIds: readonly string[]): Promise<string[]> {
  if (!assetIds.length || assetIds.length > 4) throw new Error('A capture group must contain 1–4 images.');
  const assets = await Promise.all(assetIds.map(resolveAsset));
  if (assets.some((asset) => asset?.kind !== 'image')) throw new Error('Capture asset is unavailable.');
  const state = useCanvasStore.getState();
  const stage = state.nodes.find((node) => node.id === stageId);
  if (!stage) throw new Error('Stage is no longer available.');
  const nodes = assets.map((asset, index) => canvasNodeFactory.createNode(CANVAS_NODE_TYPES.exportImage,
    { x: stage.position.x + 440 + index % 2 * 340, y: stage.position.y + Math.floor(index / 2) * 260 },
    { imageUrl: asset!.source, previewImageUrl: asset!.source, assetId: asset!.id, displayName: asset!.name, assetOrigin: 'generated' }));
  const allNodes = [...state.nodes, ...nodes]; const edges: CanvasEdge[] = [...state.edges];
  for (const node of nodes) {
    const check = validateCanvasConnection(stageId, node.id, allNodes, edges, { provenance: 'generationResult' });
    if (!check.valid) throw new Error('Capture connection is not allowed.');
    edges.push({ id: `e-${stageId}-${node.id}`, source: stageId, target: node.id, sourceHandle: 'source', targetHandle: 'target', type: 'disconnectableEdge' });
  }
  if (state.commitGraphTransaction({ expectedRevision: state.revision, nodes: allNodes, edges, selectedNodeId: nodes[0].id }) === null) throw new Error('Canvas changed; retry adding these captures.');
  return nodes.map((node) => node.id);
}
