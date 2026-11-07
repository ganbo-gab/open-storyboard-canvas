import { useMemo } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useTranslation } from 'react-i18next';

import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import {
  buildCanvasAssetCatalog,
  type CanvasAssetCatalogItem,
} from '@/features/canvas/application/canvasAssetCatalog';
import { selectCanvasContentNodes } from '@/features/canvas/application/canvasContentSelector';
import { buildCanvasNodeTree } from '@/features/canvas/application/canvasNodeTree';
import { CANVAS_COMMAND_VERSION } from '@/features/canvas/domain/canvasCommands';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { nodeHasSourceHandle } from '@/features/canvas/domain/nodeRegistry';
import { useCanvasUiStore } from '@/features/canvas/state/canvasUiStore';
import { AssetPanel, type CanvasAssetItem } from '@/features/canvas/ui/AssetPanel';
import { useCanvasStore } from '@/stores/canvasStore';

const EMPTY_NODES: CanvasNode[] = [];
const IMAGE_SOURCE_TYPES = new Set<string>([CANVAS_NODE_TYPES.upload, CANVAS_NODE_TYPES.imageEdit, CANVAS_NODE_TYPES.exportImage]);

function toAssetPanelItem(asset: CanvasAssetCatalogItem): CanvasAssetItem | null {
  if (asset.kind === 'audio') return { id: asset.id, nodeId: asset.nodeId, title: asset.title, sourceLabel: asset.sourceLabel, order: asset.order, kind: 'audio', audioUrl: asset.url };
  const base = { id: asset.id, nodeId: asset.nodeId, aspectRatio: asset.aspectRatio, title: asset.title, sourceLabel: asset.sourceLabel, order: asset.order };
  if (asset.kind === 'image') {
    return { ...base, kind: 'image', imageUrl: asset.url, previewImageUrl: asset.previewUrl };
  }
  return { ...base, kind: 'video', videoUrl: asset.url };
}

/**
 * Media already on this canvas. Browse: click to fly to the node, rename in place.
 * Select (from a connection dropped off an AI image node's input): pick an image to wire in.
 */
export function CanvasAssetPanel({ scheduleCanvasPersist }: { scheduleCanvasPersist: (delayMs?: number) => void }) {
  const { t } = useTranslation();
  const reactFlow = useReactFlow();
  const panel = useCanvasUiStore((state) => state.assetPanel);
  const setAssetPanel = useCanvasUiStore((state) => state.setAssetPanel);
  // Subscribe to the graph only while open: the catalog walks every node.
  const nodes = useCanvasStore((state) => (panel ? state.nodes : EMPTY_NODES));

  const assets = useMemo(() => {
    if (!panel) return [];
    const items = buildCanvasAssetCatalog(nodes)
      .map(toAssetPanelItem)
      .filter((asset): asset is CanvasAssetItem => asset !== null);
    return panel.mode === 'select'
      ? items.filter((asset) => asset.kind === 'image' && asset.nodeId !== panel.targetNodeId)
      : items;
  }, [nodes, panel]);
  // Content nodes only (no geometry-only invalidation): the drawer tree changes with the graph's content.
  const tree = useMemo(() => (panel?.mode === 'browse' ? buildCanvasNodeTree(selectCanvasContentNodes(nodes)) : undefined), [nodes, panel?.mode]);

  const anchorRect = useMemo(
    () => (panel ? new DOMRect(panel.anchor.x, panel.anchor.y, panel.anchor.width, panel.anchor.height) : null),
    [panel]
  );

  const close = () => setAssetPanel(null);

  const connectAsset = (asset: CanvasAssetItem, targetNodeId: string) => {
    const { nodes: current, addNode } = useCanvasStore.getState();
    const target = current.find((node) => node.id === targetNodeId);
    if (!target || asset.kind !== 'image') return;
    const source = current.find((node) => node.id === asset.nodeId);
    // Reuse the node that owns the image when it can feed an edge; otherwise materialise a copy beside the target.
    const sourceNodeId = source && asset.id === `${source.id}:image` && IMAGE_SOURCE_TYPES.has(source.type) && nodeHasSourceHandle(source.type)
      ? source.id
      : addNode(CANVAS_NODE_TYPES.exportImage, { x: target.position.x - 300, y: target.position.y }, {
          displayName: asset.title,
          imageUrl: asset.imageUrl,
          previewImageUrl: asset.previewImageUrl ?? asset.imageUrl,
          aspectRatio: asset.aspectRatio ?? '1:1',
          resultKind: 'generic',
        });
    void canvasCommandRegistry.execute({
      type: 'edge.connect',
      version: CANVAS_COMMAND_VERSION,
      input: { sourceNodeId, targetNodeId },
    }, 'ui').then(() => scheduleCanvasPersist(0));
  };

  const locateNode = (nodeId: string) => {
    const store = useCanvasStore.getState();
    const node = store.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    // A collapsed stack member is hidden: make it the stack's face first (one undo step), then focus it.
    if (node.hidden && typeof node.data.batchId === 'string') store.setBatchPrimary(node.data.batchId, node.id);
    store.setSelectedNode(node.id);
    void reactFlow.fitView({ nodes: [{ id: node.id }], padding: 0.4, duration: 400, maxZoom: Math.max(reactFlow.getZoom(), 0.85) });
  };

  const locateAsset = (asset: CanvasAssetItem) => locateNode(asset.nodeId);

  return (
    <AssetPanel
      isOpen={Boolean(panel)}
      assets={assets}
      buttonRect={anchorRect}
      mode={panel?.mode ?? 'browse'}
      title={panel?.mode === 'select' ? t('rework.canvas.assets.selectTitle') : undefined}
      subtitle={panel?.mode === 'select' ? t('rework.canvas.assets.selectHint') : undefined}
      onClose={close}
      onActivate={(asset) => {
        if (panel?.mode === 'select' && panel.targetNodeId) {
          connectAsset(asset, panel.targetNodeId);
        } else {
          locateAsset(asset);
        }
        close();
      }}
      onRename={panel?.mode === 'browse'
        ? (asset, title) => {
            const node = useCanvasStore.getState().nodes.find((item) => item.id === asset.nodeId);
            useCanvasStore.getState().updateNodeData(asset.nodeId, {
              displayName: title,
              ...(node?.type === CANVAS_NODE_TYPES.exportImage || node?.type === CANVAS_NODE_TYPES.video
                ? { generatedNamingMode: 'custom' as const }
                : {}),
            });
          }
        : undefined}
      tree={tree}
      onLocateNode={locateNode}
      onRenameNode={(nodeId, displayName) => { void canvasCommandRegistry.execute({ type: 'node.rename', version: CANVAS_COMMAND_VERSION, input: { nodeId, displayName } }, 'ui'); }}
    />
  );
}
