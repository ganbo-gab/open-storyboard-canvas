import { readSystemClipboard, writeSystemClipboardText } from '@/commands/image';
import { isAudioFile, isImageFile, isVideoFile, type DroppedMaterialSource } from '@/features/canvas/application/imageDragDrop';
import { DEFAULT_NODE_WIDTH, type CanvasNode, type CanvasEdge } from '@/features/canvas/domain/canvasNodes';

export interface CanvasClipboardSnapshot {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export function getNodeSize(node: CanvasNode): { width: number; height: number } {
  const styleWidth = typeof node.style?.width === 'number' ? node.style.width : null;
  const styleHeight = typeof node.style?.height === 'number' ? node.style.height : null;
  return {
    width: node.measured?.width ?? styleWidth ?? DEFAULT_NODE_WIDTH,
    height: node.measured?.height ?? styleHeight ?? 200,
  };
}

export function resolveAbsoluteNodePosition(
  node: CanvasNode,
  nodeMap: Map<string, CanvasNode>
): { x: number; y: number } {
  let x = node.position.x;
  let y = node.position.y;
  let currentParentId = node.parentId;
  const visited = new Set<string>();

  while (currentParentId && !visited.has(currentParentId)) {
    visited.add(currentParentId);
    const parent = nodeMap.get(currentParentId);
    if (!parent) {
      break;
    }
    x += parent.position.x;
    y += parent.position.y;
    currentParentId = parent.parentId;
  }

  return { x, y };
}

export function collectNodeIdsWithDescendants(nodes: CanvasNode[], seedIds: string[]): string[] {
  const nodeIds = new Set(seedIds);
  let changed = true;

  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (!node.parentId || nodeIds.has(node.id)) {
        continue;
      }
      if (nodeIds.has(node.parentId)) {
        nodeIds.add(node.id);
        changed = true;
      }
    }
  }

  return Array.from(nodeIds);
}

export function sortNodesForDuplication(nodes: CanvasNode[]): CanvasNode[] {
  const nodeMap = new Map(nodes.map((node) => [node.id, node] as const));
  const depthCache = new Map<string, number>();

  const getDepth = (node: CanvasNode, visiting = new Set<string>()): number => {
    const cached = depthCache.get(node.id);
    if (cached !== undefined) {
      return cached;
    }

    if (visiting.has(node.id)) {
      return 0;
    }
    visiting.add(node.id);
    const parent = node.parentId ? nodeMap.get(node.parentId) : null;
    const depth = parent ? getDepth(parent, visiting) + 1 : 0;
    visiting.delete(node.id);
    depthCache.set(node.id, depth);
    return depth;
  };

  return [...nodes].sort((a, b) => getDepth(a) - getDepth(b));
}

export function getSnapshotBounds(snapshot: CanvasClipboardSnapshot): { minX: number; minY: number } | null {
  const nodeMap = new Map(snapshot.nodes.map((node) => [node.id, node] as const));
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;

  for (const node of snapshot.nodes) {
    const absolute = resolveAbsoluteNodePosition(node, nodeMap);
    minX = Math.min(minX, absolute.x);
    minY = Math.min(minY, absolute.y);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return null;
  }
  return { minX, minY };
}

export function buildDuplicateEdge(
  edge: CanvasEdge,
  nextSource: string,
  nextTarget: string,
  existingEdgeIds: Set<string>
): CanvasEdge {
  let edgeId = `e-${nextSource}-${nextTarget}`;
  if (existingEdgeIds.has(edgeId)) {
    const baseEdgeId = `${edgeId}-copy`;
    let copyIndex = 1;
    edgeId = `${baseEdgeId}-${copyIndex}`;
    while (existingEdgeIds.has(edgeId)) {
      copyIndex += 1;
      edgeId = `${baseEdgeId}-${copyIndex}`;
    }
  }
  existingEdgeIds.add(edgeId);

  return {
    ...cloneNodeData(edge),
    id: edgeId,
    source: nextSource,
    target: nextTarget,
    sourceHandle: edge.sourceHandle ?? 'source',
    targetHandle: edge.targetHandle ?? 'target',
    type: edge.type ?? 'disconnectableEdge',
    selected: false,
  };
}

export interface ClipboardContentReadResult {
  mediaFile: File | null;
  imageFile: File | null;
  text: string;
  readFailed?: boolean;
  mediaFiles?: File[];
  filePaths?: string[];
}

interface BrowserClipboardTextReadResult {
  text: string;
  readFailed: boolean;
}

function createClipboardFile(blob: Blob, mimeType: string, fallbackKind: 'image' | 'video' | 'audio'): File {
  const subtype = mimeType.split('/')[1]?.split('+')[0] || (
    fallbackKind === 'image' ? 'png' : fallbackKind === 'video' ? 'mp4' : 'mp3'
  );
  return new File([blob], `pasted-${fallbackKind}.${subtype}`, {
    type: blob.type || mimeType,
    lastModified: Date.now(),
  });
}

