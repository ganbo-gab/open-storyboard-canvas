import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import type { NodeProps } from '@xyflow/react';
import { Handle, Position } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { Camera, Maximize2 } from 'lucide-react';

import {
  AUTO_REQUEST_ASPECT_RATIO,
  CANVAS_NODE_TYPES,
  isBlueprintNode,
  isExportImageNode,
  isImageEditNode,
  isUploadNode,
  type BlueprintItem,
  type CanvasNode,
  type BlueprintNodeData,
  type DirectorStudioProjectRecord,
} from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import {
  parseCanvasImageAssetSignature,
  parseInputImageSignature,
  selectCanvasImageAssetSignature,
  selectCanvasPanoramaAssetSignature,
  selectInputImageSignature,
} from '@/features/canvas/application/canvasGraphSelectors';
import {
  buildBlueprintPrompt,
  type BlueprintReferenceImage,
} from '@/features/canvas/application/blueprintPrompt';
import { resolvePromptTemplateText } from '@/features/canvas/application/promptTemplates';
import { showErrorDialog } from '@/features/canvas/application/errorDialog';
import { DirectorStudioShell } from '@/features/canvas/ui/DirectorStudioShell';
import { BLUEPRINT_DEFAULT_COLORS as LEGEND_COLORS } from '@/features/canvas/ui/blueprintCoordinates';
import { useSettingsStore } from '@/stores/settingsStore';
import { persistImageSource } from '@/commands/image';

type BlueprintNodeProps = NodeProps & { data: BlueprintNodeData };

const BLUEPRINT_NODE_WIDTH = 440;

const DIRECTOR_STUDIO_AI_REQUEST_RATIOS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '21:9']);

function isDataImageUrl(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^data:image\//i.test(value);
}

async function persistDirectorStudioSnapshotSource(source: string): Promise<string> {
  return isDataImageUrl(source) ? persistImageSource(source) : source;
}

function normalizeDirectorStudioProjectRecord(
  project: DirectorStudioProjectRecord | null | undefined
): DirectorStudioProjectRecord | null {
  if (!project || typeof project !== 'object' || typeof project.id !== 'string' || !project.id.trim()) {
    return null;
  }
  const updatedAt = Number.isFinite(project.updatedAt)
    ? project.updatedAt
    : Number.isFinite(project.createdAt)
      ? project.createdAt
      : 0;
  const createdAt = Number.isFinite(project.createdAt) ? project.createdAt : updatedAt;
  return {
    ...project,
    id: project.id,
    name: typeof project.name === 'string' && project.name.trim() ? project.name : project.id,
    createdAt,
    updatedAt,
  };
}

function mergeDirectorStudioProjectLibraries(nodes: CanvasNode[]): DirectorStudioProjectRecord[] {
  const byId = new Map<string, DirectorStudioProjectRecord>();
  nodes.forEach((node) => {
    if (!isBlueprintNode(node) || !Array.isArray(node.data.directorStudioProjects)) return;
    node.data.directorStudioProjects.forEach((rawProject) => {
      const project = normalizeDirectorStudioProjectRecord(rawProject);
      if (!project) return;
      const existing = byId.get(project.id);
      if (!existing || project.updatedAt >= existing.updatedAt) {
        byId.set(project.id, project);
      }
    });
  });
  return Array.from(byId.values()).sort((a, b) => b.updatedAt - a.updatedAt);
}

function resolveDirectorStudioCanvasAspectRatio(data: BlueprintNodeData): string {
  if (data.aspectFrame && data.aspectFrame !== 'panorama') {
    return data.aspectFrame;
  }
  const aspectRatio = data.aspectRatio?.trim();
  return aspectRatio && aspectRatio !== 'panorama' ? aspectRatio : '16:9';
}

function resolveDirectorStudioRequestAspectRatio(data: BlueprintNodeData): string {
  const aspectRatio = resolveDirectorStudioCanvasAspectRatio(data);
  return DIRECTOR_STUDIO_AI_REQUEST_RATIOS.has(aspectRatio) ? aspectRatio : AUTO_REQUEST_ASPECT_RATIO;
}

