import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { buildCanvasAssetCatalog } from '@/features/canvas/application/canvasAssetCatalog';
import { canvasNodeFactory } from '@/features/canvas/application/canvasServices';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { normalizeAssetMetadata } from './assetMetadata';
import type { AssetRecord } from './assetCatalog';
import { saveDerivedAsset, type AssetEditDetails, type AssetEditOutput } from './assetEditing';
import { getAssetPortableSource } from './assetMediaStorage';

export interface CanvasAssetEditTarget { projectId: string; nodeId: string; source: string; asset: AssetRecord }
export function captureCanvasAssetEditTarget(nodeId: string): CanvasAssetEditTarget {
  const project = useProjectStore.getState();
  const node = useCanvasStore.getState().nodes.find((entry) => entry.id === nodeId);
  const item = node ? buildCanvasAssetCatalog([node]).find((entry) => entry.kind === 'image') : undefined;
  if (!project.currentProjectId || !node || !item) throw new Error('图片节点或项目不存在，请重新选择图片。');
  const metadata = normalizeAssetMetadata(node.data);
  const origin = metadata.assetOrigin === 'generated' || metadata.assetOrigin === 'uploaded' || metadata.assetOrigin === 'canvas' ? metadata.assetOrigin
    : metadata.sourcePrompt || metadata.generationJobId ? 'generated' : node.type === CANVAS_NODE_TYPES.upload ? 'uploaded' : 'canvas';
  return { projectId: project.currentProjectId, nodeId, source: item.url, asset: {
    id: `project:${project.currentProjectId}:${item.id}`, kind: 'image', source: item.url, name: item.title,
    origin, createdAt: Date.now(), favorite: false, projectId: project.currentProjectId, nodeId, metadata,
  } };
}
function assertSource(target: CanvasAssetEditTarget): void {
  if (useProjectStore.getState().currentProjectId !== target.projectId) throw new Error('项目已切换，请回到原图片后重新编辑。');
  const node = useCanvasStore.getState().nodes.find((entry) => entry.id === target.nodeId);
  if (!node || !buildCanvasAssetCatalog([node]).some((item) => item.kind === 'image' && item.url === target.source)) throw new Error('原图片已变更，请重新打开编辑。');
}
/** One graph transaction adds the durable derivative and provenance edge; original node stays intact. */
export async function saveCanvasAssetEdit(target: CanvasAssetEditTarget, output: AssetEditOutput, details: AssetEditDetails, id: string): Promise<AssetRecord> {
  assertSource(target);
  const asset = await saveDerivedAsset(target.asset, output, details, { id, validateSource: () => assertSource(target) });
  const canvasSource = await getAssetPortableSource(asset.source);
  // The asset is durable even if a user navigated during saving. Do not publish a node into another project.
  try { assertSource(target); } catch { return asset; }
  const state = useCanvasStore.getState();
  const position = state.findNodePositions(target.nodeId, 1, 384, 288)[0];
  const node = { ...canvasNodeFactory.createNode(CANVAS_NODE_TYPES.exportImage, position, {
    imageUrl: canvasSource, previewImageUrl: null, displayName: asset.name, aspectRatio: output.width && output.height ? `${output.width}:${output.height}` : 'auto',
    assetId: asset.id, assetMetadata: asset.metadata, sourcePrompt: details.prompt,
  }), selected: true };
  const edge = { id: crypto.randomUUID(), source: target.nodeId, target: node.id, sourceHandle: 'source', targetHandle: 'target', type: 'disconnectableEdge' };
  const committed = state.commitGraphTransaction({ expectedRevision: state.revision,
    nodes: [...state.nodes.map((entry) => entry.selected ? { ...entry, selected: false } : entry), node], edges: [...state.edges, edge], selectedNodeId: node.id });
  if (committed !== null) {
    const next = useCanvasStore.getState();
    useProjectStore.getState().saveCurrentProject(next.nodes, next.edges, next.currentViewport, next.history);
  }
  return asset;
}
