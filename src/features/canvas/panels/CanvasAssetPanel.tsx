import { useMemo } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useTranslation } from 'react-i18next';

import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import {
  buildCanvasAssetCatalog,
  type CanvasAssetCatalogItem,
} from '@/features/canvas/application/canvasAssetCatalog';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { CANVAS_COMMAND_VERSION } from '@/features/canvas/domain/canvasCommands';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { nodeHasSourceHandle } from '@/features/canvas/domain/nodeRegistry';
import { useCanvasUiStore } from '@/features/canvas/state/canvasUiStore';
import { AssetPanel, type CanvasAssetItem } from '@/features/canvas/ui/AssetPanel';
import { useCanvasStore } from '@/stores/canvasStore';

const EMPTY_NODES: CanvasNode[] = [];
const IMAGE_SOURCE_TYPES = new Set<string>([CANVAS_NODE_TYPES.upload, CANVAS_NODE_TYPES.imageEdit, CANVAS_NODE_TYPES.exportImage]);

function toAssetPanelItem(asset: CanvasAssetCatalogItem): CanvasAssetItem | null {
  if (asset.kind === 'audio') return null;
  const base = { id: asset.id, nodeId: asset.nodeId, aspectRatio: asset.aspectRatio, title: asset.title, sourceLabel: asset.sourceLabel, order: asset.order };
  if (asset.kind === 'image') {
    return {
      ...base,
      kind: 'image',
      rawImageUrl: asset.url,
      rawPreviewImageUrl: asset.previewUrl,
      imageUrl: resolveImageDisplayUrl(asset.url),
      previewImageUrl: resolveImageDisplayUrl(asset.previewUrl || asset.url),
    };
  }
  return {
    ...base,
    kind: 'video',
    rawVideoUrl: asset.url,
    rawThumbnailUrl: asset.previewUrl,
    videoUrl: resolveImageDisplayUrl(asset.url),
    thumbnailUrl: asset.previewUrl ? resolveImageDisplayUrl(asset.previewUrl) : null,
  };
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
          imageUrl: asset.rawImageUrl,
          previewImageUrl: asset.rawPreviewImageUrl ?? asset.rawImageUrl,
          aspectRatio: asset.aspectRatio ?? '1:1',
          resultKind: 'generic',
        });
    void canvasCommandRegistry.execute({
      type: 'edge.connect',
      version: CANVAS_COMMAND_VERSION,
      input: { sourceNodeId, targetNodeId },
    }, 'ui').then(() => scheduleCanvasPersist(0));
  };

  const locateAsset = (asset: CanvasAssetItem) => {
    const node = useCanvasStore.getState().nodes.find((item) => item.id === asset.nodeId);
    if (!node) return;
    useCanvasStore.getState().setSelectedNode(node.id);
    void reactFlow.fitView({ nodes: [{ id: node.id }], padding: 0.4, duration: 400, maxZoom: Math.max(reactFlow.getZoom(), 0.85) });
  };

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
    />
  );
}
