import { create } from 'zustand';

export type PanelType = 'multiAngle' | 'lighting' | 'multiFunction' | 'promptPreset' | 'edit' | 'gridSplit' | 'panorama' | 'blueprint';

export interface PanelAnchor {
  /** Canvas node this panel is attached to. Panel closes if the node unmounts. */
  nodeId: string;
  /** Stable key identifying which button inside NodeActionToolbar opened the
   *  panel, so the overlay can locate the right DOM element each frame. */
  buttonKey: PanelType;
  /** Rect captured at open time; used as initial render position and as a
   *  fallback if the live DOM lookup fails (e.g. during hot reloads). */
  fallbackRect: DOMRect;
}

export interface PanelState {
  type: PanelType | null;
  anchor: PanelAnchor | null;
  isOpen: boolean;
  openMode: 'click' | 'hover' | null;
  /** True while pointer is over the panel itself; cancels hover-close timer. */
  isPointerOverPanel: boolean;
}

interface PanelStateStore extends PanelState {
  openPanel: (type: PanelType, anchor: PanelAnchor, openMode?: 'click' | 'hover') => void;
  closePanel: () => void;
  closeAllPanels: () => void;
  setPointerOverPanel: (over: boolean) => void;
}

const initialPanelState: PanelState = {
  type: null,
  anchor: null,
  isOpen: false,
  openMode: null,
  isPointerOverPanel: false,
};

export const usePanelStateStore = create<PanelStateStore>((set, get) => ({
  ...initialPanelState,

  openPanel: (type, anchor, openMode = 'click') => {
    const current = get();
    if (openMode === 'click' && current.isOpen && current.openMode === 'click' && current.type === type && current.anchor?.nodeId === anchor.nodeId) {
      set(initialPanelState);
      return;
    }
    // hover-open must not overwrite a click-pinned panel
    if (openMode === 'hover' && current.openMode === 'click' && current.isOpen) {
      return;
    }
    set({
      type,
      anchor,
      isOpen: true,
      openMode,
      isPointerOverPanel: false,
    });
  },

  closePanel: () => set(initialPanelState),
  closeAllPanels: () => set(initialPanelState),
  setPointerOverPanel: (over) => set({ isPointerOverPanel: over }),
}));

/** Backwards-compat shim: old code wanted `nodeId` + `buttonRect` directly. */
export function getPanelNodeId(state: PanelState): string | null {
  return state.anchor?.nodeId ?? null;
}
export function getPanelButtonRect(state: PanelState): DOMRect | null {
  return state.anchor?.fallbackRect ?? null;
}