/**
 * Canvas anchor for Director Studio. The full 3D workspace lives in
 * DirectorStudioShell; this node only keeps graph connections, project data,
 * the latest screenshot thumbnail, and the screenshot-to-AI-canvas handoff.
 */
export const BlueprintNode = memo(({ id, data, selected }: BlueprintNodeProps) => {
  const { t } = useTranslation();
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const updateDirectorStudioProjectLibrary = useCanvasStore((s) => s.updateDirectorStudioProjectLibrary);
  const addNode = useCanvasStore((s) => s.addNode);
  const addEdge = useCanvasStore((s) => s.addEdge);
  const findNodePosition = useCanvasStore((s) => s.findNodePosition);
  const setSelectedNode = useCanvasStore((s) => s.setSelectedNode);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [directorStudioOpen, setDirectorStudioOpen] = useState(false);
  const [openedDirectorStudioProjects, setOpenedDirectorStudioProjects] = useState<DirectorStudioProjectRecord[] | null>(null);
  const upstreamReferenceImageSignature = useCanvasStore((s) =>
    selectInputImageSignature(id, s.nodes, s.edges)
  );
  const directorStudioAssetSignature = useCanvasStore((s) =>
    directorStudioOpen ? selectCanvasImageAssetSignature(s.nodes) : '[]'
  );
  const directorStudioPanoramaAssetSignature = useCanvasStore((s) =>
    directorStudioOpen ? selectCanvasPanoramaAssetSignature(s.nodes, s.edges) : '[]'
  );
  const directorStudioData = useMemo<BlueprintNodeData>(
    () => openedDirectorStudioProjects
      ? {
          ...data,
          directorStudioProjects: openedDirectorStudioProjects,
        }
      : data,
    [data, openedDirectorStudioProjects],
  );

  const syncDirectorStudioProjectLibrary = useCallback((sourcePatch: Partial<BlueprintNodeData> = {}) => {
    const mergedProjects = mergeDirectorStudioProjectLibraries(useCanvasStore.getState().nodes);
    setOpenedDirectorStudioProjects(mergedProjects);
    updateDirectorStudioProjectLibrary(mergedProjects, id, sourcePatch);
    return mergedProjects;
  }, [id, updateDirectorStudioProjectLibrary]);

  const openDirectorStudio = useCallback((sourcePatch?: Partial<BlueprintNodeData>) => {
    syncDirectorStudioProjectLibrary(sourcePatch);
    setDirectorStudioOpen(true);
  }, [syncDirectorStudioProjectLibrary]);

  const closeDirectorStudio = useCallback(() => {
    setDirectorStudioOpen(false);
    setOpenedDirectorStudioProjects(null);
  }, []);

  useEffect(() => {
    if (data.openDirectorStudioOnCreate !== true) return;
    openDirectorStudio({ openDirectorStudioOnCreate: false });
  }, [data.openDirectorStudioOnCreate, openDirectorStudio]);

  const upstreamReferenceImages = useMemo<BlueprintReferenceImage[]>(() => {
    const urls = parseInputImageSignature(upstreamReferenceImageSignature);
    return urls.map((url, idx) => ({
      id: `upstream-${idx}`,
      url,
      label: t('directorStudio.legacyPanel.referenceTokenName', { index: idx + 1 }),
      color: LEGEND_COLORS[idx % LEGEND_COLORS.length],
    }));
  }, [upstreamReferenceImageSignature, t]);

  const mergedReferenceImages = useMemo<BlueprintReferenceImage[]>(() => {
    const legacy: BlueprintReferenceImage[] = (data.referenceImages ?? []).map((r, idx) => ({
      ...r,
      color: r.color ?? LEGEND_COLORS[(upstreamReferenceImages.length + idx) % LEGEND_COLORS.length],
    }));
    const merged = [...upstreamReferenceImages, ...legacy];
    const urls = new Set(merged.map((image) => image.url));
    data.items.forEach((item) => {
      if (!item.refImageUrl || urls.has(item.refImageUrl)) return;
      urls.add(item.refImageUrl);
      merged.push({
        id: `item-ref-${item.id}`,
        url: item.refImageUrl,
        label: item.refImageName || item.label,
        color: item.color,
      });
    });
    return merged;
  }, [data.items, data.referenceImages, upstreamReferenceImages]);

  const directorStudioImageAssets = useMemo<BlueprintReferenceImage[]>(() => {
    if (!directorStudioOpen) {
      return [];
    }
    return parseCanvasImageAssetSignature(directorStudioAssetSignature).map((asset, index) => ({
      id: asset.id,
      url: asset.url,
      label: asset.label || t('directorStudio.legacyPanel.referenceTokenName', { index: index + 1 }),
      color: LEGEND_COLORS[index % LEGEND_COLORS.length],
    }));
  }, [directorStudioAssetSignature, directorStudioOpen, t]);

  const directorStudioPanoramaAssets = useMemo<BlueprintReferenceImage[]>(() => {
    if (!directorStudioOpen) {
      return [];
    }
    return parseCanvasImageAssetSignature(directorStudioPanoramaAssetSignature).map((asset, index) => ({
      id: asset.id,
      url: asset.url,
      label: asset.label || t('directorStudio.panoramaAssetFallbackName', { count: index + 1 }),
      color: LEGEND_COLORS[index % LEGEND_COLORS.length],
    }));
  }, [directorStudioOpen, directorStudioPanoramaAssetSignature, t]);

  const handleItemsChange = useCallback((items: BlueprintItem[]) => {
    updateNodeData(id, { items });
    if (selectedItemId && !items.some((item) => item.id === selectedItemId)) {
      setSelectedItemId(null);
    }
  }, [id, selectedItemId, updateNodeData]);

  const updateBlueprintNodeData = useCallback((patch: Partial<BlueprintNodeData>) => {
    if ('directorStudioProjects' in patch && Array.isArray(patch.directorStudioProjects)) {
      setOpenedDirectorStudioProjects(patch.directorStudioProjects);
      updateDirectorStudioProjectLibrary(patch.directorStudioProjects, id, patch);
      return;
    }
    updateNodeData(id, patch);
  }, [id, updateDirectorStudioProjectLibrary, updateNodeData]);

  const handleAddSnapshotToCanvas = useCallback(async (requestedSnapshotUrl?: string | null) => {
    const rawSnapshotUrl = requestedSnapshotUrl ?? data.snapshotUrl ?? null;
    if (!rawSnapshotUrl) {
      await showErrorDialog(t('directorStudio.addToCanvasNoSnapshot'), t('common.error'));
      return false;
    }
    let snapshotUrl = rawSnapshotUrl;
    try {
      snapshotUrl = await persistDirectorStudioSnapshotSource(rawSnapshotUrl);
    } catch (error) {
      await showErrorDialog(
        error instanceof Error ? error.message : t('directorStudio.addToCanvasFailed'),
        t('common.error'),
      );
      return false;
    }
    const linkedReferences: BlueprintReferenceImage[] = [];
    const seenReferenceUrls = new Set([snapshotUrl]);
    mergedReferenceImages.forEach((image) => {
      if (!image.url || seenReferenceUrls.has(image.url)) return;
      seenReferenceUrls.add(image.url);
      const linkedItem = data.items.find((item) =>
        item.refImageUrl === image.url ||
        item.refImageName === image.label ||
        item.label === image.label
      );
      linkedReferences.push({
        ...image,
        label: linkedItem?.refImageName || linkedItem?.label || image.label,
      });
    });

    const promptSettings = useSettingsStore.getState();
    const basePrompt = buildBlueprintPrompt({
      mode: data.mode,
      backgroundImageUrl: data.backgroundImageUrl ?? data.backgroundPanoramaUrl ?? null,
      items: data.items,
      referenceImages: linkedReferences,
      basePrompt: data.basePrompt ?? '',
      referenceTokenStartIndex: 2,
      referenceTokenPrefix: '图',
      settings: promptSettings,
    }).trim();
    const screenshotHandoffPrompt = resolvePromptTemplateText(
      'directorStudio.screenshotHandoff',
      promptSettings
    ).trim();
    const prompt = [
      basePrompt,
      screenshotHandoffPrompt,
    ].filter(Boolean).join('\n\n');

    const aspectRatio = resolveDirectorStudioCanvasAspectRatio(data);
    const requestAspectRatio = resolveDirectorStudioRequestAspectRatio(data);
    const screenshotPosition = findNodePosition(id, 384, 288);
    const screenshotNodeId = addNode(CANVAS_NODE_TYPES.exportImage, screenshotPosition, {
      imageUrl: snapshotUrl,
      previewImageUrl: null,
      aspectRatio,
      resultKind: 'generic',
      displayName: t('directorStudio.snapshotSourceName'),
    });
    const aiNodePosition = findNodePosition(screenshotNodeId, 460, 520);
    const aiNodeId = addNode(CANVAS_NODE_TYPES.imageEdit, aiNodePosition, {
      prompt,
      aspectRatio,
      requestAspectRatio,
      displayName: t('directorStudio.generationNodeName'),
    });
    addEdge(screenshotNodeId, aiNodeId);

    const findDirectSourceNodeId = (image: BlueprintReferenceImage): string | null => {
      const node = useCanvasStore.getState().nodes.find((candidate) => candidate.id === image.id);
      if (!node || (!isUploadNode(node) && !isImageEditNode(node) && !isExportImageNode(node))) {
        return null;
      }
      const rawUrl = node.data.imageUrl ?? node.data.previewImageUrl ?? null;
      if (!rawUrl) return null;
      const displayUrl = resolveImageDisplayUrl(rawUrl) ?? rawUrl;
      return rawUrl === image.url || displayUrl === image.url ? node.id : null;
    };

    linkedReferences.forEach((image, index) => {
      const displayLabel = image.label?.trim() || t('directorStudio.assetFallbackName', { count: index + 1 });
      const sourceNodeId = findDirectSourceNodeId(image) ?? addNode(CANVAS_NODE_TYPES.exportImage, {
        x: screenshotPosition.x,
        y: screenshotPosition.y + (index + 1) * 224,
      }, {
        imageUrl: image.url,
        previewImageUrl: null,
        aspectRatio: '1:1',
        resultKind: 'generic',
        displayName: t('directorStudio.referenceSourceName', { label: displayLabel }),
      });
      addEdge(sourceNodeId, aiNodeId);
    });

    if (snapshotUrl !== data.snapshotUrl) {
      updateNodeData(id, { snapshotUrl });
    }
    setSelectedNode(aiNodeId);
    setDirectorStudioOpen(false);
    return true;
  }, [
    addEdge,
    addNode,
    data,
    findNodePosition,
    id,
    mergedReferenceImages,
    setSelectedNode,
    t,
    updateNodeData,
  ]);

  const compactSnapshotUrl = data.snapshotUrl
    ? resolveImageDisplayUrl(data.snapshotUrl) ?? data.snapshotUrl
    : null;
  const compactEnvironmentLabel = data.mode === 'panorama'
    ? t('directorStudio.nodeCard.panoramaEnvironment')
    : t('directorStudio.nodeCard.flatEnvironment');

  return (
    <div
      className={`overflow-hidden rounded-xl border bg-[var(--canvas-node-bg)] shadow-[var(--canvas-node-shadow)] ${selected ? 'border-accent' : 'border-[var(--canvas-node-border)]'}`}
      style={{ width: BLUEPRINT_NODE_WIDTH }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <Handle type="target" id="target" position={Position.Left} className="!bg-accent/70" />
      <Handle type="source" id="source" position={Position.Right} className="!bg-accent/70" />

      <div className="flex items-center justify-between gap-3 border-b border-[var(--canvas-node-divider)] px-3 py-2 text-xs text-text-muted">
        <div className="min-w-0">
          <div className="truncate font-medium text-text-dark">{t('directorStudio.title')}</div>
          <div className="mt-0.5 truncate text-[10px] text-text-muted">
            {t('directorStudio.nodeCard.summary', {
              environment: compactEnvironmentLabel,
              count: data.items.length,
              refs: mergedReferenceImages.length,
            })}
          </div>
        </div>
      </div>

      <div className="nodrag nopan flex flex-col gap-3 bg-[var(--canvas-node-subtle-bg)] p-3" onPointerDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); openDirectorStudio(); }}
          className="group relative overflow-hidden rounded-lg border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-field-bg)] text-left transition-colors hover:border-[var(--canvas-node-border-hover)] hover:bg-[var(--canvas-node-menu-hover)]"
          title={t('directorStudio.openFullscreen')}
        >
          <div className="aspect-[16/9] bg-[var(--canvas-node-media-bg)]">
            {compactSnapshotUrl ? (
              <img
                src={compactSnapshotUrl}
                alt={t('directorStudio.nodeCard.snapshotAlt')}
                className="h-full w-full object-cover"
                draggable={false}
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-text-muted/70">
                <Maximize2 className="h-7 w-7" />
                <span className="text-xs">{t('directorStudio.nodeCard.emptyPreview')}</span>
              </div>
            )}
          </div>
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-[var(--canvas-node-media-overlay)] px-3 py-2">
            <span className="min-w-0 truncate text-xs font-medium text-white/90">{t('directorStudio.openFullscreen')}</span>
            <Maximize2 className="h-4 w-4 shrink-0 text-white/75 transition-transform group-hover:scale-110" />
          </div>
        </button>

        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-md border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-bg-strong)] px-2 py-2">
            <div className="text-sm font-semibold text-text-dark">{data.items.length}</div>
            <div className="mt-0.5 text-[10px] text-text-muted">{t('directorStudio.elements')}</div>
          </div>
          <div className="rounded-md border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-bg-strong)] px-2 py-2">
            <div className="text-sm font-semibold text-text-dark">{mergedReferenceImages.length}</div>
            <div className="mt-0.5 text-[10px] text-text-muted">{t('node.imageNode.referenceImages')}</div>
          </div>
          <div className="rounded-md border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-bg-strong)] px-2 py-2">
            <div className="text-sm font-semibold text-text-dark">{(openedDirectorStudioProjects ?? data.directorStudioProjects ?? []).length}</div>
            <div className="mt-0.5 text-[10px] text-text-muted">{t('directorStudio.projects')}</div>
          </div>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); openDirectorStudio(); }}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-2 text-xs font-medium text-white hover:bg-accent/90"
            title={t('directorStudio.openFullscreen')}
          >
            <Maximize2 className="h-3.5 w-3.5" />
            {t('directorStudio.nodeCard.enter')}
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); void handleAddSnapshotToCanvas(data.snapshotUrl ?? null); }}
            disabled={!data.snapshotUrl}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] px-3 py-2 text-xs text-[var(--canvas-node-button-text)] hover:bg-[var(--canvas-node-menu-hover)] disabled:cursor-not-allowed disabled:opacity-40"
            title={data.snapshotUrl ? t('directorStudio.addToCanvasTitle') : t('directorStudio.addToCanvasNoSnapshot')}
          >
            <Camera className="h-3.5 w-3.5" />
            {t('directorStudio.addToCanvas')}
          </button>
        </div>
      </div>

      {directorStudioOpen && (
        <DirectorStudioShell
          sourceNodeId={id}
          data={directorStudioData}
          referenceImages={mergedReferenceImages}
          panoramaAssets={directorStudioPanoramaAssets}
          imageAssets={directorStudioImageAssets}
          selectedItemId={selectedItemId}
          onSelectedItemChange={setSelectedItemId}
          onItemsChange={handleItemsChange}
          onUpdateNodeData={updateBlueprintNodeData}
          onAddSnapshotToCanvas={handleAddSnapshotToCanvas}
          onClose={closeDirectorStudio}
        />
      )}
    </div>
  );
});

BlueprintNode.displayName = 'BlueprintNode';
