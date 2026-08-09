import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
} from '../domain/canvasNodes';

export type CanvasAssetCatalogKind = 'image' | 'video' | 'audio';

export interface CanvasAssetCatalogItem {
  id: string;
  nodeId: string;
  kind: CanvasAssetCatalogKind;
  title: string;
  sourceLabel: string;
  order: number;
  aspectRatio?: string;
  url: string;
  previewUrl?: string | null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function assetFingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function getNodeTitle(node: CanvasNode, fallback: string): string {
  const data = node.data as Record<string, unknown>;
  return readString(data.displayName) ?? readString(data.sourceFileName) ?? fallback;
}

function getNodeSourceLabel(node: CanvasNode): string {
  switch (node.type) {
    case CANVAS_NODE_TYPES.upload:
      return '上传图';
    case CANVAS_NODE_TYPES.imageEdit:
      return 'AI 图片';
    case CANVAS_NODE_TYPES.exportImage:
      return '结果图';
    case CANVAS_NODE_TYPES.panorama:
      return '全景图';
    case CANVAS_NODE_TYPES.storyboardSplit:
      return '故事板帧';
    case CANVAS_NODE_TYPES.storyboardGen:
      return '故事板生成图';
    case CANVAS_NODE_TYPES.video:
      return '视频';
    case CANVAS_NODE_TYPES.audio:
      return '音频';
    case CANVAS_NODE_TYPES.blueprint:
      return '导演台';
    default:
      return '画布资产';
  }
}

function addAsset(
  target: CanvasAssetCatalogItem[],
  seenIds: Set<string>,
  item: CanvasAssetCatalogItem,
): void {
  if (seenIds.has(item.id) || !item.url.trim()) {
    return;
  }
  seenIds.add(item.id);
  target.push(item);
}

function addImage(
  target: CanvasAssetCatalogItem[],
  seenIds: Set<string>,
  input: Omit<CanvasAssetCatalogItem, 'kind'>,
): void {
  addAsset(target, seenIds, { ...input, kind: 'image' });
}

function addDirectorSnapshotAssets(
  target: CanvasAssetCatalogItem[],
  seenIds: Set<string>,
  node: CanvasNode,
  data: Record<string, unknown>,
  baseOrder: number,
): void {
  const nodeTitle = getNodeTitle(node, '导演台');
  const addSnapshot = (
    urlValue: unknown,
    idPrefix: string,
    order: number,
    title: string,
    aspectRatioValue: unknown = data.aspectRatio,
  ) => {
    const url = readString(urlValue);
    if (!url) return;
    addImage(target, seenIds, {
      id: `${node.id}:${idPrefix}:${assetFingerprint(url)}`,
      nodeId: node.id,
      title,
      sourceLabel: '导演台快照',
      order,
      aspectRatio: readString(aspectRatioValue) ?? undefined,
      url,
      previewUrl: url,
    });
  };

  addSnapshot(data.snapshotUrl, 'director:snapshot', baseOrder + 700, `${nodeTitle} · 当前快照`);
  if (Array.isArray(data.snapshotHistory)) {
    data.snapshotHistory.forEach((url, index) => {
      addSnapshot(url, 'director:snapshot', baseOrder + 701 + index, `${nodeTitle} · 快照 ${index + 1}`);
    });
  }

  const addReferenceImages = (value: unknown, idPrefix: string, orderBase: number) => {
    if (!Array.isArray(value)) return;
    value.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') return;
      const record = entry as Record<string, unknown>;
      const url = readString(record.url);
      if (!url) return;
      const referenceId = readString(record.id) ?? assetFingerprint(url);
      addImage(target, seenIds, {
        id: `${node.id}:${idPrefix}:${referenceId}`,
        nodeId: node.id,
        title: readString(record.label) ?? `${nodeTitle} · 参考图 ${index + 1}`,
        sourceLabel: '导演台参考图',
        order: orderBase + index,
        url,
        previewUrl: url,
      });
    });
  };

  const addItemReferenceImages = (
    value: unknown,
    idPrefix: string,
    orderBase: number,
    titlePrefix: string,
  ) => {
    if (!Array.isArray(value)) return;
    value.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') return;
      const record = entry as Record<string, unknown>;
      const url = readString(record.refImageUrl);
      if (!url) return;
      const itemId = readString(record.id) ?? assetFingerprint(url);
      addImage(target, seenIds, {
        id: `${node.id}:${idPrefix}:${itemId}`,
        nodeId: node.id,
        title: readString(record.refImageName)
          ?? readString(record.label)
          ?? `${titlePrefix} ${index + 1}`,
        sourceLabel: '导演台元素参考图',
        order: orderBase + index,
        url,
        previewUrl: url,
      });
    });
  };

  addReferenceImages(data.referenceImages, 'director:reference', baseOrder + 800);
  addItemReferenceImages(data.items, 'director:item-reference', baseOrder + 850, `${nodeTitle} · 元素参考`);

  const addBackground = (
    value: unknown,
    role: string,
    title: string,
    order: number,
  ) => {
    const url = readString(value);
    if (!url) return;
    addImage(target, seenIds, {
      id: `${node.id}:director:${role}:${assetFingerprint(url)}`,
      nodeId: node.id,
      title,
      sourceLabel: '导演台场景',
      order,
      url,
      previewUrl: url,
    });
  };

  addBackground(data.backgroundImageUrl, 'background', `${nodeTitle} · 背景`, baseOrder + 600);
  addBackground(data.backgroundPanoramaUrl, 'panorama', `${nodeTitle} · 全景背景`, baseOrder + 601);

  if (!Array.isArray(data.directorStudioProjects)) return;
  data.directorStudioProjects.forEach((projectEntry, projectIndex) => {
    if (!projectEntry || typeof projectEntry !== 'object') return;
    const project = projectEntry as Record<string, unknown>;
    const projectId = readString(project.id) ?? String(projectIndex);
    const projectName = readString(project.name) ?? `${nodeTitle} · 项目 ${projectIndex + 1}`;
    addBackground(
      project.coverUrl,
      `project:${projectId}:cover`,
      `${projectName} · 封面`,
      baseOrder + 900 + projectIndex * 100,
    );
    if (!project.snapshot || typeof project.snapshot !== 'object') return;
    const snapshot = project.snapshot as Record<string, unknown>;
    addReferenceImages(
      snapshot.referenceImages,
      `director:project:${projectId}:reference`,
      baseOrder + 910 + projectIndex * 100,
    );
    addItemReferenceImages(
      snapshot.items,
      `director:project:${projectId}:item-reference`,
      baseOrder + 915 + projectIndex * 100,
      `${projectName} · 元素参考`,
    );
    addSnapshot(
      snapshot.snapshotUrl,
      `director:project:${projectId}:snapshot`,
      baseOrder + 920 + projectIndex * 100,
      `${projectName} · 快照`,
      snapshot.aspectRatio,
    );
    if (Array.isArray(snapshot.snapshotHistory)) {
      snapshot.snapshotHistory.forEach((url, snapshotIndex) => {
        addSnapshot(
          url,
          `director:project:${projectId}:snapshot`,
          baseOrder + 921 + projectIndex * 100 + snapshotIndex,
          `${projectName} · 快照 ${snapshotIndex + 1}`,
          snapshot.aspectRatio,
        );
      });
    }
    addBackground(
      snapshot.backgroundImageUrl,
      `project:${projectId}:background`,
      `${projectName} · 背景`,
      baseOrder + 930 + projectIndex * 100,
    );
    addBackground(
      snapshot.backgroundPanoramaUrl,
      `project:${projectId}:panorama`,
      `${projectName} · 全景背景`,
      baseOrder + 931 + projectIndex * 100,
    );
  });
}

