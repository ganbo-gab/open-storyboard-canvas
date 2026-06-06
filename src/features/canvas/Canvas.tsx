import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  ReactFlow,
  Background,
  MiniMap,
  BackgroundVariant,
  SelectionMode,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type FinalConnectionState,
  type HandleType,
  type NodeChange,
  type OnConnectStartParams,
  type Viewport,
} from '@xyflow/react';
import { Boxes, ClipboardPaste, Copy, Group, Play, Trash2, Ungroup } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '@xyflow/react/dist/style.css';

import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { useCustomProvidersStore } from '@/stores/customProvidersStore';
import {
  useSettingsStore,
  type CanvasMouseAction,
  type CanvasMouseBindings,
  type CanvasMouseBindingSlot,
} from '@/stores/settingsStore';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { useCanvasPersistence } from '@/features/canvas/hooks/useCanvasPersistence';
import { useCanvasGenerationPolling } from '@/features/canvas/hooks/useCanvasGenerationPolling';
import { useCanvasShortcuts } from '@/features/canvas/hooks/useCanvasShortcuts';
import { useCanvasWasdPan } from '@/features/canvas/hooks/useCanvasWasdPan';
import { CanvasSideToolbar } from '@/features/canvas/CanvasSideToolbar';
import { CanvasLeftRail } from '@/features/canvas/ui/CanvasLeftRail';
import {
  CANVAS_NODE_TYPES,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeData,
  type CanvasNodeType,
  DEFAULT_NODE_WIDTH,
} from '@/features/canvas/domain/canvasNodes';
import {
  prepareNodeImageFromFile,
  resolveImageDisplayUrl,
} from '@/features/canvas/application/imageData';
import { clearBrowserTextSelection } from '@/features/canvas/application/textSelection';
import { copyImageSourceToClipboard, readSystemClipboard } from '@/commands/image';
import {
  dataTransferHasFile,
  dataTransferHasImageFile,
  resolveDroppedImageFile,
} from '@/features/canvas/application/imageDragDrop';
import {
  getConnectMenuNodeTypes,
  nodeHasSourceHandle,
  nodeHasTargetHandle,
} from '@/features/canvas/domain/nodeRegistry';
import { hasConfiguredImageProvider } from '@/features/canvas/application/providerAvailability';
import { listModelProviders } from '@/features/canvas/models';
import { nodeTypes } from './nodes';
import { edgeTypes } from './edges';
import { NodeSelectionMenu } from './NodeSelectionMenu';
import { SelectedNodeOverlay } from './ui/SelectedNodeOverlay';
import { NodeToolDialog } from './ui/NodeToolDialog';
import { ImageViewerModal } from './ui/ImageViewerModal';
import { AssetPanel, type CanvasAssetItem } from './ui/AssetPanel';
import { MissingApiKeyHint } from '@/features/settings/MissingApiKeyHint';

const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };
const CANVAS_MARQUEE_MIN_DISTANCE = 4;
const CANVAS_BATCH_TRIGGER_TYPES = new Set<CanvasNodeType>([
  CANVAS_NODE_TYPES.imageEdit,
  CANVAS_NODE_TYPES.aiVideo,
  CANVAS_NODE_TYPES.aiText,
  CANVAS_NODE_TYPES.storyboardGen,
]);

interface PendingConnectStart {
  nodeId: string;
  handleType: HandleType;
  start?: {
    x: number;
    y: number;
  };
}

interface PreviewConnectionVisual {
  d: string;
  stroke: string;
  strokeWidth: number;
  strokeLinecap: 'butt' | 'round' | 'square';
  left: number;
  top: number;
  width: number;
  height: number;
}

interface CanvasMarqueeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface CanvasMarqueeGesture {
  pointerId: number;
  button: CanvasMouseButton;
  startClientX: number;
  startClientY: number;
  currentClientX: number;
  currentClientY: number;
  moved: boolean;
  startNodeId: string | null;
}

interface DuplicateOptions {
  explicitOffset?: { x: number; y: number };
  disableOffsetIteration?: boolean;
  suppressSelect?: boolean;
  suppressPersist?: boolean;
}

interface DuplicateResult {
  firstNodeId: string | null;
  idMap: Map<string, string>;
}

interface CanvasClipboardSnapshot {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

type ClipboardFreshnessSource = 'internal' | 'system' | null;

interface NodeContextMenuState {
  nodeId: string | null;
  position: { x: number; y: number };
  flowPosition: { x: number; y: number };
}

interface BlankCanvasRightClickState {
  timeStamp: number;
  clientX: number;
  clientY: number;
}

const ALT_DRAG_COPY_Z_INDEX = 2000;
const EMPTY_CANVAS_ASSETS: CanvasAssetItem[] = [];
const BLANK_CANVAS_CONTEXT_MENU_DOUBLE_CLICK_MS = 450;
const BLANK_CANVAS_CONTEXT_MENU_DOUBLE_CLICK_DISTANCE = 8;
const CANVAS_MOUSE_BUTTONS = [0, 1, 2] as const;
type CanvasMouseButton = typeof CANVAS_MOUSE_BUTTONS[number];

const CLICK_SLOT_BY_BUTTON: Record<CanvasMouseButton, CanvasMouseBindingSlot> = {
  0: 'leftClick',
  1: 'middleClick',
  2: 'rightClick',
};

const DRAG_SLOT_BY_BUTTON: Record<CanvasMouseButton, CanvasMouseBindingSlot> = {
  0: 'leftDrag',
  1: 'middleDrag',
  2: 'rightDrag',
};

function isCanvasMouseButton(button: number): button is CanvasMouseButton {
  return button === 0 || button === 1 || button === 2;
}

function getCanvasMouseAction(
  bindings: CanvasMouseBindings,
  button: number,
  gesture: 'click' | 'drag'
): CanvasMouseAction {
  if (!isCanvasMouseButton(button)) {
    return 'none';
  }
  return bindings[gesture === 'click' ? CLICK_SLOT_BY_BUTTON[button] : DRAG_SLOT_BY_BUTTON[button]];
}

function createAssetPanelAnchorRect(x: number, y: number): DOMRect {
  if (typeof DOMRect !== 'undefined') {
    return new DOMRect(x, y, 0, 0);
  }
  return {
    x,
    y,
    left: x,
    right: x,
    top: y,
    bottom: y,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

function normalizeClientRect(
  startClientX: number,
  startClientY: number,
  currentClientX: number,
  currentClientY: number,
  containerRect: DOMRect
): CanvasMarqueeRect {
  const minClientX = Math.min(startClientX, currentClientX);
  const minClientY = Math.min(startClientY, currentClientY);
  const maxClientX = Math.max(startClientX, currentClientX);
  const maxClientY = Math.max(startClientY, currentClientY);
  return {
    left: minClientX - containerRect.left,
    top: minClientY - containerRect.top,
    width: maxClientX - minClientX,
    height: maxClientY - minClientY,
  };
}

function rectsOverlap(
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number }
): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function escapeNodeDataId(nodeId: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(nodeId);
  }
  return nodeId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function shouldIgnoreCanvasMarqueeTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return true;
  }

  if ((target as HTMLElement).isContentEditable || target.closest('[contenteditable]')) {
    return true;
  }

  return Boolean(target.closest([
    'button',
    'input',
    'textarea',
    'select',
    'video',
    'dialog',
    '[role="dialog"]',
    '[data-canvas-no-marquee="true"]',
    '.react-flow__handle',
    '.react-flow__edgeupdater',
    '.react-flow__resize-control',
    '.react-flow__edge',
    '.react-flow__minimap',
    '.canvas-minimap',
  ].join(',')));
}

function getCanvasNodeIdFromTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) {
    return null;
  }
  const nodeElement = target.closest<HTMLElement>('.react-flow__node[data-id]');
  return nodeElement?.dataset.id ?? null;
}

function getNodeSize(node: CanvasNode): { width: number; height: number } {
  const styleWidth = typeof node.style?.width === 'number' ? node.style.width : null;
  const styleHeight = typeof node.style?.height === 'number' ? node.style.height : null;
  return {
    width: node.measured?.width ?? styleWidth ?? DEFAULT_NODE_WIDTH,
    height: node.measured?.height ?? styleHeight ?? 200,
  };
}

