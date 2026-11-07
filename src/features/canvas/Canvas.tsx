import { memo, useCallback, useRef, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { readCanvasClipboardPointer } from '@/commands/image';
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  SelectionMode,
  useReactFlow,
  type EdgeChange,
  type NodeChange,
  type Viewport,
} from '@xyflow/react';

import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import { CanvasControls } from '@/features/canvas/chrome/CanvasControls';
import { CanvasEmptyState } from '@/features/canvas/chrome/CanvasEmptyState';
import { CanvasProviderNotice } from '@/features/canvas/chrome/CanvasProviderNotice';
import { CanvasCommandPalette, CanvasShortcutsSheet } from '@/features/canvas/chrome/CanvasSheets';
import { CanvasToolRail } from '@/features/canvas/chrome/CanvasToolRail';
import { useCanvasClipboard } from '@/features/canvas/clipboard/useCanvasClipboard';
import { CANVAS_COMMAND_VERSION, type CanvasNodeCreateConfiguration } from '@/features/canvas/domain/canvasCommands';
import type { CanvasEdge, CanvasNode, CanvasNodeType } from '@/features/canvas/domain/canvasNodes';
import { CanvasActionsProvider, useCreateCanvasActions } from '@/features/canvas/engine/canvasActions';
import { useAltDragCopy } from '@/features/canvas/engine/useAltDragCopy';
import { useCanvasBridges } from '@/features/canvas/engine/useCanvasBridges';
import { useCanvasConnections } from '@/features/canvas/engine/useCanvasConnections';
import { useCanvasFlowGraphBridge } from '@/features/canvas/engine/useCanvasFlowGraphBridge';
import { useCanvasGestures } from '@/features/canvas/engine/useCanvasGestures';
import { useCanvasViewportEdges } from '@/features/canvas/engine/useCanvasViewportEdges';
import { useCanvasHotkeys, useCanvasPointer } from '@/features/canvas/engine/useCanvasHotkeys';
import { useCanvasGenerationPolling } from '@/features/canvas/hooks/useCanvasGenerationPolling';
import { useCanvasPersistence } from '@/features/canvas/hooks/useCanvasPersistence';
import { useCanvasWasdPan } from '@/features/canvas/hooks/useCanvasWasdPan';
import { useMaterialImport } from '@/features/canvas/io/useMaterialImport';
import { AddNodeMenu } from '@/features/canvas/menus/AddNodeMenu';
import { CanvasContextMenu } from '@/features/canvas/menus/CanvasContextMenu';
import { AlignmentGuidesOverlay } from '@/features/canvas/overlays/AlignmentGuidesOverlay';
import { SelectionToolbar } from '@/features/canvas/overlays/SelectionToolbar';
import { CanvasAssetPanel } from '@/features/canvas/panels/CanvasAssetPanel';
import { useCanvasUiStore, type FlowPoint } from '@/features/canvas/state/canvasUiStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore, type CanvasLeftDragMode } from '@/stores/settingsStore';
import { edgeTypes } from './edges';
import { nodeTypes } from './nodes';
import { ImageViewerModal } from './ui/ImageViewerModal';
import { MediaEditDialogHost } from './ui/MediaEditDialog';
import { CanvasAssetEditHost } from '@/features/assets/ui/CanvasAssetEditHost';
import { GenerationDraftOptionsDialogHost } from './ui/GenerationDraftOptionsDialog';
import { KnowledgeCaptureDialogHost } from '@/features/knowledge/ui/KnowledgeCaptureDialog';
import { NodeToolDialog } from './ui/NodeToolDialog';
import { SelectedNodeOverlay } from './ui/SelectedNodeOverlay';

const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };
const DEFAULT_EDGE_OPTIONS = { type: 'disconnectableEdge' } as const;
const PRO_OPTIONS = { hideAttribution: true } as const;
const SNAP_GRID: [number, number] = [16, 16];
const MULTI_SELECT_KEYS = ['Meta', 'Control', 'Shift'];
const LEFT_BUTTON_PAN = [0];

/** True while a drag/resize is still in flight: persist once on release, not every frame. */
function changeIsInFlight(change: NodeChange<CanvasNode>): boolean {
  return (change.type === 'position' && Boolean(change.dragging))
    || (change.type === 'dimensions' && Boolean(change.resizing));
}

/**
 * The canvas: assembly only. Behaviour lives in `engine/` (gestures, hotkeys, connections,
 * actions), `menus/`, `overlays/`, `chrome/` and `panels/`; all edits go through the command
 * registry or the canvas store so the Agent and the UI share one path.
 */