async function readBrowserClipboardText(): Promise<BrowserClipboardTextReadResult> {
  if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
    return { text: '', readFailed: false };
  }
  try {
    return { text: await navigator.clipboard.readText(), readFailed: false };
  } catch (error) {
    console.warn('Failed to read text from clipboard', error);
    return { text: '', readFailed: true };
  }
}

function emptyClipboardContent(readFailed = false): ClipboardContentReadResult {
  return {
    mediaFile: null,
    imageFile: null,
    text: '',
    readFailed,
  };
}

async function readBrowserClipboardContent(): Promise<ClipboardContentReadResult> {
  if (!navigator.clipboard) return emptyClipboardContent(true);
  try {
    if (typeof navigator.clipboard.read !== 'function') {
      const result = await readBrowserClipboardText();
      return { ...emptyClipboardContent(result.readFailed), text: result.text };
    }
    // Read one clipboard snapshot. Separate read()/readText() calls can observe different copies.
    const items = await navigator.clipboard.read();
    const mediaFiles: File[] = [];
    let text = '';
    for (const item of items) {
      if (item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
      const type = item.types.find(type => /^(image|video|audio)\//.test(type));
      if (type) {
        const blob = await item.getType(type);
        const kind = type.startsWith('video/') ? 'video' : type.startsWith('audio/') ? 'audio' : 'image';
        mediaFiles.push(createClipboardFile(blob, blob.type || type, kind));
      }
    }
    const mediaFile = mediaFiles[0] ?? null;
    return { mediaFiles, mediaFile, imageFile: isImageFile(mediaFile) ? mediaFile : null, text };
  } catch {
    // A denied binary read must not silently paste a different text representation.
    return emptyClipboardContent(true);
  }
}

async function readTauriClipboardContent(): Promise<ClipboardContentReadResult | null> {
  try {
    const systemClipboard = await readSystemClipboard();
    if (systemClipboard) {
      const image = systemClipboard.image;
      const imageFile = image
        ? new File([new Uint8Array(image.bytes)], image.fileName || 'pasted-image.png', {
            type: image.mimeType || 'image/png',
            lastModified: Date.now(),
          })
        : null;
      return {
        mediaFile: imageFile,
        imageFile,
        text: systemClipboard.text ?? '',
            filePaths: systemClipboard.filePaths ?? [],
      };
    }
  } catch (error) {
    console.warn('Failed to read system clipboard via Tauri', error);
    return emptyClipboardContent(true);
  }

  return null;
}

export async function readClipboardContent(): Promise<ClipboardContentReadResult> {
  // The native reader is authoritative in desktop builds, even when empty or unreadable.
  // Falling back to another clipboard representation resurrected stale data in WebKit.
  const native = await readTauriClipboardContent();
  return native ?? await readBrowserClipboardContent();
}

export async function writeTextToClipboard(text: string): Promise<void> {
  if (await writeSystemClipboardText(text)) return;
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);
  if (!copied) {
    throw new Error('Failed to copy text');
  }
}

/** Only standalone media URLs/paths become media; normal copied prose stays text. */
export function clipboardMaterialSources(values: readonly string[]): DroppedMaterialSource[] {
  return values.flatMap(value => value.split(/\r?\n/)).flatMap(raw => {
    const source = raw.trim();
    if (!/^(?:https?:\/\/|file:\/\/|\/|[A-Za-z]:[\\/]|data:(?:image|video|audio)\/)/i.test(source)) return [];
    let fileName: string;
    try { fileName = decodeURIComponent(new URL(source).pathname).split(/[\\/]/).at(-1) || ''; }
    catch { fileName = source.split(/[\\/]/).at(-1) || ''; }
    const probe = new File([], fileName, { type: source.startsWith('data:') ? source.slice(5).split(/[;,]/)[0] : '' });
    const kind = isImageFile(probe) ? 'image' : isVideoFile(probe) ? 'video' : isAudioFile(probe) ? 'audio' : null;
    return kind ? [{ source, kind, fileName: source.startsWith('data:') ? null : fileName }] : [];
  });
}

export function hasRectCollision(
  candidateRect: { x: number; y: number; width: number; height: number },
  nodes: CanvasNode[],
  ignoreNodeIds: Set<string>
): boolean {
  const margin = 18;
  return nodes.some((node) => {
    if (ignoreNodeIds.has(node.id)) {
      return false;
    }
    const size = getNodeSize(node);
    return (
      candidateRect.x < node.position.x + size.width + margin &&
      candidateRect.x + candidateRect.width + margin > node.position.x &&
      candidateRect.y < node.position.y + size.height + margin &&
      candidateRect.y + candidateRect.height + margin > node.position.y
    );
  });
}

export function cloneNodeData<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createUiNodeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