function resolveAbsoluteNodePosition(
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

function collectNodeIdsWithDescendants(nodes: CanvasNode[], seedIds: string[]): string[] {
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

function sortNodesForDuplication(nodes: CanvasNode[]): CanvasNode[] {
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

function getSnapshotBounds(snapshot: CanvasClipboardSnapshot): { minX: number; minY: number } | null {
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

function buildDuplicateEdge(
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

interface ClipboardContentReadResult {
  imageFile: File | null;
  text: string;
  fingerprint: string | null;
  readFailed?: boolean;
}

type ClipboardPasteSource =
  | { source: 'internal' }
  | { source: 'system'; content: ClipboardContentReadResult }
  | { source: 'none' };

interface SystemClipboardPasteOptions {
  targetNode: CanvasNode | null;
  flowPosition?: { x: number; y: number };
  pasteIntoSelectedUpload?: boolean;
}

interface BrowserClipboardImageReadResult {
  file: File | null;
  readFailed: boolean;
}

interface BrowserClipboardTextReadResult {
  text: string;
  readFailed: boolean;
}

interface ReadClipboardContentOptions {
  preferBrowserApi?: boolean;
  avoidBrowserApiWhenTauriAvailable?: boolean;
}

function hashBytes(bytes: ArrayLike<number>): string {
  let hash = 2166136261;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index] ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

async function fingerprintImageFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return `image:${file.type || 'application/octet-stream'}:${bytes.byteLength}:${hashBytes(bytes)}`;
}

function fingerprintClipboardContent(content: {
  image?: { bytes: ArrayLike<number>; mimeType?: string | null } | null;
  text?: string | null;
}): string | null {
  const image = content.image;
  if (image) {
    return `image:${image.mimeType || 'application/octet-stream'}:${image.bytes.length}:${hashBytes(image.bytes)}`;
  }
  const text = content.text?.trim();
  if (text) {
    return `text:${text.length}:${hashText(text)}`;
  }
  return null;
}

async function readBrowserClipboardImageFile(): Promise<BrowserClipboardImageReadResult> {
  const clipboard = navigator.clipboard as Clipboard & {
    read?: () => Promise<ClipboardItem[]>;
  };
  if (typeof clipboard?.read !== 'function') {
    return { file: null, readFailed: false };
  }

  try {
    const items = await clipboard.read();
    for (const item of items) {
      const imageType = item.types.find((type) => type.startsWith('image/'));
      if (!imageType) {
        continue;
      }
      const blob = await item.getType(imageType);
      const subtype = imageType.split('/')[1]?.split('+')[0] || 'png';
      return {
        file: new File([blob], `pasted-image.${subtype}`, {
          type: blob.type || imageType,
          lastModified: Date.now(),
        }),
        readFailed: false,
      };
    }
  } catch (error) {
    console.warn('Failed to read image from clipboard', error);
    return { file: null, readFailed: true };
  }

  return { file: null, readFailed: false };
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
    imageFile: null,
    text: '',
    fingerprint: null,
    readFailed,
  };
}

async function readBrowserClipboardContent(): Promise<ClipboardContentReadResult> {
  const imageRead = await readBrowserClipboardImageFile();
  const textRead = await readBrowserClipboardText();
  return {
    imageFile: imageRead.file,
    text: textRead.text,
    fingerprint: imageRead.file
      ? await fingerprintImageFile(imageRead.file)
      : fingerprintClipboardContent({ text: textRead.text }),
    readFailed: imageRead.readFailed || textRead.readFailed,
  };
}

async function readTauriClipboardContent(): Promise<ClipboardContentReadResult | null> {
  try {
    const systemClipboard = await readSystemClipboard();
    if (systemClipboard) {
      const image = systemClipboard.image;
      return {
        imageFile: image
          ? new File([new Uint8Array(image.bytes)], image.fileName || 'pasted-image.png', {
              type: image.mimeType || 'image/png',
              lastModified: Date.now(),
            })
          : null,
        text: systemClipboard.text ?? '',
        fingerprint: fingerprintClipboardContent(systemClipboard),
      };
    }
  } catch (error) {
    console.warn('Failed to read system clipboard via Tauri', error);
    return emptyClipboardContent(true);
  }

  return null;
}

async function readClipboardContent(
  options: ReadClipboardContentOptions = {}
): Promise<ClipboardContentReadResult> {
  if (options.avoidBrowserApiWhenTauriAvailable) {
    const tauriClipboard = await readTauriClipboardContent();
    if (tauriClipboard) {
      return tauriClipboard;
    }

    return await readBrowserClipboardContent();
  }

  if (options.preferBrowserApi) {
    const browserClipboard = await readBrowserClipboardContent();
    if (hasClipboardPayload(browserClipboard)) {
      return browserClipboard;
    }

    const tauriClipboard = await readTauriClipboardContent();
    if (tauriClipboard && hasClipboardPayload(tauriClipboard)) {
      return {
        ...tauriClipboard,
        readFailed: tauriClipboard.readFailed || browserClipboard.readFailed,
      };
    }

    return tauriClipboard
      ? {
          ...tauriClipboard,
          readFailed: tauriClipboard.readFailed || browserClipboard.readFailed,
        }
      : browserClipboard;
  }

  const tauriClipboard = await readTauriClipboardContent();
  if (tauriClipboard && hasClipboardPayload(tauriClipboard)) {
    return tauriClipboard;
  }

  const browserClipboard = await readBrowserClipboardContent();
  if (hasClipboardPayload(browserClipboard)) {
    return browserClipboard;
  }

  return tauriClipboard
    ? {
        ...tauriClipboard,
        readFailed: tauriClipboard.readFailed || browserClipboard.readFailed,
      }
    : browserClipboard;
}

function hasClipboardPayload(content: ClipboardContentReadResult): boolean {
  return Boolean(content.imageFile || content.text.trim() || content.fingerprint);
}

function resolveNodeImageClipboardSource(node: CanvasNode): string {
  if (
    node.type !== CANVAS_NODE_TYPES.upload
    && node.type !== CANVAS_NODE_TYPES.imageEdit
    && node.type !== CANVAS_NODE_TYPES.exportImage
  ) {
    return '';
  }
  const data = node.data as { imageUrl?: unknown; previewImageUrl?: unknown };
  return (
    (typeof data.imageUrl === 'string' && data.imageUrl.trim())
    || (typeof data.previewImageUrl === 'string' && data.previewImageUrl.trim())
    || ''
  );
}

function resolveNodeTextClipboardContent(node: CanvasNode, nodes: CanvasNode[]): string {
  if (node.type === CANVAS_NODE_TYPES.textAnnotation || node.type === CANVAS_NODE_TYPES.jsonCard || node.type === CANVAS_NODE_TYPES.aiText) {
    return getGeneratedTextForConnection(node, nodes);
  }
  if (node.type === CANVAS_NODE_TYPES.aiVideo || node.type === CANVAS_NODE_TYPES.imageEdit) {
    const prompt = (node.data as { prompt?: unknown }).prompt;
    return typeof prompt === 'string' ? prompt.trim() : '';
  }
  if (node.type === CANVAS_NODE_TYPES.video) {
    const data = node.data as { localVideoUrl?: unknown; videoUrl?: unknown };
    return (
      (typeof data.localVideoUrl === 'string' && data.localVideoUrl.trim())
      || (typeof data.videoUrl === 'string' && data.videoUrl.trim())
      || ''
    );
  }
  return '';
}

async function syncSingleCanvasNodeToSystemClipboard(
  snapshot: CanvasClipboardSnapshot | null,
  allNodes: CanvasNode[]
): Promise<string | null> {
  if (!snapshot || snapshot.nodes.length !== 1) {
    return (await readClipboardContent()).fingerprint;
  }

  const [node] = snapshot.nodes;
  const imageSource = resolveNodeImageClipboardSource(node);
  try {
    if (imageSource) {
      await copyImageSourceToClipboard(imageSource);
      return (await readClipboardContent()).fingerprint;
    }

    const text = resolveNodeTextClipboardContent(node, allNodes);
    if (text && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return (await readClipboardContent()).fingerprint;
    }
  } catch (error) {
    console.warn('Failed to sync canvas copy into system clipboard', error);
  }

  return (await readClipboardContent()).fingerprint;
}

function hasRectCollision(
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

function cloneNodeData<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function resolveAllowedNodeTypes(handleType: HandleType): CanvasNodeType[] {
  return getConnectMenuNodeTypes(handleType);
}

function canNodeTypeBeManualConnectionSource(type: CanvasNodeType): boolean {
  return type === CANVAS_NODE_TYPES.upload
    || type === CANVAS_NODE_TYPES.imageEdit
    || type === CANVAS_NODE_TYPES.exportImage
    || type === CANVAS_NODE_TYPES.video
    || type === CANVAS_NODE_TYPES.aiText
    || type === CANVAS_NODE_TYPES.textAnnotation
    || type === CANVAS_NODE_TYPES.jsonCard;
}

function getGeneratedTextForConnection(sourceNode: CanvasNode, nodes: CanvasNode[]): string {
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

function isLikelyVideoSourceText(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return false;
  }
  return /\.(mp4|webm|mov|m4v|avi|mkv|mpeg|mpg)(?:[?#].*)?$/i.test(trimmed)
    || /^https?:\/\/.+\/.+\.(mp4|webm|mov|m4v|avi|mkv|mpeg|mpg)(?:[?#].*)?$/i.test(trimmed)
    || /^file:\/\/.+\.(mp4|webm|mov|m4v|avi|mkv|mpeg|mpg)(?:[?#].*)?$/i.test(trimmed);
}

function canNodeBeManualConnectionSource(nodeId: string | null | undefined, nodes: CanvasNode[]): boolean {
  if (!nodeId) {
    return false;
  }
  const node = nodes.find((item) => item.id === nodeId);
  return node ? canNodeTypeBeManualConnectionSource(node.type) : false;
}

function getClientPosition(event: MouseEvent | TouchEvent): { x: number; y: number } | null {
  if ('clientX' in event && 'clientY' in event) {
    return { x: event.clientX, y: event.clientY };
  }

  const touch = 'changedTouches' in event
    ? event.changedTouches[0] ?? event.touches[0]
    : null;
  if (!touch) {
    return null;
  }

  return { x: touch.clientX, y: touch.clientY };
}

function getNodeDisplayTitle(node: CanvasNode, fallback: string): string {
  const data = node.data as Record<string, unknown>;
  const displayName = typeof data.displayName === 'string' ? data.displayName.trim() : '';
  if (displayName) {
    return displayName;
  }
  const sourceFileName = typeof data.sourceFileName === 'string' ? data.sourceFileName.trim() : '';
  return sourceFileName || fallback;
}

function getNodeAssetSourceLabel(node: CanvasNode): string {
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
    default:
      return '图片资产';
  }
}

function resolveAssetPreview(rawImageUrl: string, rawPreviewImageUrl?: string | null): {
  imageUrl: string;
  previewImageUrl: string;
} {
  const imageUrl = resolveImageDisplayUrl(rawImageUrl);
  return {
    imageUrl,
    previewImageUrl: resolveImageDisplayUrl(rawPreviewImageUrl || rawImageUrl),
  };
}

function extractCanvasAssets(nodes: CanvasNode[]): CanvasAssetItem[] {
  const assets: CanvasAssetItem[] = [];

  nodes.forEach((node, nodeIndex) => {
    const data = node.data as Record<string, unknown>;
    const sourceLabel = getNodeAssetSourceLabel(node);
    const baseOrder = nodeIndex * 1000;

    const imageUrl = typeof data.imageUrl === 'string' ? data.imageUrl : '';
    if (imageUrl) {
      const previewImageUrl =
        typeof data.previewImageUrl === 'string' ? data.previewImageUrl : null;
      const resolved = resolveAssetPreview(imageUrl, previewImageUrl);
      assets.push({
        id: `${node.id}:image`,
        nodeId: node.id,
        kind: 'image',
        rawImageUrl: imageUrl,
        rawPreviewImageUrl: previewImageUrl,
        aspectRatio: typeof data.aspectRatio === 'string' ? data.aspectRatio : undefined,
        title: getNodeDisplayTitle(node, sourceLabel),
        sourceLabel,
        order: baseOrder,
        ...resolved,
      });
    }

    if (node.type === CANVAS_NODE_TYPES.video) {
      const videoUrl = typeof data.localVideoUrl === 'string' && data.localVideoUrl.trim()
        ? data.localVideoUrl
        : typeof data.videoUrl === 'string'
          ? data.videoUrl
          : '';
      if (videoUrl) {
        const thumbnailUrl =
          typeof data.thumbnailUrl === 'string' && data.thumbnailUrl.trim()
            ? data.thumbnailUrl
            : null;
        assets.push({
          id: `${node.id}:video`,
          nodeId: node.id,
          kind: 'video',
          rawVideoUrl: videoUrl,
          rawThumbnailUrl: thumbnailUrl,
          videoUrl: resolveImageDisplayUrl(videoUrl),
          thumbnailUrl: thumbnailUrl ? resolveImageDisplayUrl(thumbnailUrl) : null,
          aspectRatio: typeof data.aspectRatio === 'string' ? data.aspectRatio : undefined,
          title: getNodeDisplayTitle(node, sourceLabel),
          sourceLabel,
          order: baseOrder,
        });
      }
    }

    if (Array.isArray(data.frames)) {
      data.frames.forEach((frame, frameIndex) => {
        if (!frame || typeof frame !== 'object') {
          return;
        }
        const frameRecord = frame as Record<string, unknown>;
        const frameImageUrl =
          typeof frameRecord.imageUrl === 'string' ? frameRecord.imageUrl : '';
        if (!frameImageUrl) {
          return;
        }
        const framePreviewImageUrl =
          typeof frameRecord.previewImageUrl === 'string' ? frameRecord.previewImageUrl : null;
        const frameNote = typeof frameRecord.note === 'string' ? frameRecord.note.trim() : '';
        const frameOrder = Number.isFinite(frameRecord.order)
          ? Number(frameRecord.order)
          : frameIndex;
        assets.push({
          id: `${node.id}:frame:${String(frameRecord.id ?? frameIndex)}`,
          nodeId: node.id,
          kind: 'image',
          rawImageUrl: frameImageUrl,
          rawPreviewImageUrl: framePreviewImageUrl,
          aspectRatio: typeof frameRecord.aspectRatio === 'string' ? frameRecord.aspectRatio : undefined,
          title: frameNote || `${getNodeDisplayTitle(node, '故事板')} · 第 ${frameIndex + 1} 帧`,
          sourceLabel,
          order: baseOrder + frameOrder + 1,
          ...resolveAssetPreview(frameImageUrl, framePreviewImageUrl),
        });
      });
    }
  });

  return assets;
}

function createPreviewPath(line: PreviewConnectionLine): string {
  const { start, end, handleType } = line;
  const deltaX = end.x - start.x;
  const curveStrength = Math.max(36, Math.min(120, Math.abs(deltaX) * 0.4));
  const handleDirection = handleType === 'source' ? 1 : -1;
  const isReverseDrag = deltaX * handleDirection < 0;
  const effectiveDirection = isReverseDrag ? -handleDirection : handleDirection;
  const startControlX = start.x + effectiveDirection * curveStrength;
  const endControlX = end.x - effectiveDirection * curveStrength;

  return `M ${start.x} ${start.y} C ${startControlX} ${start.y}, ${endControlX} ${end.y}, ${end.x} ${end.y}`;
}

interface PreviewConnectionLine {
  start: { x: number; y: number };
  end: { x: number; y: number };
  handleType: HandleType;
}

export function Canvas() {
  const { t } = useTranslation();
  const reactFlowInstance = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const lastCanvasPointerRef = useRef<{ x: number; y: number } | null>(null);
  const suppressNextPaneClickRef = useRef(false);
  const suppressNextEdgeClickRef = useRef(false);
  const nodesRef = useRef<CanvasNode[]>([]);
  const marqueeGestureRef = useRef<CanvasMarqueeGesture | null>(null);
  const blankCanvasRightClickRef = useRef<BlankCanvasRightClickState | null>(null);
  const [showNodeMenu, setShowNodeMenu] = useState(false);
  const [nodeContextMenu, setNodeContextMenu] = useState<NodeContextMenuState | null>(null);
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 });
  const [flowPosition, setFlowPosition] = useState({ x: 0, y: 0 });
  const [menuAllowedTypes, setMenuAllowedTypes] = useState<CanvasNodeType[] | undefined>(
    undefined
  );
  const [isAssetPanelOpen, setIsAssetPanelOpen] = useState(false);
  const [assetButtonRect, setAssetButtonRect] = useState<DOMRect | null>(null);
  const [assetPanelMode, setAssetPanelMode] = useState<'browse' | 'select'>('browse');
  const [assetConnectTargetNodeId, setAssetConnectTargetNodeId] = useState<string | null>(null);
  const [pendingConnectStart, setPendingConnectStart] = useState<PendingConnectStart | null>(
    null
  );
  const [previewConnectionVisual, setPreviewConnectionVisual] =
    useState<PreviewConnectionVisual | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<CanvasMarqueeRect | null>(null);
  const [selectionBoundsRect, setSelectionBoundsRect] = useState<CanvasMarqueeRect | null>(null);
  const [batchToolbarPosition, setBatchToolbarPosition] =
    useState<{ left: number; top: number } | null>(null);

  const pasteIterationRef = useRef(0);
  const copiedSnapshotRef = useRef<CanvasClipboardSnapshot | null>(null);
  const clipboardFreshnessRef = useRef<ClipboardFreshnessSource>(null);
  const systemClipboardFingerprintAtInternalCopyRef = useRef<string | null | undefined>(null);
  const systemClipboardFingerprintCaptureRef = useRef<Promise<string | null> | null>(null);
  const lastConnectSelectionClearAtRef = useRef(0);
  const pendingConnectWasActiveRef = useRef(false);
  const altDragCopyRef = useRef<{
    sourceNodeIds: string[];
    startPositions: Map<string, { x: number; y: number }>;
    copiedNodeIds: string[];
    sourceToCopyIdMap: Map<string, string>;
  } | null>(null);
  const edgePanGestureRef = useRef<{
    active: boolean;
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startViewportX: number;
    startViewportY: number;
    zoom: number;
    moved: boolean;
  } | null>(null);

  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const applyNodesChange = useCanvasStore((state) => state.onNodesChange);
  const applyEdgesChange = useCanvasStore((state) => state.onEdgesChange);
  const connectNodes = useCanvasStore((state) => state.onConnect);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const deleteEdge = useCanvasStore((state) => state.deleteEdge);
  const deleteNode = useCanvasStore((state) => state.deleteNode);
  const deleteNodes = useCanvasStore((state) => state.deleteNodes);
  const groupNodes = useCanvasStore((state) => state.groupNodes);
  const ungroupNode = useCanvasStore((state) => state.ungroupNode);
  const undo = useCanvasStore((state) => state.undo);
  const redo = useCanvasStore((state) => state.redo);
  const openToolDialog = useCanvasStore((state) => state.openToolDialog);
  const closeToolDialog = useCanvasStore((state) => state.closeToolDialog);
  const setViewportState = useCanvasStore((state) => state.setViewportState);
  const setCanvasViewportSize = useCanvasStore((state) => state.setCanvasViewportSize);
  const imageViewer = useCanvasStore((state) => state.imageViewer);
  const closeImageViewer = useCanvasStore((state) => state.closeImageViewer);
  const navigateImageViewer = useCanvasStore((state) => state.navigateImageViewer);
  const currentViewport = useCanvasStore((state) => state.currentViewport);
  const apiKeys = useSettingsStore((state) => state.apiKeys);
  const dreaminaStatus = useSettingsStore((state) => state.dreaminaStatus);
  const canvasMouseBindings = useSettingsStore((state) => state.canvasMouseBindings);
  const enableCanvasWasdPan = useSettingsStore((state) => state.enableCanvasWasdPan);
  const canvasWasdPanSensitivity = useSettingsStore((state) => state.canvasWasdPanSensitivity);
  const customProviders = useCustomProvidersStore((state) => state.providers);
  const providerIds = useMemo(() => listModelProviders().map((provider) => provider.id), []);
  const hasConfiguredProvider = useMemo(
    () => hasConfiguredImageProvider({
      apiKeys,
      builtInProviderIds: providerIds,
      customProviders,
      dreaminaStatus,
    }),
    [apiKeys, customProviders, dreaminaStatus, providerIds]
  );
  const canvasAssets = useMemo(
    () => (isAssetPanelOpen ? extractCanvasAssets(nodes) : EMPTY_CANVAS_ASSETS),
    [isAssetPanelOpen, nodes]
  );
  const assetPanelAssets = useMemo(() => {
    if (assetPanelMode !== 'select' || !assetConnectTargetNodeId) {
      return canvasAssets;
    }
    return canvasAssets.filter((asset) => asset.kind === 'image' && asset.nodeId !== assetConnectTargetNodeId);
  }, [assetConnectTargetNodeId, assetPanelMode, canvasAssets]);
  const panOnDragButtons = useMemo(
    () => CANVAS_MOUSE_BUTTONS.filter(
      (button) => getCanvasMouseAction(canvasMouseBindings, button, 'drag') === 'panCanvas'
    ),
    [canvasMouseBindings]
  );

  const getCurrentProject = useProjectStore((state) => state.getCurrentProject);
  const saveCurrentProjectViewport = useProjectStore((state) => state.saveCurrentProjectViewport);
  const cancelPendingViewportPersist = useProjectStore(
    (state) => state.cancelPendingViewportPersist
  );
  // Subscribe to currentProjectId so the restore effect below has a
  // single, stable, primitive dependency. Using function-ref deps was
  // letting React occasionally re-run the restore — which clobbers
  // canvasStore.nodes back to the (possibly-stale) currentProject.nodes
  // and explains the user's "blueprint items disappear after re-open"
  // report: in-flight edits that hadn't yet been pushed into
  // currentProject got wiped on a redundant restore pass.
  // Persistence wiring (restore on project enter, debounced save on
  // every meaningful canvas change) lives in this hook so the policy
  // is in one file rather than spread across Canvas. Returns
  // `scheduleCanvasPersist` for callers that want to flush after
  // explicit user actions, and the restore-flag ref so caller-side
  // effects can skip transient work during a project swap.
  const { isRestoringCanvasRef, scheduleCanvasPersist } = useCanvasPersistence(reactFlowInstance);

  useEffect(() => {
    const unsubscribeOpen = canvasEventBus.subscribe('tool-dialog/open', (payload) => {
      openToolDialog(payload);
    });
    const unsubscribeClose = canvasEventBus.subscribe('tool-dialog/close', () => {
      closeToolDialog();
    });

    return () => {
      unsubscribeOpen();
      unsubscribeClose();
    };
  }, [openToolDialog, closeToolDialog]);

  // Watch every node for in-flight image generation jobs and poll the
  // backend until they resolve. Includes per-job timeout, error
  // surfacing for unreachable result URLs, and an unmount-safe active
  // set — see hook docblock for why each guard exists.
  useCanvasGenerationPolling(nodes, apiKeys);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    const element = wrapperRef.current;
    if (!element) {
      return;
    }

    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      setCanvasViewportSize({
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      });
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [setCanvasViewportSize]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      if (pendingConnectStart && changes.every((change) => change.type === 'select')) {
        return;
      }

      applyNodesChange(changes);

      const hasDragMove = changes.some(
        (change) =>
          change.type === 'position' &&
          'dragging' in change &&
          Boolean(change.dragging)
      );
      const hasDragEnd = changes.some(
        (change) =>
          change.type === 'position' &&
          'dragging' in change &&
          change.dragging === false
      );
      const hasResizeMove = changes.some(
        (change) =>
          change.type === 'dimensions' &&
          'resizing' in change &&
          Boolean(change.resizing)
      );
      const hasResizeEnd = changes.some(
        (change) =>
          change.type === 'dimensions' &&
          'resizing' in change &&
          change.resizing === false
      );
      const hasInteractionMove = hasDragMove || hasResizeMove;
      const hasInteractionEnd = hasDragEnd || hasResizeEnd;

      if (hasInteractionMove) {
        return;
      }

      if (hasInteractionEnd) {
        scheduleCanvasPersist(0);
        return;
      }

      scheduleCanvasPersist();
    },
    [applyNodesChange, pendingConnectStart, scheduleCanvasPersist]
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange<CanvasEdge>[]) => {
      applyEdgesChange(changes);
      scheduleCanvasPersist();
    },
    [applyEdgesChange, scheduleCanvasPersist]
  );

  const handleEdgeDoubleClick = useCallback(
    (event: ReactMouseEvent, edge: CanvasEdge) => {
      event.preventDefault();
      event.stopPropagation();
      deleteEdge(edge.id);
      scheduleCanvasPersist(0);
    },
    [deleteEdge, scheduleCanvasPersist]
  );

  const handleEdgeClick = useCallback((event: ReactMouseEvent) => {
    if (!suppressNextEdgeClickRef.current) {
      return;
    }
    suppressNextEdgeClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!canNodeBeManualConnectionSource(connection.source, nodes)) {
        return;
      }
      connectNodes(connection);
      const sourceNode = nodes.find((node) => node.id === connection.source);
      const targetNode = nodes.find((node) => node.id === connection.target);
      if (sourceNode && targetNode?.type === CANVAS_NODE_TYPES.textAnnotation) {
        const sourceText = getGeneratedTextForConnection(sourceNode, nodes);
        if (sourceText) {
          const currentContent = (targetNode.data as { content?: unknown }).content;
          const normalizedCurrent = typeof currentContent === 'string' ? currentContent.trim() : '';
          updateNodeData(targetNode.id, {
            content: normalizedCurrent ? `${normalizedCurrent}\n${sourceText}` : sourceText,
          } as Partial<CanvasNodeData>);
        }
      }
      scheduleCanvasPersist(0);
    },
    [connectNodes, nodes, scheduleCanvasPersist, updateNodeData]
  );

  const handleMoveEnd = useCallback(
    (_event: unknown, viewport: Viewport) => {
      setViewportState(viewport);
      const project = getCurrentProject();
      if (!project || isRestoringCanvasRef.current) {
        return;
      }
      saveCurrentProjectViewport(viewport);
    },
    [getCurrentProject, saveCurrentProjectViewport, setViewportState]
  );

  const handleMove = useCallback(
    (_event: unknown, viewport: Viewport) => {
      setViewportState(viewport);
    },
    [setViewportState]
  );

  const handleMoveStart = useCallback(() => {
    cancelPendingViewportPersist();
  }, [cancelPendingViewportPersist]);

  const handleWasdPanEnd = useCallback(
    (viewport: Viewport) => {
      setViewportState(viewport);
      const project = getCurrentProject();
      if (!project || isRestoringCanvasRef.current) {
        return;
      }
      saveCurrentProjectViewport(viewport);
    },
    [getCurrentProject, saveCurrentProjectViewport, setViewportState]
  );

  useCanvasWasdPan({
    wrapperRef,
    enabled: enableCanvasWasdPan,
    sensitivity: canvasWasdPanSensitivity,
    reactFlowInstance,
    onPanStart: cancelPendingViewportPersist,
    onViewportChange: setViewportState,
    onPanEnd: handleWasdPanEnd,
  });

  const handleOpenAssetPanel = useCallback((buttonRect: DOMRect) => {
    setAssetButtonRect(buttonRect);
    setAssetPanelMode('browse');
    setAssetConnectTargetNodeId(null);
    setIsAssetPanelOpen((open) => !open);
    setShowNodeMenu(false);
    setNodeContextMenu(null);
    setMenuAllowedTypes(undefined);
    setPendingConnectStart(null);
    setPreviewConnectionVisual(null);
  }, []);

  const handleActivateAsset = useCallback(
    (asset: CanvasAssetItem) => {
      if (assetPanelMode === 'select') {
        if (asset.kind !== 'image' || !assetConnectTargetNodeId || asset.nodeId === assetConnectTargetNodeId) {
          return;
        }
        const sourceNode = nodes.find((node) => node.id === asset.nodeId);
        const targetNode = nodes.find((node) => node.id === assetConnectTargetNodeId);
        if (targetNode && nodeHasTargetHandle(targetNode.type)) {
          const canConnectExistingSource =
            sourceNode &&
            asset.id === `${sourceNode.id}:image` &&
            (
              sourceNode.type === CANVAS_NODE_TYPES.upload ||
              sourceNode.type === CANVAS_NODE_TYPES.imageEdit ||
              sourceNode.type === CANVAS_NODE_TYPES.exportImage
            ) &&
            nodeHasSourceHandle(sourceNode.type);
          const sourceNodeId = canConnectExistingSource
            ? sourceNode.id
            : addNode(CANVAS_NODE_TYPES.exportImage, {
                x: targetNode.position.x - 300,
                y: targetNode.position.y,
              }, {
                displayName: asset.title,
                imageUrl: asset.rawImageUrl,
                previewImageUrl: asset.rawPreviewImageUrl ?? asset.rawImageUrl,
                aspectRatio: asset.aspectRatio ?? '1:1',
                resultKind: 'generic',
              });
          addEdge(sourceNodeId, assetConnectTargetNodeId);
          scheduleCanvasPersist(0);
        }
        setIsAssetPanelOpen(false);
        setAssetPanelMode('browse');
        setAssetConnectTargetNodeId(null);
        setAssetButtonRect(null);
        return;
      }

      const targetNode = nodes.find((node) => node.id === asset.nodeId);
      if (!targetNode) {
        return;
      }

      const size = getNodeSize(targetNode);
      const centerX = targetNode.position.x + size.width / 2;
      const centerY = targetNode.position.y + size.height / 2;
      const currentViewport = reactFlowInstance.getViewport();
      reactFlowInstance.setCenter(centerX, centerY, {
        zoom: Math.max(currentViewport.zoom, 0.85),
        duration: 450,
      });

      applyNodesChange(
        nodes.map((node) => ({
          id: node.id,
          type: 'select',
          selected: node.id === targetNode.id,
        }))
      );
      setSelectedNode(targetNode.id);
      setIsAssetPanelOpen(false);
    },
    [
      addEdge,
      addNode,
      applyNodesChange,
      assetConnectTargetNodeId,
      assetPanelMode,
      nodes,
      reactFlowInstance,
      scheduleCanvasPersist,
      setSelectedNode,
    ]
  );

  const handleRenameAsset = useCallback(
    (asset: CanvasAssetItem, title: string) => {
      const node = nodes.find((item) => item.id === asset.nodeId);
      updateNodeData(asset.nodeId, {
        displayName: title,
        ...(node?.type === CANVAS_NODE_TYPES.exportImage || node?.type === CANVAS_NODE_TYPES.video
          ? { generatedNamingMode: 'custom' as const }
          : {}),
      });
    },
    [nodes, updateNodeData]
  );

  const closeAssetPanel = useCallback(() => {
    setIsAssetPanelOpen(false);
    setAssetPanelMode('browse');
    setAssetConnectTargetNodeId(null);
    setAssetButtonRect(null);
  }, []);

  const handleOpenConnectAssetPanel = useCallback(() => {
    if (!pendingConnectStart || pendingConnectStart.handleType !== 'target') {
      return;
    }
    const targetNode = nodes.find((node) => node.id === pendingConnectStart.nodeId);
    if (!targetNode || targetNode.type !== CANVAS_NODE_TYPES.imageEdit) {
      return;
    }
    const containerRect = wrapperRef.current?.getBoundingClientRect();
    const anchorX = (containerRect?.left ?? 0) + menuPosition.x;
    const anchorY = (containerRect?.top ?? 0) + menuPosition.y;
    setAssetButtonRect(createAssetPanelAnchorRect(anchorX, anchorY));
    setAssetPanelMode('select');
    setAssetConnectTargetNodeId(targetNode.id);
    setIsAssetPanelOpen(true);
    setShowNodeMenu(false);
    setNodeContextMenu(null);
    setMenuAllowedTypes(undefined);
    setPendingConnectStart(null);
    setPreviewConnectionVisual(null);
  }, [menuPosition.x, menuPosition.y, nodes, pendingConnectStart]);

  const showConnectAssetOption = useMemo(() => {
    if (!pendingConnectStart || pendingConnectStart.handleType !== 'target') {
      return false;
    }
    const targetNode = nodes.find((node) => node.id === pendingConnectStart.nodeId);
    return targetNode?.type === CANVAS_NODE_TYPES.imageEdit;
  }, [nodes, pendingConnectStart]);

  useEffect(() => {
    const wrapperElement = wrapperRef.current;
    if (!wrapperElement) {
      return;
    }

    const edgePathSelector = '.react-flow__edge-path, .react-flow__edge-interaction';
    const dragThreshold = 4;

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }

      if (target.closest('.react-flow__edgeupdater')) {
        return;
      }

      const edgePathElement = target.closest(edgePathSelector);
      if (!edgePathElement) {
        return;
      }

      const viewport = reactFlowInstance.getViewport();
      edgePanGestureRef.current = {
        active: true,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startViewportX: viewport.x,
        startViewportY: viewport.y,
        zoom: viewport.zoom,
        moved: false,
      };
      cancelPendingViewportPersist();
    };

    const handlePointerMove = (event: PointerEvent) => {
      const gesture = edgePanGestureRef.current;
      if (!gesture || !gesture.active || event.pointerId !== gesture.pointerId) {
        return;
      }

      const deltaX = event.clientX - gesture.startClientX;
      const deltaY = event.clientY - gesture.startClientY;

      if (!gesture.moved && Math.hypot(deltaX, deltaY) >= dragThreshold) {
        gesture.moved = true;
      }
      if (!gesture.moved) {
        return;
      }

      suppressNextEdgeClickRef.current = true;
      reactFlowInstance.setViewport(
        {
          x: gesture.startViewportX + deltaX,
          y: gesture.startViewportY + deltaY,
          zoom: gesture.zoom,
        },
        { duration: 0 }
      );
    };

    const completeEdgePanGesture = () => {
      const gesture = edgePanGestureRef.current;
      if (!gesture) {
        return;
      }

      edgePanGestureRef.current = null;
      if (!gesture.moved) {
        return;
      }

      const viewport = reactFlowInstance.getViewport();
      setViewportState(viewport);
      const project = getCurrentProject();
      if (!project || isRestoringCanvasRef.current) {
        return;
      }
      saveCurrentProjectViewport(viewport);
    };

    const handlePointerUp = (event: PointerEvent) => {
      const gesture = edgePanGestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
      }
      completeEdgePanGesture();
    };

    const handlePointerCancel = (event: PointerEvent) => {
      const gesture = edgePanGestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
      }
      completeEdgePanGesture();
    };

    wrapperElement.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('pointermove', handlePointerMove, true);
    window.addEventListener('pointerup', handlePointerUp, true);
    window.addEventListener('pointercancel', handlePointerCancel, true);

    return () => {
      wrapperElement.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('pointermove', handlePointerMove, true);
      window.removeEventListener('pointerup', handlePointerUp, true);
      window.removeEventListener('pointercancel', handlePointerCancel, true);
    };
  }, [
    cancelPendingViewportPersist,
    getCurrentProject,
    reactFlowInstance,
    saveCurrentProjectViewport,
    setViewportState,
  ]);

  const selectedNodeIds = useMemo(
    () => nodes.filter((node) => Boolean(node.selected)).map((node) => node.id),
    [nodes]
  );
  const selectedNodes = useMemo(
    () => nodes.filter((node) => selectedNodeIds.includes(node.id)),
    [nodes, selectedNodeIds]
  );
  const selectedGroupNodeIds = useMemo(
    () => selectedNodes
      .filter((node) => node.type === CANVAS_NODE_TYPES.group)
      .map((node) => node.id),
    [selectedNodes]
  );
  const isSingleSelectedGroup = selectedNodeIds.length === 1 && selectedGroupNodeIds.length === 1;
  const selectedGroupChildNodes = useMemo(
    () => {
      if (selectedGroupNodeIds.length === 0) {
        return [];
      }
      const groupIds = new Set(selectedGroupNodeIds);
      return nodes.filter((node) => node.parentId && groupIds.has(node.parentId));
    },
    [nodes, selectedGroupNodeIds]
  );
  const selectedBatchTriggerNodeIds = useMemo(
    () => {
      const ids = new Set<string>();
      [...selectedNodes, ...selectedGroupChildNodes].forEach((node) => {
        if (CANVAS_BATCH_TRIGGER_TYPES.has(node.type)) {
          ids.add(node.id);
        }
      });
      return Array.from(ids);
    },
    [selectedGroupChildNodes, selectedNodes]
  );
  const batchToolbarSelectedCount = isSingleSelectedGroup
    ? Math.max(1, selectedGroupChildNodes.length)
    : selectedNodeIds.length;
  const selectedUploadNodeId = useMemo(() => {
    if (selectedNodeIds.length !== 1) {
      return null;
    }
    const selectedNode = nodes.find((node) => node.id === selectedNodeIds[0]);
    if (!selectedNode || selectedNode.type !== CANVAS_NODE_TYPES.upload) {
      return null;
    }
    return selectedNode.id;
  }, [currentViewport, nodes, selectedNodeIds]);

  useEffect(() => {
    if (selectedNodeIds.length <= 1 && !isSingleSelectedGroup) {
      setBatchToolbarPosition(null);
      setSelectionBoundsRect(null);
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const containerRect = wrapperRef.current?.getBoundingClientRect();
      if (!containerRect) {
        setBatchToolbarPosition(null);
        setSelectionBoundsRect(null);
        return;
      }

      let minLeft = Number.POSITIVE_INFINITY;
      let minTop = Number.POSITIVE_INFINITY;
      let maxRight = Number.NEGATIVE_INFINITY;
      let maxBottom = Number.NEGATIVE_INFINITY;
      let hasRect = false;

      const boundsNodeIds = collectNodeIdsWithDescendants(nodes, selectedNodeIds);
      for (const nodeId of boundsNodeIds) {
        const nodeElement = wrapperRef.current?.querySelector<HTMLElement>(
          `.react-flow__node[data-id="${escapeNodeDataId(nodeId)}"]`
        );
        if (!nodeElement) {
          continue;
        }
        const rect = nodeElement.getBoundingClientRect();
        minLeft = Math.min(minLeft, rect.left);
        minTop = Math.min(minTop, rect.top);
        maxRight = Math.max(maxRight, rect.right);
        maxBottom = Math.max(maxBottom, rect.bottom);
        hasRect = true;
      }

      if (!hasRect) {
        setBatchToolbarPosition(null);
        setSelectionBoundsRect(null);
        return;
      }

      setSelectionBoundsRect({
        left: Math.max(0, minLeft - containerRect.left),
        top: Math.max(0, minTop - containerRect.top),
        width: Math.max(0, maxRight - minLeft),
        height: Math.max(0, maxBottom - minTop),
      });
      setBatchToolbarPosition({
        left: Math.max(12, Math.min(containerRect.width - 12, (minLeft + maxRight) / 2 - containerRect.left)),
        top: Math.max(12, minTop - containerRect.top - 42),
      });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [currentViewport, isSingleSelectedGroup, nodes, selectedNodeIds]);

  const selectSingleNode = useCallback((nodeId: string | null) => {
    applyNodesChange(
      nodesRef.current.map((node) => ({
        id: node.id,
        type: 'select',
        selected: node.id === nodeId,
      }))
    );
    setSelectedNode(nodeId);
  }, [applyNodesChange, setSelectedNode]);

  const openNodeContextMenuAtClientPosition = useCallback((nodeId: string, clientX: number, clientY: number) => {
    const containerRect = wrapperRef.current?.getBoundingClientRect();
    if (!containerRect) {
      return;
    }
    const flowPosition = reactFlowInstance.screenToFlowPosition({
      x: clientX,
      y: clientY,
    });
    selectSingleNode(nodeId);
    setNodeContextMenu({
      nodeId,
      position: {
        x: clientX - containerRect.left,
        y: clientY - containerRect.top,
      },
      flowPosition,
    });
    setShowNodeMenu(false);
    setMenuAllowedTypes(undefined);
    setPendingConnectStart(null);
    setPreviewConnectionVisual(null);
  }, [reactFlowInstance, selectSingleNode]);

  const selectNodesInMarquee = useCallback((gesture: CanvasMarqueeGesture) => {
    const selectionClientRect = {
      left: Math.min(gesture.startClientX, gesture.currentClientX),
      top: Math.min(gesture.startClientY, gesture.currentClientY),
      right: Math.max(gesture.startClientX, gesture.currentClientX),
      bottom: Math.max(gesture.startClientY, gesture.currentClientY),
    };
    const nextSelectedIds = nodesRef.current
      .filter((node) => {
        const nodeElement = wrapperRef.current?.querySelector<HTMLElement>(
          `.react-flow__node[data-id="${escapeNodeDataId(node.id)}"]`
        );
        if (!nodeElement) {
          return false;
        }
        const nodeRect = nodeElement.getBoundingClientRect();
        return rectsOverlap(selectionClientRect, {
          left: nodeRect.left,
          top: nodeRect.top,
          right: nodeRect.right,
          bottom: nodeRect.bottom,
        });
      })
      .map((node) => node.id);

    const nextSelectedSet = new Set(nextSelectedIds);
    const selectionChanges: NodeChange<CanvasNode>[] = nodesRef.current.map((node) => ({
      id: node.id,
      type: 'select',
      selected: nextSelectedSet.has(node.id),
    }));
    applyNodesChange(selectionChanges);
    setSelectedNode(nextSelectedIds.length === 1 ? nextSelectedIds[0] : null);
  }, [applyNodesChange, setSelectedNode]);

  useEffect(() => {
    const wrapperElement = wrapperRef.current;
    if (!wrapperElement) {
      return;
    }

    const clearMarqueeGesture = () => {
      marqueeGestureRef.current = null;
      setMarqueeRect(null);
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (
        !isCanvasMouseButton(event.button) ||
        getCanvasMouseAction(canvasMouseBindings, event.button, 'drag') !== 'selectionBox' ||
        shouldIgnoreCanvasMarqueeTarget(event.target)
      ) {
        return;
      }

      const startNodeId = getCanvasNodeIdFromTarget(event.target);
      if (event.button === 0 && startNodeId) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      marqueeGestureRef.current = {
        pointerId: event.pointerId,
        button: event.button,
        startClientX: event.clientX,
        startClientY: event.clientY,
        currentClientX: event.clientX,
        currentClientY: event.clientY,
        moved: false,
        startNodeId,
      };
      setShowNodeMenu(false);
      setNodeContextMenu(null);
      setMenuAllowedTypes(undefined);
      setPendingConnectStart(null);
      setPreviewConnectionVisual(null);
    };

    const handlePointerMove = (event: PointerEvent) => {
      const gesture = marqueeGestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      gesture.currentClientX = event.clientX;
      gesture.currentClientY = event.clientY;

      const dragDistance = Math.hypot(
        gesture.currentClientX - gesture.startClientX,
        gesture.currentClientY - gesture.startClientY
      );
      if (!gesture.moved && dragDistance < CANVAS_MARQUEE_MIN_DISTANCE) {
        return;
      }

      gesture.moved = true;
      const containerRect = wrapperElement.getBoundingClientRect();
      setMarqueeRect(normalizeClientRect(
        gesture.startClientX,
        gesture.startClientY,
        gesture.currentClientX,
        gesture.currentClientY,
        containerRect
      ));
    };

    const handlePointerUp = (event: PointerEvent) => {
      const gesture = marqueeGestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (gesture.moved) {
        selectNodesInMarquee(gesture);
      } else if (
        gesture.startNodeId &&
        getCanvasMouseAction(canvasMouseBindings, gesture.button, 'click') === 'nodeMenu'
      ) {
        openNodeContextMenuAtClientPosition(gesture.startNodeId, event.clientX, event.clientY);
      }
      clearMarqueeGesture();
    };

    const handlePointerCancel = (event: PointerEvent) => {
      const gesture = marqueeGestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      clearMarqueeGesture();
    };

    wrapperElement.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('pointermove', handlePointerMove, true);
    window.addEventListener('pointerup', handlePointerUp, true);
    window.addEventListener('pointercancel', handlePointerCancel, true);

    return () => {
      wrapperElement.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('pointermove', handlePointerMove, true);
      window.removeEventListener('pointerup', handlePointerUp, true);
      window.removeEventListener('pointercancel', handlePointerCancel, true);
    };
  }, [canvasMouseBindings, openNodeContextMenuAtClientPosition, selectNodesInMarquee]);

  const createUploadImageNodeAtFlowPosition = useCallback(
    async (file: File, flowPosition: { x: number; y: number }) => {
      try {
        const prepared = await prepareNodeImageFromFile(file);
        const newNodeId = addNode(
          CANVAS_NODE_TYPES.upload,
          flowPosition,
          {
            imageUrl: prepared.imageUrl,
            previewImageUrl: prepared.previewImageUrl,
            aspectRatio: prepared.aspectRatio || '1:1',
            sourceFileName: file.name,
          }
        );
        setSelectedNode(newNodeId);
        scheduleCanvasPersist(0);
        return newNodeId;
      } catch (error) {
        console.error('Failed to import image onto canvas', error);
        return null;
      }
    },
    [addNode, scheduleCanvasPersist, setSelectedNode]
  );

  const createUploadImageNodeAtClientPosition = useCallback(
    async (file: File, clientPosition: { x: number; y: number }) => {
      await createUploadImageNodeAtFlowPosition(
        file,
        reactFlowInstance.screenToFlowPosition(clientPosition)
      );
    },
    [createUploadImageNodeAtFlowPosition, reactFlowInstance]
  );

  const pasteImageAtCanvasPosition = useCallback(
    async (file: File) => {
      const containerRect = wrapperRef.current?.getBoundingClientRect();
      const clientPosition = lastCanvasPointerRef.current ?? (
        containerRect
          ? {
              x: containerRect.left + containerRect.width / 2,
              y: containerRect.top + containerRect.height / 2,
            }
          : {
              x: window.innerWidth / 2,
              y: window.innerHeight / 2,
            }
      );
      await createUploadImageNodeAtClientPosition(file, clientPosition);
    },
    [createUploadImageNodeAtClientPosition]
  );

  const resolveShortcutPasteFlowPosition = useCallback(() => {
    const containerRect = wrapperRef.current?.getBoundingClientRect();
    const clientPosition = lastCanvasPointerRef.current ?? (
      containerRect
        ? {
            x: containerRect.left + containerRect.width / 2,
            y: containerRect.top + containerRect.height / 2,
          }
        : {
            x: window.innerWidth / 2,
            y: window.innerHeight / 2,
          }
    );
    return reactFlowInstance.screenToFlowPosition(clientPosition);
  }, [reactFlowInstance]);

  useEffect(() => {
    const handleWindowFileDragOver = (event: DragEvent) => {
      if (!dataTransferHasFile(event.dataTransfer)) {
        return;
      }

      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = dataTransferHasImageFile(event.dataTransfer)
          ? 'copy'
          : 'none';
      }
    };

    const handleWindowFileDrop = (event: DragEvent) => {
      if (!dataTransferHasFile(event.dataTransfer)) {
        return;
      }

      event.preventDefault();
    };

    window.addEventListener('dragover', handleWindowFileDragOver, true);
    window.addEventListener('drop', handleWindowFileDrop, true);

    return () => {
      window.removeEventListener('dragover', handleWindowFileDragOver, true);
      window.removeEventListener('drop', handleWindowFileDrop, true);
    };
  }, []);

  const handleCanvasDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!dataTransferHasFile(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = dataTransferHasImageFile(event.dataTransfer)
      ? 'copy'
      : 'none';
  }, []);

  const handleCanvasDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!dataTransferHasFile(event.dataTransfer)) {
        return;
      }

      event.preventDefault();
      const file = resolveDroppedImageFile(event.dataTransfer);
      if (!file) {
        return;
      }

      void createUploadImageNodeAtClientPosition(file, {
        x: event.clientX,
        y: event.clientY,
      });
    },
    [createUploadImageNodeAtClientPosition]
  );

  const handleCanvasPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    lastCanvasPointerRef.current = {
      x: event.clientX,
      y: event.clientY,
    };
    if (!pendingConnectStart) {
      return;
    }

    const now = Date.now();
    if (now - lastConnectSelectionClearAtRef.current < 50) {
      return;
    }
    lastConnectSelectionClearAtRef.current = now;
    clearBrowserTextSelection();
  }, [pendingConnectStart]);

  const handleCanvasPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (shouldIgnoreCanvasMarqueeTarget(event.target)) {
      return;
    }
    wrapperRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (pendingConnectStart) {
      pendingConnectWasActiveRef.current = true;
      return;
    }

    if (!pendingConnectWasActiveRef.current) {
      return;
    }

    pendingConnectWasActiveRef.current = false;
    lastConnectSelectionClearAtRef.current = 0;
    clearBrowserTextSelection();
    window.requestAnimationFrame(() => clearBrowserTextSelection());
  }, [pendingConnectStart]);

  const handleCanvasContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (shouldIgnoreCanvasMarqueeTarget(event.target)) {
      return;
    }
    event.stopPropagation();
    event.preventDefault();

    if (getCanvasNodeIdFromTarget(event.target)) {
      blankCanvasRightClickRef.current = null;
      return;
    }

    setShowNodeMenu(false);
    setMenuAllowedTypes(undefined);
    setPendingConnectStart(null);
    setPreviewConnectionVisual(null);

    if (event.button !== 2) {
      blankCanvasRightClickRef.current = null;
      setNodeContextMenu(null);
      return;
    }

    const previousRightClick = blankCanvasRightClickRef.current;
    const elapsedMs = previousRightClick
      ? event.timeStamp - previousRightClick.timeStamp
      : Number.POSITIVE_INFINITY;
    const distancePx = previousRightClick
      ? Math.hypot(
          event.clientX - previousRightClick.clientX,
          event.clientY - previousRightClick.clientY
        )
      : Number.POSITIVE_INFINITY;
    const isDoubleRightClick = elapsedMs >= 0
      && elapsedMs <= BLANK_CANVAS_CONTEXT_MENU_DOUBLE_CLICK_MS
      && distancePx <= BLANK_CANVAS_CONTEXT_MENU_DOUBLE_CLICK_DISTANCE;

    if (!isDoubleRightClick) {
      blankCanvasRightClickRef.current = {
        timeStamp: event.timeStamp,
        clientX: event.clientX,
        clientY: event.clientY,
      };
      setNodeContextMenu(null);
      return;
    }

    blankCanvasRightClickRef.current = null;
    const containerRect = wrapperRef.current?.getBoundingClientRect();
    if (!containerRect) {
      return;
    }
    setNodeContextMenu({
      nodeId: null,
      position: {
        x: event.clientX - containerRect.left,
        y: event.clientY - containerRect.top,
      },
      flowPosition: reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      }),
    });
  }, [reactFlowInstance]);

  const handleBatchGroup = useCallback(() => {
    const groupedNodeId = groupNodes(selectedNodeIds);
    if (!groupedNodeId) {
      return;
    }
    scheduleCanvasPersist(0);
  }, [groupNodes, scheduleCanvasPersist, selectedNodeIds]);

  const handleBatchUngroup = useCallback(() => {
    let changed = false;
    for (const groupNodeId of selectedGroupNodeIds) {
      changed = ungroupNode(groupNodeId) || changed;
    }
    if (changed) {
      scheduleCanvasPersist(0);
    }
  }, [scheduleCanvasPersist, selectedGroupNodeIds, ungroupNode]);

  const handleBatchTrigger = useCallback(() => {
    selectedBatchTriggerNodeIds.forEach((nodeId) => {
      canvasEventBus.publish('generation-node/trigger', { nodeId });
    });
  }, [selectedBatchTriggerNodeIds]);

  const handleBatchDelete = useCallback(() => {
    deleteNodes(selectedNodeIds);
    scheduleCanvasPersist(0);
  }, [deleteNodes, scheduleCanvasPersist, selectedNodeIds]);

  useEffect(() => {
    if (selectedNodeIds.length === 1) {
      if (selectedNodeId !== selectedNodeIds[0]) {
        setSelectedNode(selectedNodeIds[0]);
      }
      return;
    }

    if (selectedNodeId !== null) {
      setSelectedNode(null);
    }
  }, [selectedNodeId, selectedNodeIds, setSelectedNode]);

  const openNodeMenuAtClientPosition = useCallback((clientX: number, clientY: number) => {
    const containerRect = wrapperRef.current?.getBoundingClientRect();
    if (!containerRect) {
      return;
    }

    const flowPos = reactFlowInstance.screenToFlowPosition({
      x: clientX,
      y: clientY,
    });

    setFlowPosition(flowPos);
    setMenuPosition({
      x: clientX - containerRect.left,
      y: clientY - containerRect.top,
    });
    setNodeContextMenu(null);
    setMenuAllowedTypes(undefined);
    setPendingConnectStart(null);
    setPreviewConnectionVisual(null);
    setShowNodeMenu(true);
  }, [reactFlowInstance]);

  const handlePaneClick = useCallback((event: ReactMouseEvent) => {
    if (suppressNextPaneClickRef.current) {
      suppressNextPaneClickRef.current = false;
      return;
    }

    if (event.detail >= 2) {
      openNodeMenuAtClientPosition(event.clientX, event.clientY);
      return;
    }

    setSelectedNode(null);
    setIsAssetPanelOpen(false);
    setShowNodeMenu(false);
    setNodeContextMenu(null);
    setMenuAllowedTypes(undefined);
    setPendingConnectStart(null);
    setPreviewConnectionVisual(null);
  }, [openNodeMenuAtClientPosition, setSelectedNode]);

  const handleNodeSelect = useCallback(
    (type: CanvasNodeType) => {
      const newNodeId = addNode(type, flowPosition);
      if (pendingConnectStart) {
        if (pendingConnectStart.handleType === 'source') {
          connectNodes({
            source: pendingConnectStart.nodeId,
            target: newNodeId,
            sourceHandle: 'source',
            targetHandle: 'target',
          });
          if (type === CANVAS_NODE_TYPES.textAnnotation) {
            const sourceNode = useCanvasStore.getState().nodes.find((node) => node.id === pendingConnectStart.nodeId);
            if (sourceNode) {
              const sourceText = getGeneratedTextForConnection(sourceNode, useCanvasStore.getState().nodes);
              if (sourceText) {
                updateNodeData(newNodeId, { content: sourceText } as Partial<CanvasNodeData>);
              }
            }
          }
        } else {
          connectNodes({
            source: newNodeId,
            target: pendingConnectStart.nodeId,
            sourceHandle: 'source',
            targetHandle: 'target',
          });
        }
      }

      scheduleCanvasPersist(0);
      setShowNodeMenu(false);
      setNodeContextMenu(null);
      setMenuAllowedTypes(undefined);
      setPendingConnectStart(null);
      setPreviewConnectionVisual(null);
    },
    [
      addNode,
      connectNodes,
      flowPosition,
      pendingConnectStart,
      scheduleCanvasPersist,
      setPreviewConnectionVisual,
      updateNodeData,
    ]
  );

  const createClipboardSnapshot = useCallback(
    (sourceNodeIds: string[]): CanvasClipboardSnapshot | null => {
      const expandedIds = collectNodeIdsWithDescendants(nodes, sourceNodeIds);
      if (expandedIds.length === 0) {
        return null;
      }

      const sourceIdSet = new Set(expandedIds);
      const snapshotNodes = nodes
        .filter((node) => sourceIdSet.has(node.id))
        .map((node) => cloneNodeData(node));
      if (snapshotNodes.length === 0) {
        return null;
      }

      return {
        nodes: snapshotNodes,
        edges: edges
          .filter((edge) => sourceIdSet.has(edge.source) && sourceIdSet.has(edge.target))
          .map((edge) => cloneNodeData(edge)),
      };
    },
    [edges, nodes]
  );

  const copyNodesToClipboard = useCallback(
    (sourceNodeIds: string[]) => {
      const snapshot = createClipboardSnapshot(sourceNodeIds);
      copiedSnapshotRef.current = snapshot;
      if (snapshot?.nodes.length) {
        clipboardFreshnessRef.current = 'internal';
        pasteIterationRef.current = 0;
        systemClipboardFingerprintAtInternalCopyRef.current = undefined;
        const capture = syncSingleCanvasNodeToSystemClipboard(snapshot, nodes)
          .catch((error) => {
            console.warn('Failed to capture clipboard freshness baseline', error);
            return null;
          });
        systemClipboardFingerprintCaptureRef.current = capture;
        void capture.then((fingerprint) => {
          if (
            systemClipboardFingerprintCaptureRef.current === capture
            && copiedSnapshotRef.current === snapshot
            && clipboardFreshnessRef.current === 'internal'
          ) {
            systemClipboardFingerprintAtInternalCopyRef.current = fingerprint;
          }
        });
      }
    },
    [createClipboardSnapshot, nodes]
  );

  const markSystemClipboardFresh = useCallback(() => {
    clipboardFreshnessRef.current = 'system';
    systemClipboardFingerprintAtInternalCopyRef.current = null;
    systemClipboardFingerprintCaptureRef.current = null;
  }, []);

  const resolveClipboardPasteSource = useCallback(async (): Promise<ClipboardPasteSource> => {
    const hasInternalSnapshot = Boolean(copiedSnapshotRef.current?.nodes.length);
    const internalIsFresh = clipboardFreshnessRef.current === 'internal' && hasInternalSnapshot;
    const clipboardContent = await readClipboardContent();

    if (internalIsFresh) {
      let baselineFingerprint = systemClipboardFingerprintAtInternalCopyRef.current;
      const capture = systemClipboardFingerprintCaptureRef.current;
      if (baselineFingerprint === undefined && capture) {
        baselineFingerprint = await capture;
        if (systemClipboardFingerprintCaptureRef.current === capture) {
          systemClipboardFingerprintAtInternalCopyRef.current = baselineFingerprint;
        }
      }

      if (
        clipboardContent.fingerprint
        && baselineFingerprint !== undefined
        && clipboardContent.fingerprint !== baselineFingerprint
      ) {
        markSystemClipboardFresh();
        return { source: 'system', content: clipboardContent };
      }
      if (clipboardContent.fingerprint && baselineFingerprint === undefined) {
        markSystemClipboardFresh();
        return { source: 'system', content: clipboardContent };
      }
      return { source: 'internal' };
    }

    if (clipboardContent.imageFile) {
      markSystemClipboardFresh();
      return { source: 'system', content: clipboardContent };
    }

    if (clipboardContent.fingerprint) {
      markSystemClipboardFresh();
      return { source: 'system', content: clipboardContent };
    }

    return { source: 'none' };
  }, [markSystemClipboardFresh]);

  const duplicateSnapshot = useCallback(
    (snapshot: CanvasClipboardSnapshot, options: DuplicateOptions = {}) => {
      const sourceNodes = sortNodesForDuplication(snapshot.nodes);
      if (sourceNodes.length === 0) {
        return null as DuplicateResult | null;
      }

      const sourceNodeMap = new Map(sourceNodes.map((node) => [node.id, node] as const));
      const sourceIdSet = new Set(sourceNodes.map((node) => node.id));
      const internalEdges = snapshot.edges.filter(
        (edge) => sourceIdSet.has(edge.source) && sourceIdSet.has(edge.target)
      );

      const baseOffsets = [
        { x: 44, y: 30 },
        { x: 72, y: 8 },
        { x: 18, y: 68 },
        { x: 96, y: 42 },
      ];
      const existingNodes = useCanvasStore.getState().nodes;
      const ignoreNodeIds = new Set<string>();
      const offsetStep = options.disableOffsetIteration ? 0 : pasteIterationRef.current;
      let chosenOffset = options.explicitOffset ?? baseOffsets[0];

      const isOffsetAvailable = (offset: { x: number; y: number }) => sourceNodes.every((node) => {
        const size = getNodeSize(node);
        const absolute = resolveAbsoluteNodePosition(node, sourceNodeMap);
        return !hasRectCollision(
          {
            x: absolute.x + offset.x + offsetStep * 8,
            y: absolute.y + offset.y + offsetStep * 6,
            width: size.width,
            height: size.height,
          },
          existingNodes,
          ignoreNodeIds
        );
      });

      if (!options.explicitOffset) {
        const matchedBaseOffset = baseOffsets.find((offset) => isOffsetAvailable(offset));
        if (matchedBaseOffset) {
          chosenOffset = matchedBaseOffset;
        } else {
          const maxStep = 16;
          for (let step = 1; step <= maxStep; step += 1) {
            const candidate = { x: 24 + step * 26, y: 16 + step * 18 };
            if (isOffsetAvailable(candidate)) {
              chosenOffset = candidate;
              break;
            }
          }
        }
      }

      const idMap = new Map<string, string>();
      const sizeMap = new Map<string, { width: number; height: number }>();
      for (const sourceNode of sourceNodes) {
        const data = cloneNodeData(sourceNode.data);
        if ('isGenerating' in (data as Record<string, unknown>)) {
          (data as { isGenerating?: boolean }).isGenerating = false;
        }
        if ('isStreaming' in (data as Record<string, unknown>)) {
          (data as { isStreaming?: boolean }).isStreaming = false;
        }
        if ('generationStartedAt' in (data as Record<string, unknown>)) {
          (data as { generationStartedAt?: number | null }).generationStartedAt = null;
        }
        if ('generationJobId' in (data as Record<string, unknown>)) {
          (data as { generationJobId?: string | null }).generationJobId = null;
        }
        if ('generationProviderId' in (data as Record<string, unknown>)) {
          (data as { generationProviderId?: string | null }).generationProviderId = null;
        }
        if ('generationClientSessionId' in (data as Record<string, unknown>)) {
          (data as { generationClientSessionId?: string | null }).generationClientSessionId = null;
        }
        if ('generationStoryboardMetadata' in (data as Record<string, unknown>)) {
          (data as { generationStoryboardMetadata?: unknown }).generationStoryboardMetadata = undefined;
        }
        if ('generationError' in (data as Record<string, unknown>)) {
          (data as { generationError?: string | null }).generationError = null;
        }
        if ('generationErrorDetails' in (data as Record<string, unknown>)) {
          (data as { generationErrorDetails?: string | null }).generationErrorDetails = null;
        }
        if ('generationDebugContext' in (data as Record<string, unknown>)) {
          (data as { generationDebugContext?: unknown }).generationDebugContext = undefined;
        }
        if ('generationRetryResultUrl' in (data as Record<string, unknown>)) {
          (data as { generationRetryResultUrl?: string | null }).generationRetryResultUrl = null;
        }

        const copiedParentId = sourceNode.parentId && sourceIdSet.has(sourceNode.parentId)
          ? sourceNode.parentId
          : null;
        const absolute = resolveAbsoluteNodePosition(sourceNode, sourceNodeMap);
        const nextNodeId = addNode(
          sourceNode.type as CanvasNodeType,
          copiedParentId
            ? sourceNode.position
            : {
                x: absolute.x + chosenOffset.x + offsetStep * 8,
                y: absolute.y + chosenOffset.y + offsetStep * 6,
              },
          { ...data }
        );
        idMap.set(sourceNode.id, nextNodeId);
        sizeMap.set(nextNodeId, getNodeSize(sourceNode));
      }

      const sizeSyncChanges = Array.from(sizeMap.entries()).map(([nodeId, size]) => ({
        id: nodeId,
        type: 'dimensions' as const,
        dimensions: { width: size.width, height: size.height },
        resizing: false,
        setAttributes: true,
      }));
      if (sizeSyncChanges.length > 0) {
        applyNodesChange(sizeSyncChanges);
      }

      useCanvasStore.setState((state) => ({
        nodes: state.nodes.map((currentNode) => {
          const sourceEntry = Array.from(idMap.entries()).find(([, copyId]) => copyId === currentNode.id);
          if (!sourceEntry) {
            return currentNode;
          }

          const [sourceId] = sourceEntry;
          const sourceNode = sourceNodeMap.get(sourceId);
          if (!sourceNode) {
            return currentNode;
          }

          const copiedParentId = sourceNode.parentId ? idMap.get(sourceNode.parentId) : undefined;
          const sourceStyle = sourceNode.style && typeof sourceNode.style === 'object'
            ? cloneNodeData(sourceNode.style)
            : undefined;

          return {
            ...currentNode,
            parentId: copiedParentId,
            extent: copiedParentId ? (sourceNode.extent ?? 'parent') : undefined,
            selected: false,
            style: {
              ...(currentNode.style ?? {}),
              ...(sourceStyle ?? {}),
            },
          };
        }),
      }));

      if (internalEdges.length > 0) {
        useCanvasStore.setState((state) => {
          const existingEdgeIds = new Set(state.edges.map((edge) => edge.id));
          const duplicatedEdges = internalEdges
            .map((edge) => {
              const nextSource = idMap.get(edge.source);
              const nextTarget = idMap.get(edge.target);
              if (!nextSource || !nextTarget) {
                return null;
              }
              return buildDuplicateEdge(edge, nextSource, nextTarget, existingEdgeIds);
            })
            .filter((edge): edge is CanvasEdge => Boolean(edge));
          if (duplicatedEdges.length === 0) {
            return state;
          }
          return {
            edges: [...state.edges, ...duplicatedEdges],
          };
        });
      }

      if (!options.disableOffsetIteration) {
        pasteIterationRef.current += 1;
      }
      const firstNodeId = idMap.get(sourceNodes[0].id) ?? null;
      if (firstNodeId && !options.suppressSelect) {
        setSelectedNode(firstNodeId);
      }
      if (!options.suppressPersist) {
        scheduleCanvasPersist(0);
      }
      return { firstNodeId, idMap };
    },
    [addNode, applyNodesChange, scheduleCanvasPersist, setSelectedNode]
  );

  const duplicateNodes = useCallback(
    (sourceNodeIds: string[], options: DuplicateOptions = {}) => {
      const snapshot = createClipboardSnapshot(sourceNodeIds);
      if (!snapshot) {
        return null as DuplicateResult | null;
      }
      return duplicateSnapshot(snapshot, options);
    },
    [createClipboardSnapshot, duplicateSnapshot]
  );

  const pasteCopiedNodes = useCallback(
    (flowPosition?: { x: number; y: number }) => {
      const snapshot = copiedSnapshotRef.current;
      if (!snapshot || snapshot.nodes.length === 0) {
        return null as DuplicateResult | null;
      }

      const bounds = flowPosition ? getSnapshotBounds(snapshot) : null;
      const targetOffset = flowPosition && bounds
        ? {
            x: flowPosition.x - bounds.minX,
            y: flowPosition.y - bounds.minY,
          }
        : null;
      return duplicateSnapshot(
        snapshot,
        targetOffset
          ? {
              explicitOffset: targetOffset,
              disableOffsetIteration: true,
            }
          : undefined
      );
    },
    [duplicateSnapshot]
  );

  const handleBatchCopy = useCallback(() => {
    if (selectedNodeIds.length === 0) {
      return;
    }
    copyNodesToClipboard(selectedNodeIds);
    setNodeContextMenu(null);
  }, [copyNodesToClipboard, selectedNodeIds]);

  const handleNodeContextMenuCopy = useCallback(() => {
    if (!nodeContextMenu?.nodeId) {
      return;
    }
    copyNodesToClipboard([nodeContextMenu.nodeId]);
    setNodeContextMenu(null);
  }, [copyNodesToClipboard, nodeContextMenu]);

  const pasteImageAsNodeReference = useCallback(
    async (file: File, targetNode: CanvasNode) => {
      const uploadNodeId = await createUploadImageNodeAtFlowPosition(file, {
        x: targetNode.position.x - 300,
        y: targetNode.position.y,
      });
      if (!uploadNodeId) {
        return false;
      }
      addEdge(uploadNodeId, targetNode.id);
      scheduleCanvasPersist(0);
      return true;
    },
    [addEdge, createUploadImageNodeAtFlowPosition, scheduleCanvasPersist]
  );

  const pasteVideoSourceAsNodeReference = useCallback(
    (videoSource: string, targetNode: CanvasNode) => {
      const trimmedSource = videoSource.trim();
      if (!isLikelyVideoSourceText(trimmedSource)) {
        return false;
      }
      const videoNodeId = addNode(
        CANVAS_NODE_TYPES.video,
        {
          x: targetNode.position.x - 300,
          y: targetNode.position.y,
        },
        {
          videoUrl: trimmedSource,
          localVideoUrl: trimmedSource.startsWith('http://') || trimmedSource.startsWith('https://')
            ? null
            : trimmedSource,
          thumbnailUrl: null,
          isGenerating: false,
          sourcePrompt: '',
        }
      );
      addEdge(videoNodeId, targetNode.id);
      scheduleCanvasPersist(0);
      return true;
    },
    [addEdge, addNode, scheduleCanvasPersist]
  );

  const pasteTextIntoPromptNode = useCallback(
    (targetNode: CanvasNode, text: string) => {
      const trimmedText = text.trim();
      if (!trimmedText) {
        return false;
      }
      const data = targetNode.data as { prompt?: unknown };
      const currentPrompt = typeof data.prompt === 'string' ? data.prompt.trim() : '';
      updateNodeData(targetNode.id, {
        prompt: currentPrompt ? `${currentPrompt}\n${trimmedText}` : trimmedText,
      } as Partial<CanvasNodeData>);
      scheduleCanvasPersist(0);
      return true;
    },
    [scheduleCanvasPersist, updateNodeData]
  );

  const pasteTextIntoTextNode = useCallback(
    (targetNode: CanvasNode, text: string) => {
      if (targetNode.type !== CANVAS_NODE_TYPES.textAnnotation) {
        return false;
      }
      const trimmedText = text.trim();
      if (!trimmedText) {
        return false;
      }
      const currentContent = (targetNode.data as { content?: unknown }).content;
      const normalizedCurrent = typeof currentContent === 'string' ? currentContent.trim() : '';
      updateNodeData(targetNode.id, {
        content: normalizedCurrent ? `${normalizedCurrent}\n${trimmedText}` : trimmedText,
      } as Partial<CanvasNodeData>);
      scheduleCanvasPersist(0);
      return true;
    },
    [scheduleCanvasPersist, updateNodeData]
  );

  const pasteTextAsTextNode = useCallback(
    (text: string, flowPosition?: { x: number; y: number }) => {
      const trimmedText = text.trim();
      if (!trimmedText) {
        return false;
      }
      addNode(
        CANVAS_NODE_TYPES.textAnnotation,
        flowPosition ?? resolveShortcutPasteFlowPosition(),
        {
          content: trimmedText,
        }
      );
      scheduleCanvasPersist(0);
      return true;
    },
    [addNode, resolveShortcutPasteFlowPosition, scheduleCanvasPersist]
  );

  const pasteSystemClipboardContent = useCallback(
    async (
      clipboardContent: ClipboardContentReadResult,
      options: SystemClipboardPasteOptions
    ) => {
      const targetNode = options.targetNode;
      const isPromptPasteTarget = targetNode?.type === CANVAS_NODE_TYPES.imageEdit
        || targetNode?.type === CANVAS_NODE_TYPES.aiVideo
        || targetNode?.type === CANVAS_NODE_TYPES.aiText;
      const isTextPasteTarget = targetNode?.type === CANVAS_NODE_TYPES.textAnnotation;
      const imageFile = clipboardContent.imageFile;

      if (imageFile && options.pasteIntoSelectedUpload && targetNode?.type === CANVAS_NODE_TYPES.upload) {
        canvasEventBus.publish('upload-node/paste-image', {
          nodeId: targetNode.id,
          file: imageFile,
        });
        markSystemClipboardFresh();
        return true;
      }

      if (isPromptPasteTarget && targetNode) {
        if (imageFile) {
          const handled = await pasteImageAsNodeReference(imageFile, targetNode);
          if (handled) {
            markSystemClipboardFresh();
            return true;
          }
        }

        if (pasteVideoSourceAsNodeReference(clipboardContent.text, targetNode)) {
          markSystemClipboardFresh();
          return true;
        }

        if (pasteTextIntoPromptNode(targetNode, clipboardContent.text)) {
          markSystemClipboardFresh();
          return true;
        }
      }

      if (isTextPasteTarget && targetNode && pasteTextIntoTextNode(targetNode, clipboardContent.text)) {
        markSystemClipboardFresh();
        return true;
      }

      if (imageFile) {
        if (options.flowPosition) {
          const createdNodeId = await createUploadImageNodeAtFlowPosition(imageFile, options.flowPosition);
          if (createdNodeId) {
            markSystemClipboardFresh();
            return true;
          }
          return false;
        }

        await pasteImageAtCanvasPosition(imageFile);
        markSystemClipboardFresh();
        return true;
      }

      if (pasteTextAsTextNode(clipboardContent.text, options.flowPosition)) {
        markSystemClipboardFresh();
        return true;
      }

      return false;
    },
    [
      createUploadImageNodeAtFlowPosition,
      markSystemClipboardFresh,
      pasteImageAsNodeReference,
      pasteImageAtCanvasPosition,
      pasteTextAsTextNode,
      pasteTextIntoPromptNode,
      pasteTextIntoTextNode,
      pasteVideoSourceAsNodeReference,
    ]
  );

  const handleShortcutPaste = useCallback(async () => {
    const pasteSource = await resolveClipboardPasteSource();
    if (pasteSource.source === 'internal') {
      return Boolean(pasteCopiedNodes(resolveShortcutPasteFlowPosition()));
    }
    if (pasteSource.source !== 'system') {
      return false;
    }

    const selectedTargetNode = selectedNodeId
      ? useCanvasStore.getState().nodes.find((node) => node.id === selectedNodeId) ?? null
      : null;
    return await pasteSystemClipboardContent(pasteSource.content, {
      targetNode: selectedTargetNode,
      flowPosition: resolveShortcutPasteFlowPosition(),
      pasteIntoSelectedUpload: Boolean(
        selectedUploadNodeId && selectedTargetNode?.id === selectedUploadNodeId
      ),
    });
  }, [
    pasteCopiedNodes,
    pasteSystemClipboardContent,
    resolveClipboardPasteSource,
    resolveShortcutPasteFlowPosition,
    selectedNodeId,
    selectedUploadNodeId,
  ]);

  const pasteImageFromClipboardEvent = useCallback(async (file: File) => {
    const selectedTargetNode = selectedNodeId
      ? useCanvasStore.getState().nodes.find((node) => node.id === selectedNodeId) ?? null
      : null;
    await pasteSystemClipboardContent(
      {
        imageFile: file,
        text: '',
        fingerprint: `event-image:${file.name}:${file.size}:${file.type}:${file.lastModified}`,
      },
      {
        targetNode: selectedTargetNode,
        pasteIntoSelectedUpload: Boolean(
          selectedUploadNodeId && selectedTargetNode?.id === selectedUploadNodeId
        ),
      }
    );
  }, [pasteSystemClipboardContent, selectedNodeId, selectedUploadNodeId]);

  const pasteTextFromClipboardEvent = useCallback(async (text: string) => {
    const selectedTargetNode = selectedNodeId
      ? useCanvasStore.getState().nodes.find((node) => node.id === selectedNodeId) ?? null
      : null;
    await pasteSystemClipboardContent(
      {
        imageFile: null,
        text,
        fingerprint: `event-text:${text.trim().length}:${hashText(text.trim())}`,
      },
      {
        targetNode: selectedTargetNode,
        flowPosition: resolveShortcutPasteFlowPosition(),
      }
    );
  }, [pasteSystemClipboardContent, resolveShortcutPasteFlowPosition, selectedNodeId]);

  const shouldHandleClipboardEventPaste = useCallback(async (payload: {
    imageFile: File | null;
    text: string;
  }) => {
    const internalSnapshotIsFresh = clipboardFreshnessRef.current === 'internal'
      && Boolean(copiedSnapshotRef.current?.nodes.length);
    if (!internalSnapshotIsFresh) {
      return true;
    }

    let settledInternalBaseline = systemClipboardFingerprintAtInternalCopyRef.current;
    const baselineCapture = systemClipboardFingerprintCaptureRef.current;
    if (settledInternalBaseline === undefined && baselineCapture) {
      settledInternalBaseline = await baselineCapture;
      if (systemClipboardFingerprintCaptureRef.current === baselineCapture) {
        systemClipboardFingerprintAtInternalCopyRef.current = settledInternalBaseline;
      }
    }

    if (settledInternalBaseline === undefined) {
      return false;
    }

    const eventFingerprint = payload.imageFile
      ? await fingerprintImageFile(payload.imageFile)
      : fingerprintClipboardContent({ text: payload.text });
    return Boolean(eventFingerprint && eventFingerprint !== settledInternalBaseline);
  }, []);

  // Keyboard shortcuts (undo/redo/copy/paste/group/delete) + paste-image
  // bridge to upload nodes — see hook for the coordination details
  // between the `paste` and `keydown` listeners.
  useCanvasShortcuts({
    nodes,
    selectedNodeId,
    selectedNodeIds,
    selectedUploadNodeId,
    scheduleCanvasPersist,
    undo,
    redo,
    groupNodes,
    deleteNode,
    deleteNodes,
    copyNodesToClipboard,
    pasteFromShortcut: handleShortcutPaste,
    markSystemClipboardFresh,
    pasteImageAtCanvasPosition,
    pasteImageFromClipboardEvent,
    pasteTextFromClipboardEvent,
    shouldHandleClipboardEventPaste,
  });

  const handleContextMenuPaste = useCallback(async () => {
    const menuState = nodeContextMenu;
    if (!menuState) {
      return;
    }
    setNodeContextMenu(null);

    const targetNode = menuState.nodeId
      ? useCanvasStore.getState().nodes.find((node) => node.id === menuState.nodeId) ?? null
      : null;
    const isPromptPasteTarget = targetNode?.type === CANVAS_NODE_TYPES.imageEdit
      || targetNode?.type === CANVAS_NODE_TYPES.aiVideo
      || targetNode?.type === CANVAS_NODE_TYPES.aiText;
    const pasteFlowPosition = targetNode && (
      targetNode.type === CANVAS_NODE_TYPES.upload
      || targetNode.type === CANVAS_NODE_TYPES.exportImage
      || targetNode.type === CANVAS_NODE_TYPES.video
    )
      ? (() => {
          const nodeMap = new Map(useCanvasStore.getState().nodes.map((node) => [node.id, node] as const));
          const absolute = resolveAbsoluteNodePosition(targetNode, nodeMap);
          const size = getNodeSize(targetNode);
          return {
            x: absolute.x + size.width + 80,
            y: absolute.y,
          };
        })()
      : menuState.flowPosition;

    const clipboardContent = await readClipboardContent({ avoidBrowserApiWhenTauriAvailable: true });
    const internalSnapshotIsFresh = clipboardFreshnessRef.current === 'internal'
      && Boolean(copiedSnapshotRef.current?.nodes.length);
    let settledInternalBaseline = systemClipboardFingerprintAtInternalCopyRef.current;
    const baselineCapture = systemClipboardFingerprintCaptureRef.current;
    if (internalSnapshotIsFresh && settledInternalBaseline === undefined && baselineCapture) {
      settledInternalBaseline = await baselineCapture;
      if (systemClipboardFingerprintCaptureRef.current === baselineCapture) {
        systemClipboardFingerprintAtInternalCopyRef.current = settledInternalBaseline;
      }
    }
    const clipboardHasPayload = hasClipboardPayload(clipboardContent);
    const clipboardReadCanConfirmEmpty = !clipboardContent.readFailed;
    const clipboardMatchesSettledInternalBaseline = internalSnapshotIsFresh
      && settledInternalBaseline !== undefined
      && clipboardContent.fingerprint === settledInternalBaseline;
    const clipboardCanConfirmSettledInternalBaseline = clipboardMatchesSettledInternalBaseline
      && (clipboardHasPayload || clipboardReadCanConfirmEmpty);
    if (clipboardHasPayload && !clipboardCanConfirmSettledInternalBaseline) {
      await pasteSystemClipboardContent(clipboardContent, {
        targetNode,
        flowPosition: pasteFlowPosition,
      });
      return;
    }
    if (clipboardContent.readFailed && !clipboardCanConfirmSettledInternalBaseline) {
      return;
    }

    if (internalSnapshotIsFresh) {
      pasteCopiedNodes(pasteFlowPosition);
      return;
    }

    if (!isPromptPasteTarget && clipboardFreshnessRef.current !== 'system') {
      pasteCopiedNodes(pasteFlowPosition);
    }
  }, [
    nodeContextMenu,
    pasteCopiedNodes,
    pasteSystemClipboardContent,
  ]);

  const handleNodeContextMenuDelete = useCallback(() => {
    if (!nodeContextMenu?.nodeId) {
      return;
    }
    deleteNode(nodeContextMenu.nodeId);
    scheduleCanvasPersist(0);
    setNodeContextMenu(null);
  }, [deleteNode, nodeContextMenu, scheduleCanvasPersist]);

  const handleConfiguredNodeClickAction = useCallback((
    event: ReactMouseEvent,
    nodeId: string,
    action: CanvasMouseAction
  ) => {
    if (action === 'nodeMenu') {
      event.preventDefault();
      event.stopPropagation();
      openNodeContextMenuAtClientPosition(nodeId, event.clientX, event.clientY);
      return;
    }
    if (action === 'selectNode') {
      selectSingleNode(nodeId);
      setNodeContextMenu(null);
      return;
    }
    if (action === 'none' || action === 'panCanvas' || action === 'selectionBox') {
      event.preventDefault();
      window.setTimeout(() => selectSingleNode(null), 0);
      setNodeContextMenu(null);
    }
  }, [openNodeContextMenuAtClientPosition, selectSingleNode]);

  const handleNodeClick = useCallback((event: ReactMouseEvent, node: CanvasNode) => {
    handleConfiguredNodeClickAction(
      event,
      node.id,
      getCanvasMouseAction(canvasMouseBindings, 0, 'click')
    );
  }, [canvasMouseBindings, handleConfiguredNodeClickAction]);

  const handleNodeContextMenu = useCallback((event: ReactMouseEvent, node: CanvasNode) => {
    event.preventDefault();
    event.stopPropagation();
    const action = getCanvasMouseAction(canvasMouseBindings, 2, 'click');
    handleConfiguredNodeClickAction(event, node.id, action);
  }, [canvasMouseBindings, handleConfiguredNodeClickAction]);

  const handleCanvasAuxClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 1 || shouldIgnoreCanvasMarqueeTarget(event.target)) {
      return;
    }
    const nodeId = getCanvasNodeIdFromTarget(event.target);
    const action = getCanvasMouseAction(canvasMouseBindings, 1, 'click');
    if (action === 'none' || action === 'nodeMenu' || action === 'selectNode') {
      event.preventDefault();
      event.stopPropagation();
    }
    if (!nodeId) {
      if (action !== 'panCanvas' && action !== 'selectionBox') {
        setNodeContextMenu(null);
      }
      return;
    }
    handleConfiguredNodeClickAction(event, nodeId, action);
  }, [canvasMouseBindings, handleConfiguredNodeClickAction]);


  const handleConnectStart = useCallback(
    (event: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
      lastConnectSelectionClearAtRef.current = Date.now();
      clearBrowserTextSelection();
      setShowNodeMenu(false);
      setNodeContextMenu(null);
      setMenuAllowedTypes(undefined);
      setPreviewConnectionVisual(null);

      if (!params.nodeId || !params.handleType) {
        setPendingConnectStart(null);
        return;
      }

      if (
        params.handleType === 'source'
        && !canNodeBeManualConnectionSource(params.nodeId, nodes)
      ) {
        setPendingConnectStart(null);
        return;
      }

      const containerRect = wrapperRef.current?.getBoundingClientRect();
      const eventTarget = event.target as Element | null;
      const handleElement = eventTarget?.closest?.('.react-flow__handle') as HTMLElement | null;
      const clientPosition = getClientPosition(event);
      let start: { x: number; y: number } | undefined;
      if (containerRect && handleElement) {
        const handleRect = handleElement.getBoundingClientRect();
        start = {
          x: handleRect.left - containerRect.left + handleRect.width / 2,
          y: handleRect.top - containerRect.top + handleRect.height / 2,
        };
      } else if (containerRect && clientPosition) {
        start = {
          x: clientPosition.x - containerRect.left,
          y: clientPosition.y - containerRect.top,
        };
      }

      setPendingConnectStart({
        nodeId: params.nodeId,
        handleType: params.handleType,
        start,
      });
    },
    [nodes]
  );

  const handleNodeDragStart = useCallback(
    (event: ReactMouseEvent, node: CanvasNode) => {
      if (!event.altKey) {
        altDragCopyRef.current = null;
        return;
      }

      const sourceNodeIds = selectedNodeIds.includes(node.id)
        ? selectedNodeIds
        : [node.id];
      if (sourceNodeIds.length === 0) {
        altDragCopyRef.current = null;
        return;
      }
      const startPositions = new Map<string, { x: number; y: number }>();
      for (const sourceNodeId of sourceNodeIds) {
        const sourceNode = nodes.find((item) => item.id === sourceNodeId);
        if (!sourceNode) {
          continue;
        }
        startPositions.set(sourceNodeId, {
          x: sourceNode.position.x,
          y: sourceNode.position.y,
        });
      }
      if (startPositions.size === 0) {
        altDragCopyRef.current = null;
        return;
      }

      const duplicateResult = duplicateNodes(sourceNodeIds, {
        explicitOffset: { x: 0, y: 0 },
        disableOffsetIteration: true,
        suppressPersist: true,
        suppressSelect: true,
      });
      if (!duplicateResult) {
        altDragCopyRef.current = null;
        return;
      }

      const copiedNodeIds = sourceNodeIds
        .map((sourceId) => duplicateResult.idMap.get(sourceId))
        .filter((id): id is string => Boolean(id));
      if (copiedNodeIds.length === 0) {
        altDragCopyRef.current = null;
        return;
      }

      // Keep the duplicated nodes visually above the original dragged node.
      useCanvasStore.setState((state) => ({
        nodes: state.nodes.map((currentNode) => {
          if (!copiedNodeIds.includes(currentNode.id)) {
            return currentNode;
          }
          return {
            ...currentNode,
            zIndex: ALT_DRAG_COPY_Z_INDEX,
            style: {
              ...(currentNode.style ?? {}),
              zIndex: ALT_DRAG_COPY_Z_INDEX,
            },
          };
        }),
      }));

      altDragCopyRef.current = {
        sourceNodeIds,
        startPositions,
        copiedNodeIds,
        sourceToCopyIdMap: duplicateResult.idMap,
      };
    },
    [duplicateNodes, nodes, selectedNodeIds]
  );

  const handleNodeDrag = useCallback(
    (_event: ReactMouseEvent, node: CanvasNode) => {
      const altCopyState = altDragCopyRef.current;
      if (!altCopyState) {
        return;
      }

      const startPosition = altCopyState.startPositions.get(node.id);
      if (!startPosition) {
        return;
      }

      const deltaX = node.position.x - startPosition.x;
      const deltaY = node.position.y - startPosition.y;

      const restoreSourceChanges = altCopyState.sourceNodeIds
        .map((sourceId) => {
          const sourceStart = altCopyState.startPositions.get(sourceId);
          if (!sourceStart) {
            return null;
          }
          return {
            id: sourceId,
            type: 'position' as const,
            position: sourceStart,
            dragging: true,
          };
        })
        .filter((change): change is {
          id: string;
          type: 'position';
          position: { x: number; y: number };
          dragging: true;
        } => Boolean(change));

      const moveCopyChanges = altCopyState.sourceNodeIds
        .map((sourceId) => {
          const sourceStart = altCopyState.startPositions.get(sourceId);
          const copyId = altCopyState.sourceToCopyIdMap.get(sourceId);
          if (!sourceStart || !copyId) {
            return null;
          }
          return {
            id: copyId,
            type: 'position' as const,
            position: { x: sourceStart.x + deltaX, y: sourceStart.y + deltaY },
            dragging: true,
          };
        })
        .filter((change): change is {
          id: string;
          type: 'position';
          position: { x: number; y: number };
          dragging: true;
        } => Boolean(change));

      const allChanges = [...restoreSourceChanges, ...moveCopyChanges];
      if (allChanges.length > 0) {
        applyNodesChange(allChanges);
      }
    },
    [applyNodesChange]
  );

  const handleNodeDragStop = useCallback(
    (_event: ReactMouseEvent, node: CanvasNode) => {
      const altCopyState = altDragCopyRef.current;
      if (!altCopyState) {
        return;
      }
      altDragCopyRef.current = null;

      const startPosition = altCopyState.startPositions.get(node.id);
      if (!startPosition) {
        return;
      }

      const offset = {
        x: node.position.x - startPosition.x,
        y: node.position.y - startPosition.y,
      };

      const restoreSourceChanges = altCopyState.sourceNodeIds
        .map((sourceId) => {
          const sourceStart = altCopyState.startPositions.get(sourceId);
          if (!sourceStart) {
            return null;
          }
          return {
            id: sourceId,
            type: 'position' as const,
            position: sourceStart,
            dragging: false,
          };
        })
        .filter((change): change is {
          id: string;
          type: 'position';
          position: { x: number; y: number };
          dragging: false;
        } => Boolean(change));

      const finalizeCopyChanges = altCopyState.sourceNodeIds
        .map((sourceId) => {
          const sourceStart = altCopyState.startPositions.get(sourceId);
          const copyId = altCopyState.sourceToCopyIdMap.get(sourceId);
          if (!sourceStart || !copyId) {
            return null;
          }
          return {
            id: copyId,
            type: 'position' as const,
            position: { x: sourceStart.x + offset.x, y: sourceStart.y + offset.y },
            dragging: false,
          };
        })
        .filter((change): change is {
          id: string;
          type: 'position';
          position: { x: number; y: number };
          dragging: false;
        } => Boolean(change));

      const allChanges = [...restoreSourceChanges, ...finalizeCopyChanges];
      if (allChanges.length > 0) {
        applyNodesChange(allChanges);
      }
      if (altCopyState.copiedNodeIds.length > 0) {
        setSelectedNode(altCopyState.copiedNodeIds[0]);
      }
      scheduleCanvasPersist(0);
    },
    [applyNodesChange, scheduleCanvasPersist, setSelectedNode]
  );

  const handleConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      lastConnectSelectionClearAtRef.current = 0;
      clearBrowserTextSelection();
      window.requestAnimationFrame(() => clearBrowserTextSelection());
      if (connectionState.isValid || !pendingConnectStart) {
        setPendingConnectStart(null);
        setPreviewConnectionVisual(null);
        return;
      }

      const clientPosition = getClientPosition(event);
      const containerRect = wrapperRef.current?.getBoundingClientRect();
      if (!clientPosition || !containerRect) {
        setPendingConnectStart(null);
        setPreviewConnectionVisual(null);
        return;
      }

      const eventTarget = event.target as Element | null;
      const nodeElementFromTarget = eventTarget?.closest?.('.react-flow__node[data-id]') as HTMLElement | null;
      const nodeElementFromPoint = document.elementFromPoint(clientPosition.x, clientPosition.y)
        ?.closest?.('.react-flow__node[data-id]') as HTMLElement | null;
      const dropNodeElement = nodeElementFromTarget ?? nodeElementFromPoint;
      const dropNodeId = dropNodeElement?.dataset?.id ?? null;

      if (dropNodeId && dropNodeId !== pendingConnectStart.nodeId) {
        const sourceNode =
          pendingConnectStart.handleType === 'source'
            ? nodes.find((node) => node.id === pendingConnectStart.nodeId)
            : nodes.find((node) => node.id === dropNodeId);
        const targetNode =
          pendingConnectStart.handleType === 'source'
            ? nodes.find((node) => node.id === dropNodeId)
            : nodes.find((node) => node.id === pendingConnectStart.nodeId);

        if (
          sourceNode &&
          targetNode &&
          canNodeTypeBeManualConnectionSource(sourceNode.type) &&
          nodeHasSourceHandle(sourceNode.type) &&
          nodeHasTargetHandle(targetNode.type)
        ) {
          connectNodes({
            source: sourceNode.id,
            target: targetNode.id,
            sourceHandle: 'source',
            targetHandle: 'target',
          });
          if (targetNode.type === CANVAS_NODE_TYPES.textAnnotation) {
            const sourceText = getGeneratedTextForConnection(sourceNode, nodes);
            if (sourceText) {
              const currentContent = (targetNode.data as { content?: unknown }).content;
              const normalizedCurrent = typeof currentContent === 'string' ? currentContent.trim() : '';
              updateNodeData(targetNode.id, {
                content: normalizedCurrent ? `${normalizedCurrent}\n${sourceText}` : sourceText,
              } as Partial<CanvasNodeData>);
            }
          }
          scheduleCanvasPersist(0);
          setPendingConnectStart(null);
          setPreviewConnectionVisual(null);
          return;
        }
      }

      const allowedTypes = resolveAllowedNodeTypes(pendingConnectStart.handleType);
      if (allowedTypes.length === 0) {
        setPendingConnectStart(null);
        setPreviewConnectionVisual(null);
        return;
      }

      const endX = clientPosition.x - containerRect.left;
      const endY = clientPosition.y - containerRect.top;
      let startX: number | null = pendingConnectStart.start?.x ?? null;
      let startY: number | null = pendingConnectStart.start?.y ?? null;

      if (startX === null || startY === null) {
        const nodeElement = wrapperRef.current?.querySelector<HTMLElement>(
          `.react-flow__node[data-id="${pendingConnectStart.nodeId}"]`
        );
        const handleElement = nodeElement?.querySelector<HTMLElement>(
          `.react-flow__handle-${pendingConnectStart.handleType}`
        );
        if (handleElement) {
          const handleRect = handleElement.getBoundingClientRect();
          startX = handleRect.left - containerRect.left + handleRect.width / 2;
          startY = handleRect.top - containerRect.top + handleRect.height / 2;
        } else if (nodeElement) {
          const nodeRect = nodeElement.getBoundingClientRect();
          startX =
            pendingConnectStart.handleType === 'source'
              ? nodeRect.right - containerRect.left
              : nodeRect.left - containerRect.left;
          startY = nodeRect.top - containerRect.top + nodeRect.height / 2;
        } else if (connectionState.from) {
          startX = connectionState.from.x;
          startY = connectionState.from.y;
        }
      }

      if (startX === null || startY === null) {
        setPreviewConnectionVisual(null);
      } else {
        setPreviewConnectionVisual({
          d: createPreviewPath({
            start: { x: startX, y: startY },
            end: { x: endX, y: endY },
            handleType: pendingConnectStart.handleType,
          }),
          stroke: 'rgba(255,255,255,0.9)',
          strokeWidth: 1,
          strokeLinecap: 'round',
          left: 0,
          top: 0,
          width: containerRect.width,
          height: containerRect.height,
        });
      }

      const flowPos = reactFlowInstance.screenToFlowPosition(clientPosition);
      setFlowPosition(flowPos);
      setMenuPosition({
        x: clientPosition.x - containerRect.left,
        y: clientPosition.y - containerRect.top,
      });
      setMenuAllowedTypes(allowedTypes);
      suppressNextPaneClickRef.current = true;
      setShowNodeMenu(true);
    },
    [connectNodes, nodes, pendingConnectStart, reactFlowInstance, scheduleCanvasPersist, updateNodeData]
  );

  const emptyHint = useMemo(
    () => (
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="flex max-w-3xl flex-col items-center gap-5 px-6 text-center">
          {!hasConfiguredProvider && <MissingApiKeyHint />}
          <div>
            <div className="mb-2 text-2xl text-text-muted">{t('canvas.emptyHintTitle')}</div>
            <div className="text-sm text-text-muted opacity-60">{t('canvas.emptyHintSubtitle')}</div>
          </div>
        </div>
      </div>
    ),
    [hasConfiguredProvider, t]
  );

  return (
    <div
      ref={wrapperRef}
      className="relative h-full w-full outline-none"
      tabIndex={0}
      onPointerDown={handleCanvasPointerDown}
      onPointerMove={handleCanvasPointerMove}
      onContextMenu={handleCanvasContextMenu}
      onAuxClick={handleCanvasAuxClick}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onEdgeClick={handleEdgeClick}
        onEdgeDoubleClick={handleEdgeDoubleClick}
        onConnect={handleConnect}
        onConnectStart={handleConnectStart}
        onConnectEnd={handleConnectEnd}
        onNodeDragStart={handleNodeDragStart}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStop}
        onNodeClick={handleNodeClick}
        onNodeContextMenu={handleNodeContextMenu}
        onPaneClick={handlePaneClick}
        onMove={handleMove}
        onMoveStart={handleMoveStart}
        onMoveEnd={handleMoveEnd}
        onDragOver={handleCanvasDragOver}
        onDrop={handleCanvasDrop}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={{ type: 'disconnectableEdge' }}
        defaultViewport={DEFAULT_VIEWPORT}
        minZoom={0.1}
        maxZoom={5}
        panOnDrag={panOnDragButtons.length > 0 ? panOnDragButtons : false}
        selectionOnDrag={false}
        selectionMode={SelectionMode.Partial}
        multiSelectionKeyCode={['Control', 'Meta']}
        selectionKeyCode={['Control', 'Meta']}
        deleteKeyCode={null}
        onlyRenderVisibleElements
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
        className="canvas-flow"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          color="var(--canvas-grid-dot)"
        />
        <MiniMap
          className="canvas-minimap nopan nowheel"
          style={{ pointerEvents: 'all', zIndex: 10000 }}
          nodeColor="var(--canvas-minimap-node)"
          maskColor="var(--canvas-minimap-mask)"
          pannable
          zoomable
        />

        <SelectedNodeOverlay />
      </ReactFlow>

      {marqueeRect && (
        <div
          className="pointer-events-none absolute z-[12000] rounded border border-accent/80 bg-accent/15 shadow-[0_0_0_1px_rgba(255,255,255,0.16)_inset]"
          style={{
            left: marqueeRect.left,
            top: marqueeRect.top,
            width: marqueeRect.width,
            height: marqueeRect.height,
          }}
        />
      )}

      {!marqueeRect && selectionBoundsRect && (
        <div
          className="pointer-events-none absolute z-[11990] rounded border border-accent/80 bg-accent/10 shadow-[0_0_0_1px_rgba(255,255,255,0.14)_inset]"
          style={{
            left: selectionBoundsRect.left,
            top: selectionBoundsRect.top,
            width: selectionBoundsRect.width,
            height: selectionBoundsRect.height,
          }}
        />
      )}

      {batchToolbarPosition && (selectedNodeIds.length > 1 || isSingleSelectedGroup) && (
        <div
          data-canvas-no-marquee="true"
          className="absolute z-[12020] flex -translate-x-1/2 items-center gap-1 rounded-full border border-[var(--canvas-node-border)] bg-[var(--canvas-node-menu-bg)] px-2 py-1.5 text-xs text-text-dark shadow-2xl"
          style={{
            left: batchToolbarPosition.left,
            top: batchToolbarPosition.top,
          }}
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onWheelCapture={(event) => event.stopPropagation()}
        >
          <span className="mr-1 flex items-center gap-1 whitespace-nowrap px-1 text-text-muted">
            <Boxes className="h-3.5 w-3.5" />
            {t('canvas.batchToolbar.selectedCount', { count: batchToolbarSelectedCount })}
          </span>
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-full px-2 transition-colors hover:bg-[var(--canvas-node-menu-hover)]"
            onClick={handleBatchCopy}
            title={t('canvas.batchToolbar.copy')}
          >
            <Copy className="h-3.5 w-3.5" />
            {t('canvas.batchToolbar.copy')}
          </button>
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-full px-2 transition-colors hover:bg-[var(--canvas-node-menu-hover)] disabled:cursor-not-allowed disabled:opacity-40"
            disabled={selectedNodeIds.length < 2}
            onClick={handleBatchGroup}
            title={t('canvas.batchToolbar.group')}
          >
            <Group className="h-3.5 w-3.5" />
            {t('canvas.batchToolbar.group')}
          </button>
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-full px-2 transition-colors hover:bg-[var(--canvas-node-menu-hover)] disabled:cursor-not-allowed disabled:opacity-40"
            disabled={selectedGroupNodeIds.length === 0}
            onClick={handleBatchUngroup}
            title={t('canvas.batchToolbar.ungroup')}
          >
            <Ungroup className="h-3.5 w-3.5" />
            {t('canvas.batchToolbar.ungroup')}
          </button>
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-full px-2 transition-colors hover:bg-[var(--canvas-node-menu-hover)] disabled:cursor-not-allowed disabled:opacity-40"
            disabled={selectedBatchTriggerNodeIds.length === 0}
            onClick={handleBatchTrigger}
            title={t('canvas.batchToolbar.trigger')}
          >
            <Play className="h-3.5 w-3.5" />
            {t('canvas.batchToolbar.trigger')}
          </button>
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-full px-2 text-red-300 transition-colors hover:bg-red-500/15 hover:text-red-200"
            onClick={handleBatchDelete}
            title={t('canvas.batchToolbar.delete')}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('canvas.batchToolbar.delete')}
          </button>
        </div>
      )}

      <CanvasSideToolbar onOpenAssets={handleOpenAssetPanel} />
      <CanvasLeftRail />
      <AssetPanel
        isOpen={isAssetPanelOpen}
        assets={assetPanelAssets}
        buttonRect={assetButtonRect}
        mode={assetPanelMode}
        title={assetPanelMode === 'select' ? '资产' : undefined}
        subtitle={assetPanelMode === 'select' ? '选择一张现有图片连接到 AI 图片节点' : undefined}
        onClose={closeAssetPanel}
        onActivate={handleActivateAsset}
        onRename={assetPanelMode === 'browse' ? handleRenameAsset : undefined}
      />

      {nodes.length === 0 && emptyHint}
      {nodes.length > 0 && !hasConfiguredProvider && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-6">
          <MissingApiKeyHint />
        </div>
      )}

      {showNodeMenu && previewConnectionVisual && (
        <svg
          className="pointer-events-none absolute z-40 overflow-visible"
          style={{
            left: previewConnectionVisual.left,
            top: previewConnectionVisual.top,
            width: previewConnectionVisual.width,
            height: previewConnectionVisual.height,
          }}
          width={previewConnectionVisual.width}
          height={previewConnectionVisual.height}
        >
          <path
            className="pointer-events-none"
            d={previewConnectionVisual.d}
            fill="none"
            stroke={previewConnectionVisual.stroke}
            strokeWidth={previewConnectionVisual.strokeWidth}
            strokeLinecap={previewConnectionVisual.strokeLinecap}
          />
        </svg>
      )}

      {nodeContextMenu && (
        <div
          data-canvas-no-marquee="true"
          className="absolute z-[12030] min-w-32 overflow-hidden rounded-md border border-[var(--canvas-node-border)] bg-[var(--canvas-node-menu-bg)] py-1 text-sm text-text-dark shadow-2xl"
          style={{
            left: nodeContextMenu.position.x,
            top: nodeContextMenu.position.y,
          }}
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onWheelCapture={(event) => event.stopPropagation()}
        >
          {nodeContextMenu.nodeId && (
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--canvas-node-menu-hover)]"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                handleNodeContextMenuCopy();
              }}
            >
              <Copy className="h-4 w-4" />
              {t('nodeToolbar.copyNode')}
            </button>
          )}
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--canvas-node-menu-hover)]"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void handleContextMenuPaste();
            }}
          >
            <ClipboardPaste className="h-4 w-4" />
            {t('nodeToolbar.paste')}
          </button>
          {nodeContextMenu.nodeId && (
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-300 transition-colors hover:bg-red-500/15 hover:text-red-200"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                handleNodeContextMenuDelete();
              }}
            >
              <Trash2 className="h-4 w-4" />
              {t('common.delete')}
            </button>
          )}
        </div>
      )}

      {showNodeMenu && (
        <NodeSelectionMenu
          position={menuPosition}
          allowedTypes={menuAllowedTypes}
          showAssetOption={showConnectAssetOption}
          onSelectAsset={handleOpenConnectAssetPanel}
          onSelect={handleNodeSelect}
          onClose={() => {
            setShowNodeMenu(false);
            setNodeContextMenu(null);
            setMenuAllowedTypes(undefined);
            setPendingConnectStart(null);
            setPreviewConnectionVisual(null);
          }}
        />
      )}

      <NodeToolDialog />

      <ImageViewerModal
        open={imageViewer.isOpen}
        imageUrl={imageViewer.currentImageUrl || ''}
        imageList={imageViewer.imageList}
        currentIndex={imageViewer.currentIndex}
        onClose={closeImageViewer}
        onNavigate={navigateImageViewer}
      />
    </div>
  );
}
