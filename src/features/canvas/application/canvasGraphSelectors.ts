import {
  isExportImageNode,
  isImageEditNode,
  isPanoramaNode,
  isUploadNode,
  type CanvasEdge,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { graphImageResolver } from '@/features/canvas/application/graphImageResolver';
import {
  collectInputReferences,
  type GraphReferenceItem,
} from '@/features/canvas/application/graphReferenceResolver';

export interface CanvasImageAssetSummary {
  id: string;
  url: string;
  label: string;
}

export interface InputImageRefSummary {
  imageUrl: string;
  previewImageUrl: string | null;
}

const EMPTY_SIGNATURE = '[]';

type ImageSourceNodeData = {
  imageUrl?: string | null;
  previewImageUrl?: string | null;
  displayName?: string | null;
  aspectRatio?: string | null;
  resultKind?: string | null;
  metadata?: unknown;
  isGenerating?: boolean | null;
};

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return EMPTY_SIGNATURE;
  }
}

function getImageSourceData(node: CanvasNode | undefined): ImageSourceNodeData | null {
  if (!node || (!isUploadNode(node) && !isImageEditNode(node) && !isExportImageNode(node))) {
    return null;
  }
  return node.data as ImageSourceNodeData;
}

function getAnyImageData(node: CanvasNode | undefined): ImageSourceNodeData | null {
  if (!node) return null;
  return node.data as ImageSourceNodeData;
}

function getPrimaryImageUrl(data: ImageSourceNodeData | null): string | null {
  return data?.imageUrl || data?.previewImageUrl || null;
}

function getDisplayLabel(data: ImageSourceNodeData | null): string {
  return typeof data?.displayName === 'string' ? data.displayName.trim() : '';
}

function parseAspectRatioValue(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  const ratioMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
  if (ratioMatch) {
    const width = Number(ratioMatch[1]);
    const height = Number(ratioMatch[2]);
    return Number.isFinite(width) && Number.isFinite(height) && height > 0 ? width / height : null;
  }
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function isPanoramaAspectRatio(value: string | null | undefined): boolean {
  const ratio = parseAspectRatioValue(value);
  return ratio !== null && ratio >= 1.9;
}

function unknownValueMentionsPanorama(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.toLowerCase().includes('panorama') || value.includes('全景');
  }
  if (Array.isArray(value)) {
    return value.some(unknownValueMentionsPanorama);
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(unknownValueMentionsPanorama);
  }
  return false;
}

function stringMentionsPanoramaPreview(value: string | null | undefined): boolean {
  if (!value) return false;
  const lower = value.toLowerCase();
  return (
    lower.includes('current view') ||
    lower.includes('quad') ||
    lower.includes('four-view') ||
    lower.includes('scene sheet') ||
    value.includes('当前视图') ||
    value.includes('四视图') ||
    value.includes('视图截图')
  );
}

export function selectInputImageSignature(
  nodeId: string,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): string {
  return safeStringify(graphImageResolver.collectInputImages(nodeId, nodes, edges));
}

export function parseInputImageSignature(signature: string): string[] {
  try {
    const parsed = JSON.parse(signature) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [];
  } catch {
    return [];
  }
}

export function selectInputReferenceSignature(
  nodeId: string,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): string {
  return safeStringify(collectInputReferences(nodeId, nodes, edges));
}

export function parseInputReferenceSignature(signature: string): GraphReferenceItem[] {
  try {
    const parsed = JSON.parse(signature) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((item): GraphReferenceItem | null => {
        if (!item || typeof item !== 'object') {
          return null;
        }
        const record = item as Partial<GraphReferenceItem>;
        if (record.kind !== 'image' && record.kind !== 'video' && record.kind !== 'text') {
          return null;
        }
        if (typeof record.sourceNodeId !== 'string' || typeof record.label !== 'string' || typeof record.token !== 'string') {
          return null;
        }
        if (record.kind === 'image' && typeof record.imageUrl !== 'string') {
          return null;
        }
        if (record.kind === 'video' && typeof record.videoUrl !== 'string') {
          return null;
        }
        if (record.kind === 'text' && typeof record.content !== 'string') {
          return null;
        }
        return {
          kind: record.kind,
          sourceNodeId: record.sourceNodeId,
          label: record.label,
          token: record.token,
          title: typeof record.title === 'string' ? record.title : record.label,
          content: typeof record.content === 'string' ? record.content : undefined,
          imageUrl: typeof record.imageUrl === 'string' ? record.imageUrl : undefined,
          previewImageUrl: typeof record.previewImageUrl === 'string' ? record.previewImageUrl : null,
          videoUrl: typeof record.videoUrl === 'string' ? record.videoUrl : undefined,
          thumbnailUrl: typeof record.thumbnailUrl === 'string' ? record.thumbnailUrl : null,
        };
      })
      .filter((item): item is GraphReferenceItem => Boolean(item));
  } catch {
    return [];
  }
}

