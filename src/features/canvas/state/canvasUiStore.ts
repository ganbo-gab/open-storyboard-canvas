import { create } from 'zustand';
import type { HandleType } from '@xyflow/react';

import type { CanvasNodeType } from '@/features/canvas/domain/canvasNodes';

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
  clientX: number;
  clientY: number;
  flowPosition: FlowPoint;
  allowedTypes?: CanvasNodeType[];
  /** Set when the menu was opened by releasing a connection drag on empty canvas. */
  connection?: PendingConnection & { fromClient: FlowPoint };
}

export interface ContextMenuState {
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
};

export const useCanvasUiStore = create<CanvasUiState>((set) => ({
  ...INITIAL,
  setTool: (tool) => set({ tool }),
  setSpacePan: (spacePan) => set((state) => (state.spacePan === spacePan ? state : { spacePan })),
  toggleMinimap: () => set((state) => ({ minimapOpen: !state.minimapOpen })),
  toggleEdgesHidden: () => set((state) => ({ edgesHidden: !state.edgesHidden })),
  toggleSnapToGrid: () => set((state) => ({ snapToGrid: !state.snapToGrid })),
  openAddMenu: (addMenu) => set({ addMenu, contextMenu: null }),
  openContextMenu: (contextMenu) => set({ contextMenu, addMenu: null }),
  setSheet: (sheet) => set({ sheet, addMenu: null, contextMenu: null }),
  setAssetPanel: (assetPanel) => set({ assetPanel, addMenu: null, contextMenu: null }),
  setConnecting: (connecting) => set({ connecting }),
  closeMenus: () => set((state) => (
    state.addMenu || state.contextMenu ? { addMenu: null, contextMenu: null } : state
  )),
  reset: () => set(INITIAL),
}));