export function Canvas() {
  const reactFlow = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const getWrapper = useCallback(() => wrapperRef.current, []);
  const { isRestoringCanvasRef, scheduleCanvasPersist } = useCanvasPersistence(reactFlow);
  const pointerRef = useCanvasPointer(wrapperRef);

  const materialImport = useMaterialImport({ screenToFlowPosition: reactFlow.screenToFlowPosition, scheduleCanvasPersist });
  const resolvePastePosition = useCallback((): FlowPoint => {
    const pointer = pointerRef.current;
    if (pointer) return reactFlow.screenToFlowPosition(pointer);
    const rect = wrapperRef.current?.getBoundingClientRect();
    return rect
      ? reactFlow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
      : { x: 0, y: 0 };
  }, [pointerRef, reactFlow]);
  const resolveShortcutPastePosition = useCallback(async (): Promise<FlowPoint> => {
    const fallback = resolvePastePosition();
    const rect = wrapperRef.current?.getBoundingClientRect();
    const viewport = reactFlow.getViewport();
    try {
      const cursor = await readCanvasClipboardPointer();
      if (cursor && rect && cursor.x >= rect.left && cursor.x <= rect.right && cursor.y >= rect.top && cursor.y <= rect.bottom) {
        return { x: (cursor.x - rect.left - viewport.x) / viewport.zoom, y: (cursor.y - rect.top - viewport.y) / viewport.zoom };
      }
    } catch { /* Older hosts retain the captured DOM pointer fallback. */ }
    return fallback;
  }, [reactFlow, resolvePastePosition]);
  const clipboard = useCanvasClipboard({ materialImport, resolvePastePosition, resolveShortcutPastePosition, scheduleCanvasPersist });
  const actions = useCreateCanvasActions({ reactFlow, wrapper: getWrapper, clipboard, scheduleCanvasPersist });

  useCanvasHotkeys(actions, wrapperRef, pointerRef);
  useCanvasBridges(wrapperRef);

  const projectId = useProjectStore((state) => state.currentProjectId);
  const saveViewport = useCallback((viewport: Viewport) => {
    const projects = useProjectStore.getState();
    if (projects.currentProjectId !== projectId || isRestoringCanvasRef.current) return;
    const canvas = useCanvasStore.getState();
    if (canvas.currentViewport.x !== viewport.x || canvas.currentViewport.y !== viewport.y || canvas.currentViewport.zoom !== viewport.zoom) canvas.setViewportState(viewport);
    if (projects.getCurrentProject()) projects.saveCurrentProjectViewport(viewport);
  }, [isRestoringCanvasRef, projectId]);
  const cancelViewportSave = useCallback(() => useProjectStore.getState().cancelPendingViewportPersist(), []);
  const gestures = useCanvasGestures(wrapperRef, { onViewportCommit: saveViewport, onViewportStart: cancelViewportSave });
  useCanvasViewportEdges(wrapperRef);
  const enableWasdPan = useSettingsStore((state) => state.enableCanvasWasdPan);
  const wasdSensitivity = useSettingsStore((state) => state.canvasWasdPanSensitivity);
  useCanvasWasdPan({
    wrapperRef,
    enabled: enableWasdPan,
    sensitivity: wasdSensitivity,
    reactFlowInstance: reactFlow,
    onPanStart: cancelViewportSave,
    onViewportChange: useCanvasStore.getState().setViewportState,
    onPanEnd: saveViewport,
  });

  const tool = useCanvasUiStore((state) => state.tool);
  const spacePan = useCanvasUiStore((state) => state.spacePan);
  const connecting = useCanvasUiStore((state) => state.connecting !== null);
  const edgesHidden = useCanvasUiStore((state) => state.edgesHidden);
  const addMenu = useCanvasUiStore((state) => state.addMenu);
  const contextMenu = useCanvasUiStore((state) => state.contextMenu);
  const sheet = useCanvasUiStore((state) => state.sheet);
  const leftDragMode = useSettingsStore((state) => state.canvasLeftDragMode);
  const imageViewer = useCanvasStore((state) => state.imageViewer);

  const quickAdd = useCallback(
    (type: CanvasNodeType, configuration?: CanvasNodeCreateConfiguration) => void actions.createNode(type, undefined, configuration),
    [actions]
  );
  const openAddMenu = useCallback(() => actions.openAddMenu(), [actions]);
  const openAssets = useCallback((anchor: DOMRect) => {
    const ui = useCanvasUiStore.getState();
    ui.setAssetPanel(ui.assetPanel?.mode === 'browse' ? null : { mode: 'browse', anchor: anchor.toJSON() });
  }, []);
  const pickCanvasAsset = useCallback((targetNodeId: string, anchor: FlowPoint) => {
    useCanvasUiStore.getState().setAssetPanel({ mode: 'select', anchor: { ...anchor, width: 0, height: 0 }, targetNodeId });
  }, []);

  return (
    <CanvasActionsProvider value={actions}>
      <div
        ref={wrapperRef}
        className="canvas-root"
        tabIndex={-1}
        data-tool={tool}
        data-space-pan={spacePan ? '' : undefined}
        data-connecting={connecting ? '' : undefined}
        data-edges-hidden={edgesHidden ? '' : undefined}
      >
        <CanvasFlow
          tool={tool}
          leftDragMode={leftDragMode}
          scheduleCanvasPersist={scheduleCanvasPersist}
          clipboard={clipboard}
          onDragOver={materialImport.handleDragOver}
          onDrop={materialImport.handleDrop}
          onMoveStart={gestures.onMoveStart}
          onMoveEnd={gestures.onMoveEnd}
        />
        <CanvasEmptyState materialImport={materialImport} />
        <CanvasToolRail onOpenAddMenu={openAddMenu} onQuickAdd={quickAdd} onOpenAssets={openAssets} />
        <CanvasControls />
        <SelectionToolbar scheduleCanvasPersist={scheduleCanvasPersist} />
        <CanvasProviderNotice />
        <CanvasAssetPanel scheduleCanvasPersist={scheduleCanvasPersist} />
        {addMenu ? (
          <AddNodeMenu
            key={`${addMenu.clientX}:${addMenu.clientY}`}
            menu={addMenu}
            materialImport={materialImport}
            scheduleCanvasPersist={scheduleCanvasPersist}
            onPickCanvasAsset={pickCanvasAsset}
          />
        ) : null}
        {contextMenu ? (
          <CanvasContextMenu menu={contextMenu} materialImport={materialImport} scheduleCanvasPersist={scheduleCanvasPersist} />
        ) : null}
        {sheet === 'palette' ? <CanvasCommandPalette /> : null}
        {sheet === 'shortcuts' ? <CanvasShortcutsSheet /> : null}
        <NodeToolDialog />
        <MediaEditDialogHost />
        <CanvasAssetEditHost />
        <GenerationDraftOptionsDialogHost />
        <KnowledgeCaptureDialogHost />
        <ImageViewerModal
          open={imageViewer.isOpen}
          imageUrl={imageViewer.currentImageUrl || ''}
          imageList={imageViewer.imageList}
          currentIndex={imageViewer.currentIndex}
          onClose={useCanvasStore.getState().closeImageViewer}
          onNavigate={useCanvasStore.getState().navigateImageViewer}
        />
        <GenerationPolling />
      </div>
    </CanvasActionsProvider>
  );
}