export function buildCanvasAssetCatalog(nodes: CanvasNode[]): CanvasAssetCatalogItem[] {
  const assets: CanvasAssetCatalogItem[] = [];
  const seenIds = new Set<string>();

  nodes.forEach((node, nodeIndex) => {
    const data = node.data as Record<string, unknown>;
    const sourceLabel = getNodeSourceLabel(node);
    const baseOrder = nodeIndex * 10_000;
    const aspectRatio = readString(data.aspectRatio) ?? undefined;
    const title = getNodeTitle(node, sourceLabel);

    const imageUrl = readString(data.imageUrl);
    if (imageUrl) {
      addImage(assets, seenIds, {
        id: `${node.id}:image`,
        nodeId: node.id,
        title,
        sourceLabel,
        order: baseOrder,
        aspectRatio,
        url: imageUrl,
        previewUrl: readString(data.previewImageUrl),
      });
    }

    const sourceImageUrl = readString(data.sourceImageUrl);
    if (sourceImageUrl) {
      addImage(assets, seenIds, {
        id: `${node.id}:source-image`,
        nodeId: node.id,
        title: `${title} · 来源图`,
        sourceLabel,
        order: baseOrder + 1,
        aspectRatio,
        url: sourceImageUrl,
        previewUrl: sourceImageUrl,
      });
    }

    const videoUrl = readString(data.localVideoUrl) ?? readString(data.videoUrl);
    if (videoUrl) {
      addAsset(assets, seenIds, {
        id: `${node.id}:video`,
        nodeId: node.id,
        kind: 'video',
        title,
        sourceLabel,
        order: baseOrder,
        aspectRatio,
        url: videoUrl,
        previewUrl: readString(data.thumbnailUrl),
      });
    }

    const audioUrl = readString(data.localAudioUrl) ?? readString(data.audioUrl);
    if (audioUrl) {
      addAsset(assets, seenIds, {
        id: `${node.id}:audio`,
        nodeId: node.id,
        kind: 'audio',
        title,
        sourceLabel,
        order: baseOrder,
        url: audioUrl,
      });
    }

    if (Array.isArray(data.frames)) {
      data.frames.forEach((frame, frameIndex) => {
        if (!frame || typeof frame !== 'object') return;
        const record = frame as Record<string, unknown>;
        const frameUrl = readString(record.imageUrl);
        if (!frameUrl) return;
        const frameId = readString(record.id) ?? String(frameIndex);
        const frameOrder = Number.isFinite(record.order) ? Number(record.order) : frameIndex;
        addImage(assets, seenIds, {
          id: `${node.id}:frame:${frameId}`,
          nodeId: node.id,
          title: readString(record.note) ?? `${title} · 第 ${frameIndex + 1} 帧`,
          sourceLabel,
          order: baseOrder + 100 + frameOrder,
          aspectRatio: readString(record.aspectRatio) ?? aspectRatio,
          url: frameUrl,
          previewUrl: readString(record.previewImageUrl),
        });
      });
    }

    if (node.type === CANVAS_NODE_TYPES.blueprint) {
      addDirectorSnapshotAssets(assets, seenIds, node, data, baseOrder);
    }
  });

  return assets;
}

export function projectCanvasAssetCatalogItem(item: CanvasAssetCatalogItem): {
  id: string;
  nodeId: string;
  kind: CanvasAssetCatalogKind;
  title: string;
  sourceLabel: string;
  available: true;
  aspectRatio?: string;
} {
  return {
    id: item.id,
    nodeId: item.nodeId,
    kind: item.kind,
    title: item.title,
    sourceLabel: item.sourceLabel,
    available: true,
    aspectRatio: item.aspectRatio,
  };
}
