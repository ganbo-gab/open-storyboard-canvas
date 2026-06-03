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
import { useTranslation } from 'react-i18next';
import '@xyflow/react/dist/style.css';

import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { useCustomProvidersStore } from '@/stores/customProvidersStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { useCanvasPersistence } from '@/features/canvas/hooks/useCanvasPersistence';
import { useCanvasGenerationPolling } from '@/features/canvas/hooks/useCanvasGenerationPolling';
import { useCanvasShortcuts } from '@/features/canvas/hooks/useCanvasShortcuts';
import { CanvasSideToolbar } from '@/features/canvas/CanvasSideToolbar';
import { CanvasLeftRail } from '@/features/canvas/ui/CanvasLeftRail';
import {
  CANVAS_NODE_TYPES,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeType,
  DEFAULT_NODE_WIDTH,
} from '@/features/canvas/domain/canvasNodes';
import {
  prepareNodeImageFromFile,
  resolveImageDisplayUrl,
} from '@/features/canvas/application/imageData';
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

const ALT_DRAG_COPY_Z_INDEX = 2000;
const EMPTY_CANVAS_ASSETS: CanvasAssetItem[] = [];

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

function getNodeSize(node: CanvasNode): { width: number; height: number } {
  const styleWidth = typeof node.style?.width === 'number' ? node.style.width : null;
  const styleHeight = typeof node.style?.height === 'number' ? node.style.height : null;
  return {
    width: node.measured?.width ?? styleWidth ?? DEFAULT_NODE_WIDTH,
    height: node.measured?.height ?? styleHeight ?? 200,
  };
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
    || type === CANVAS_NODE_TYPES.exportImage;
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
        rawImageUrl: imageUrl,
        rawPreviewImageUrl: previewImageUrl,
        aspectRatio: typeof data.aspectRatio === 'string' ? data.aspectRatio : undefined,
        title: getNodeDisplayTitle(node, sourceLabel),
        sourceLabel,
        order: baseOrder,
        ...resolved,
      });
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

  const [showNodeMenu, setShowNodeMenu] = useState(false);
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

  const pasteIterationRef = useRef(0);
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
  const undo = useCanvasStore((state) => state.undo);
  const redo = useCanvasStore((state) => state.redo);
  const openToolDialog = useCanvasStore((state) => state.openToolDialog);
  const closeToolDialog = useCanvasStore((state) => state.closeToolDialog);
  const setViewportState = useCanvasStore((state) => state.setViewportState);
  const setCanvasViewportSize = useCanvasStore((state) => state.setCanvasViewportSize);
  const imageViewer = useCanvasStore((state) => state.imageViewer);
  const closeImageViewer = useCanvasStore((state) => state.closeImageViewer);
  const navigateImageViewer = useCanvasStore((state) => state.navigateImageViewer);
  const apiKeys = useSettingsStore((state) => state.apiKeys);
  const dreaminaStatus = useSettingsStore((state) => state.dreaminaStatus);
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
    return canvasAssets.filter((asset) => asset.nodeId !== assetConnectTargetNodeId);
  }, [assetConnectTargetNodeId, assetPanelMode, canvasAssets]);

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
    [applyNodesChange, scheduleCanvasPersist]
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
      scheduleCanvasPersist(0);
    },
    [connectNodes, nodes, scheduleCanvasPersist]
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

  const handleOpenAssetPanel = useCallback((buttonRect: DOMRect) => {
    setAssetButtonRect(buttonRect);
    setAssetPanelMode('browse');
    setAssetConnectTargetNodeId(null);
    setIsAssetPanelOpen((open) => !open);
    setShowNodeMenu(false);
    setMenuAllowedTypes(undefined);
    setPendingConnectStart(null);
    setPreviewConnectionVisual(null);
  }, []);

  const handleActivateAsset = useCallback(
    (asset: CanvasAssetItem) => {
      if (assetPanelMode === 'select') {
        if (!assetConnectTargetNodeId || asset.nodeId === assetConnectTargetNodeId) {
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
      updateNodeData(asset.nodeId, { displayName: title });
    },
    [updateNodeData]
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
  const selectedUploadNodeId = useMemo(() => {
    if (selectedNodeIds.length !== 1) {
      return null;
    }
    const selectedNode = nodes.find((node) => node.id === selectedNodeIds[0]);
    if (!selectedNode || selectedNode.type !== CANVAS_NODE_TYPES.upload) {
      return null;
    }
    return selectedNode.id;
  }, [nodes, selectedNodeIds]);

  const createUploadImageNodeAtClientPosition = useCallback(
    async (file: File, clientPosition: { x: number; y: number }) => {
      const flowPosition = reactFlowInstance.screenToFlowPosition(clientPosition);

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
      } catch (error) {
        console.error('Failed to import image onto canvas', error);
      }
    },
    [
      addNode,
      reactFlowInstance,
      scheduleCanvasPersist,
      setSelectedNode,
    ]
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
  }, []);

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

  // Keyboard shortcuts (undo/redo/copy/paste/group/delete) + paste-image
  // bridge to upload nodes — see hook for the coordination details
  // between the `paste` and `keydown` listeners.
  useCanvasShortcuts({
    nodes,
    edges,
    selectedNodeId,
    selectedNodeIds,
    selectedUploadNodeId,
    scheduleCanvasPersist,
    undo,
    redo,
    groupNodes,
    deleteNode,
    deleteNodes,
    duplicateNodes: (sourceNodeIds) => duplicateNodes(sourceNodeIds)?.firstNodeId ?? null,
    pasteImageAtCanvasPosition,
  });

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
    ]
  );

  const duplicateNodes = useCallback(
    (sourceNodeIds: string[], options: DuplicateOptions = {}) => {
      const dedupedIds = Array.from(new Set(sourceNodeIds));
      if (dedupedIds.length === 0) {
        return null as DuplicateResult | null;
      }

      const sourceNodes = nodes.filter((node) => dedupedIds.includes(node.id));
      if (sourceNodes.length === 0) {
        return null as DuplicateResult | null;
      }

      const sourceIdSet = new Set(sourceNodes.map((node) => node.id));
      const internalEdges = edges.filter(
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
        return !hasRectCollision(
          {
            x: node.position.x + offset.x + offsetStep * 8,
            y: node.position.y + offset.y + offsetStep * 6,
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

        const nextNodeId = addNode(
          sourceNode.type as CanvasNodeType,
          {
            x: sourceNode.position.x + chosenOffset.x + offsetStep * 8,
            y: sourceNode.position.y + chosenOffset.y + offsetStep * 6,
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

      for (const edge of internalEdges) {
        const nextSource = idMap.get(edge.source);
        const nextTarget = idMap.get(edge.target);
        if (!nextSource || !nextTarget) {
          continue;
        }
        connectNodes({
          source: nextSource,
          target: nextTarget,
          sourceHandle: edge.sourceHandle ?? 'source',
          targetHandle: edge.targetHandle ?? 'target',
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
    [addNode, applyNodesChange, connectNodes, edges, nodes, scheduleCanvasPersist, setSelectedNode]
  );


  const handleConnectStart = useCallback(
    (event: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
      setShowNodeMenu(false);
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
    [connectNodes, nodes, pendingConnectStart, reactFlowInstance, scheduleCanvasPersist]
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
    <div ref={wrapperRef} className="relative h-full w-full" onPointerMove={handleCanvasPointerMove}>
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
        selectionOnDrag
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

      {showNodeMenu && (
        <NodeSelectionMenu
          position={menuPosition}
          allowedTypes={menuAllowedTypes}
          showAssetOption={showConnectAssetOption}
          onSelectAsset={handleOpenConnectAssetPanel}
          onSelect={handleNodeSelect}
          onClose={() => {
            setShowNodeMenu(false);
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