interface CanvasFlowProps {
  tool: 'select' | 'hand';
  leftDragMode: CanvasLeftDragMode;
  scheduleCanvasPersist: (delayMs?: number) => void;
  clipboard: Parameters<typeof useAltDragCopy>[0];
  onDragOver: (event: ReactDragEvent<HTMLElement>) => void;
  onDrop: (event: ReactDragEvent<HTMLElement>) => void;
  onMoveStart: () => void;
  onMoveEnd: (viewport: Viewport) => void;
}

/**
 * Graph edits reach Flow through the synchronous canonical-store bridge, not a React-prop
 * roundtrip per drag frame. This assembly only re-renders when interaction configuration changes.
 */
const CanvasFlow = memo(function CanvasFlow({
  tool,
  leftDragMode,
  scheduleCanvasPersist,
  clipboard,
  onDragOver,
  onDrop,
  onMoveStart,
  onMoveEnd,
}: CanvasFlowProps) {
  useCanvasFlowGraphBridge();
  const studioOpen = useCanvasStore((state) => state.activeDirectorStudioNodeId !== null);
  const snapToGrid = useCanvasUiStore((state) => state.snapToGrid);
  const minimapOpen = useCanvasUiStore((state) => state.minimapOpen);
  const keepAllNodesRendered = useCanvasUiStore((state) => state.zoomRendering.keepAllNodesRendered);
  const connections = useCanvasConnections(scheduleCanvasPersist);
  const altDrag = useAltDragCopy(clipboard, scheduleCanvasPersist);
  const selecting = tool === 'select';

  const handleNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    useCanvasStore.getState().onNodesChange(changes);
    if (changes.every((change) => change.type === 'select') || changes.some(changeIsInFlight)) return;
    const released = changes.some((change) => change.type === 'position' || change.type === 'dimensions');
    scheduleCanvasPersist(released ? 0 : undefined);
  }, [scheduleCanvasPersist]);

  const handleEdgesChange = useCallback((changes: EdgeChange<CanvasEdge>[]) => {
    useCanvasStore.getState().onEdgesChange(changes);
    if (!changes.every((change) => change.type === 'select')) scheduleCanvasPersist();
  }, [scheduleCanvasPersist]);

  const handleEdgeDoubleClick = useCallback((event: ReactMouseEvent, edge: CanvasEdge) => {
    event.stopPropagation();
    void canvasCommandRegistry.execute({ type: 'edge.disconnect', version: CANVAS_COMMAND_VERSION, input: { edgeIds: [edge.id] } }, 'ui')
      .then((result) => {
        if (result.ok) scheduleCanvasPersist(0);
      });
  }, [scheduleCanvasPersist]);

  // Double-click on empty canvas opens the add menu there (RF has no pane double-click event).
  const { screenToFlowPosition } = useReactFlow();
  const handlePaneClick = useCallback((event: ReactMouseEvent) => {
    if (event.detail < 2 || useCanvasUiStore.getState().tool !== 'select') return;
    const point = { x: event.clientX, y: event.clientY };
    useCanvasUiStore.getState().openAddMenu({ clientX: point.x, clientY: point.y, flowPosition: screenToFlowPosition(point) });
  }, [screenToFlowPosition]);

  const handleMoveEnd = useCallback((_event: unknown, viewport: Viewport) => onMoveEnd(viewport), [onMoveEnd]);

  return (
    <ReactFlow<CanvasNode, CanvasEdge>
      onNodesChange={handleNodesChange}
      onEdgesChange={handleEdgesChange}
      onConnect={connections.onConnect}
      onConnectStart={connections.onConnectStart}
      onConnectEnd={connections.onConnectEnd}
      isValidConnection={connections.isValidConnection}
      onNodeDragStart={altDrag.onNodeDragStart}
      onNodeDrag={altDrag.onNodeDrag}
      onNodeDragStop={altDrag.onNodeDragStop}
      onEdgeDoubleClick={handleEdgeDoubleClick}
      onPaneClick={handlePaneClick}
      onMoveStart={onMoveStart}
      onMoveEnd={handleMoveEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
      defaultViewport={DEFAULT_VIEWPORT}
      minZoom={0.1}
      maxZoom={8}
      // Wheel and right/middle drag belong to useCanvasGestures; RF keeps left drag, Space and marquee.
      zoomOnScroll={false}
      zoomOnPinch={false}
      panOnScroll={false}
      zoomOnDoubleClick={false}
      panOnDrag={!selecting || leftDragMode === 'pan' ? LEFT_BUTTON_PAN : false}
      selectionOnDrag={selecting && leftDragMode === 'select'}
      selectionKeyCode="Shift"
      multiSelectionKeyCode={MULTI_SELECT_KEYS}
      selectionMode={SelectionMode.Partial}
      panActivationKeyCode="Space"
      nodesDraggable={selecting}
      nodesConnectable={selecting}
      elementsSelectable={selecting}
      snapToGrid={snapToGrid}
      snapGrid={SNAP_GRID}
      deleteKeyCode={null}
      connectionRadius={28}
      onlyRenderVisibleElements={!studioOpen && !keepAllNodesRendered}
      proOptions={PRO_OPTIONS}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--canvas-grid-dot)" />
      {minimapOpen ? (
        <MiniMap
          className="canvas-minimap nopan nowheel"
          position="bottom-left"
          nodeColor="var(--canvas-minimap-node)"
          maskColor="var(--canvas-minimap-mask)"
          pannable
          zoomable
        />
      ) : null}
      <SelectedNodeOverlay />
      <AlignmentGuidesOverlay />
    </ReactFlow>
  );
});

function GenerationPolling() {
  const nodes = useCanvasStore((state) => state.nodes);
  const apiKeys = useSettingsStore((state) => state.apiKeys);
  useCanvasGenerationPolling(nodes, apiKeys);
  return null;
}