export function selectInputImageRefsSignature(
  nodeId: string,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): string {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const dedupedByImageUrl = new Map<string, InputImageRefSummary>();
  edges.forEach((edge) => {
    if (edge.target !== nodeId) return;
    const sourceData = getImageSourceData(nodeById.get(edge.source));
    const imageUrl = sourceData?.imageUrl;
    if (!imageUrl || dedupedByImageUrl.has(imageUrl)) return;
    dedupedByImageUrl.set(imageUrl, {
      imageUrl,
      previewImageUrl: sourceData.previewImageUrl ?? null,
    });
  });
  return dedupedByImageUrl.size > 0 ? safeStringify(Array.from(dedupedByImageUrl.values())) : EMPTY_SIGNATURE;
}

export function parseInputImageRefsSignature(signature: string): InputImageRefSummary[] {
  try {
    const parsed = JSON.parse(signature) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item): InputImageRefSummary | null => {
        if (!item || typeof item !== 'object') return null;
        const record = item as Partial<InputImageRefSummary>;
        if (typeof record.imageUrl !== 'string' || !record.imageUrl) return null;
        return {
          imageUrl: record.imageUrl,
          previewImageUrl: typeof record.previewImageUrl === 'string' ? record.previewImageUrl : null,
        };
      })
      .filter((item): item is InputImageRefSummary => Boolean(item));
  } catch {
    return [];
  }
}

export function selectCanvasImageAssetSignature(nodes: CanvasNode[]): string {
  const assets: CanvasImageAssetSummary[] = [];
  nodes.forEach((node) => {
    const data = getImageSourceData(node);
    const url = getPrimaryImageUrl(data);
    if (!url) return;
    assets.push({
      id: node.id,
      url,
      label: getDisplayLabel(data),
    });
  });
  return assets.length > 0 ? safeStringify(assets) : EMPTY_SIGNATURE;
}

export function selectCanvasPanoramaAssetSignature(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): string {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const panoramaSourceIds = new Set(
    nodes
      .filter((node) => isPanoramaNode(node) && Boolean(getPrimaryImageUrl(getAnyImageData(node))))
      .map((node) => node.id),
  );
  const assets: CanvasImageAssetSummary[] = [];
  const seenUrls = new Set<string>();

  const pushAsset = (node: CanvasNode, url: string) => {
    if (seenUrls.has(url)) return;
    seenUrls.add(url);
    const data = getAnyImageData(node);
    assets.push({
      id: node.id,
      url,
      label: getDisplayLabel(data),
    });
  };

  nodes.forEach((node) => {
    const data = getAnyImageData(node);
    const url = getPrimaryImageUrl(data);
    if (!url) return;

    if (isPanoramaNode(node)) {
      if (data?.isGenerating === true) return;
      pushAsset(node, url);
      return;
    }

    if (!isExportImageNode(node) && !isImageEditNode(node)) {
      return;
    }

    const hasPanoramaMetadata =
      unknownValueMentionsPanorama(data?.resultKind) ||
      unknownValueMentionsPanorama(data?.metadata);
    const hasPanoramaTitle = unknownValueMentionsPanorama(data?.displayName);
    const hasPanoramaSource = edges.some((edge) => {
      if (edge.target !== node.id) return false;
      const sourceNode = nodeById.get(edge.source);
      return sourceNode ? panoramaSourceIds.has(sourceNode.id) : false;
    });

    if (
      stringMentionsPanoramaPreview(data?.displayName) ||
      (
        !hasPanoramaMetadata &&
        !((hasPanoramaSource || hasPanoramaTitle) && isPanoramaAspectRatio(data?.aspectRatio))
      )
    ) {
      return;
    }

    pushAsset(node, url);
  });

  return assets.length > 0 ? safeStringify(assets) : EMPTY_SIGNATURE;
}

export function parseCanvasImageAssetSignature(signature: string): CanvasImageAssetSummary[] {
  try {
    const parsed = JSON.parse(signature) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item): CanvasImageAssetSummary | null => {
        if (!item || typeof item !== 'object') return null;
        const record = item as Partial<CanvasImageAssetSummary>;
        if (typeof record.id !== 'string' || typeof record.url !== 'string') return null;
        return {
          id: record.id,
          url: record.url,
          label: typeof record.label === 'string' ? record.label : '',
        };
      })
      .filter((item): item is CanvasImageAssetSummary => Boolean(item));
  } catch {
    return [];
  }
}
