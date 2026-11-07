import { create } from 'zustand';
import type { HandleType } from '@xyflow/react';

import type { ConnectionRejectReason } from '@/features/canvas/application/canvasConnectionRules';
import type { CanvasNodeType } from '@/features/canvas/domain/canvasNodes';
import { IDLE_CANVAS_ZOOM_RENDERING, type CanvasZoomRendering } from '@/features/canvas/engine/canvasZoomRendering';
import type { AlignmentGuides } from '@/features/canvas/engine/alignment';
import type { MenuAnchor } from '@/components/ui/Menu';

export type CanvasTool = 'select' | 'hand';

export interface FlowPoint {
  x: number;
  y: number;
}

export interface PendingConnection {
  nodeId: string;
  handleType: HandleType;
}

/** Add-node menu, opened by double-click, `+`, Tab, or by dropping a connection on empty canvas. */
export interface AddMenuState {
  anchor?: MenuAnchor;
  clientX: number;
  clientY: number;
  flowPosition: FlowPoint;
  allowedTypes?: CanvasNodeType[];
  /** Set when the menu was opened by releasing a connection drag on empty canvas. */
  connection?: PendingConnection & { fromClient: FlowPoint };
}

export interface ContextMenuState {
  anchor?: MenuAnchor;
  clientX: number;
  clientY: number;
  flowPosition: FlowPoint;
  nodeId: string | null;
  selectedText?: string;
}

export type CanvasSheet = 'shortcuts' | 'palette' | null;

/** Canvas asset panel: browse (locate/rename) or pick an image as input for `targetNodeId`. */
export interface AssetPanelState {
  mode: 'browse' | 'select';
  /** Client rect the panel attaches to (rail button or menu point). */
  anchor: { x: number; y: number; width: number; height: number };
  targetNodeId?: string;
}

interface CanvasUiState {
  tool: CanvasTool;
  /** Space held: temporary hand tool. */
  spacePan: boolean;
  minimapOpen: boolean;
  edgesHidden: boolean;
  snapToGrid: boolean;
  addMenu: AddMenuState | null;
  contextMenu: ContextMenuState | null;
  sheet: CanvasSheet;
  assetPanel: AssetPanelState | null;
  connecting: PendingConnection | null;
  /** Card under the pointer during a connection drag that would refuse it, and why. */
  connectionReject: { nodeId: string; reason: ConnectionRejectReason } | null;
  /** Screen rect (relative to the canvas root) of the open node composer, so other overlays avoid it. */
  composerRect: { nodeId: string; top: number; bottom: number } | null;
  /** Keep the paste location fixed while the newly selected node's composer opens. */
  preservePasteViewportFor: string | null;
  zoomRendering: CanvasZoomRendering;

  setTool: (tool: CanvasTool) => void;
  setSpacePan: (active: boolean) => void;
  toggleMinimap: () => void;
  toggleEdgesHidden: () => void;
  toggleSnapToGrid: () => void;
  openAddMenu: (state: AddMenuState) => void;
  openContextMenu: (state: ContextMenuState) => void;
  setSheet: (sheet: CanvasSheet) => void;
  setAssetPanel: (panel: AssetPanelState | null) => void;
  setConnecting: (connection: PendingConnection | null) => void;
  setConnectionReject: (reject: CanvasUiState['connectionReject']) => void;
  setComposerRect: (rect: CanvasUiState['composerRect']) => void;
  setZoomRendering: (rendering: CanvasZoomRendering) => void;
  /** Close every transient menu; panels and sheets stay. */
  closeMenus: () => void;
  reset: () => void;
}

const INITIAL = {
  tool: 'select' as CanvasTool,
  spacePan: false,
  minimapOpen: false,
  edgesHidden: false,
  snapToGrid: false,
  addMenu: null,
  contextMenu: null,
  sheet: null as CanvasSheet,
  assetPanel: null as AssetPanelState | null,
  connecting: null,
  connectionReject: null as CanvasUiState['connectionReject'],
  composerRect: null as CanvasUiState['composerRect'],
  preservePasteViewportFor: null as string | null,
  zoomRendering: IDLE_CANVAS_ZOOM_RENDERING,
};

interface CanvasAlignmentState {
  alignmentGuides: AlignmentGuides | null;
  setAlignmentGuides: (guides: AlignmentGuides | null) => void;
}

/** Drag-frame guides must not notify every card's connection/menu/LOD subscription. */
export const useCanvasAlignmentStore = create<CanvasAlignmentState>((set) => ({
  alignmentGuides: null,
  setAlignmentGuides: (alignmentGuides) => set((state) => (
    state.alignmentGuides === alignmentGuides
    || (state.alignmentGuides !== null && alignmentGuides !== null
      && state.alignmentGuides.x.length === alignmentGuides.x.length
      && state.alignmentGuides.y.length === alignmentGuides.y.length
      && state.alignmentGuides.x.every((value, index) => value === alignmentGuides.x[index])
      && state.alignmentGuides.y.every((value, index) => value === alignmentGuides.y[index]))
      ? state : { alignmentGuides }
  )),
}));

export const useCanvasUiStore = create<CanvasUiState>((set) => ({
  ...INITIAL,
  setTool: (tool) => set({ tool }),
  setSpacePan: (spacePan) => set((state) => (state.spacePan === spacePan ? state : { spacePan })),
  setZoomRendering: (zoomRendering) => set((state) => (
    state.zoomRendering.keepAllNodesRendered === zoomRendering.keepAllNodesRendered
    && state.zoomRendering.simplifyNodes === zoomRendering.simplifyNodes
    && state.zoomRendering.thumbnailZoom === zoomRendering.thumbnailZoom
      ? state
      : { zoomRendering }
  )),
  toggleMinimap: () => set((state) => ({ minimapOpen: !state.minimapOpen })),
  toggleEdgesHidden: () => set((state) => ({ edgesHidden: !state.edgesHidden })),
  toggleSnapToGrid: () => set((state) => ({ snapToGrid: !state.snapToGrid })),
  openAddMenu: (addMenu) => set({ addMenu, contextMenu: null }),
  openContextMenu: (contextMenu) => set({ contextMenu, addMenu: null }),
  setSheet: (sheet) => set({ sheet, addMenu: null, contextMenu: null }),
  setAssetPanel: (assetPanel) => set({ assetPanel, addMenu: null, contextMenu: null }),
  setConnecting: (connecting) => set(connecting ? { connecting } : { connecting: null, connectionReject: null }),
  setConnectionReject: (connectionReject) => set((state) => (
    state.connectionReject?.nodeId === connectionReject?.nodeId
    && state.connectionReject?.reason.type === connectionReject?.reason.type
      ? state
      : { connectionReject }
  )),
  setComposerRect: (composerRect) => set((state) => (
    state.composerRect?.nodeId === composerRect?.nodeId
    && state.composerRect?.top === composerRect?.top
    && state.composerRect?.bottom === composerRect?.bottom
      ? state
      : { composerRect }
  )),
  closeMenus: () => set((state) => (
    state.addMenu || state.contextMenu ? { addMenu: null, contextMenu: null } : state
  )),
  reset: () => {
    useCanvasAlignmentStore.getState().setAlignmentGuides(null);
    set(INITIAL);
  },
}));
