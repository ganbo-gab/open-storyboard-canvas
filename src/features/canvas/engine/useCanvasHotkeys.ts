import { useEffect, useRef, type RefObject } from 'react';

import { useCanvasUiStore, type FlowPoint } from '@/features/canvas/state/canvasUiStore';
import { useCanvasStore } from '@/stores/canvasStore';
import type { CanvasActions } from './canvasActions';
import { isEditableTarget, readSelectedText } from './domTargets';
import { matchShortcut, type CanvasShortcutId } from './shortcuts';

/** A modal on screen owns the keyboard: layering is overlay > dialog > canvas. */
const BLOCKING_SURFACES = 'dialog[open], [aria-modal="true"], .director-studio-shell, [data-canvas-shortcuts-disabled="true"]';

/**
 * Last pointer position over the canvas (client coordinates), or null once it leaves.
 * Paste and Tab place things under the pointer when it is on the canvas.
 */
export function useCanvasPointer(wrapperRef: RefObject<HTMLElement | null>): RefObject<FlowPoint | null> {
  const pointerRef = useRef<FlowPoint | null>(null);
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const handleMove = (event: MouseEvent) => {
      const rect = wrapper.getBoundingClientRect();
      pointerRef.current = event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom
        ? { x: event.clientX, y: event.clientY } : null;
    };
    // Capture also sees moves stopped by node/tool controls. Enter/down refresh the location
    // when returning from another window or after full-screen changes without a mouse move.
    const events = ['pointermove', 'pointerover', 'pointerdown', 'contextmenu', 'mousemove'] as const;
    for (const name of events) document.addEventListener(name, handleMove, { capture: true, passive: true });
    return () => {
      for (const name of events) document.removeEventListener(name, handleMove, true);
    };
  }, [wrapperRef]);
  return pointerRef;
}

function hasSelection(): boolean {
  const { nodes, edges } = useCanvasStore.getState();
  return nodes.some((node) => node.selected) || edges.some((edge) => edge.selected);
}

/**
 * Canvas keyboard layer. Every binding comes from the shortcut registry, so the sheet, menus
 * and tooltips always show what actually runs. Paste is not here: it is event-driven
 * (usePasteBridge). Keys typed into fields, dialogs and the stage never reach the canvas.
 */
export function useCanvasHotkeys(
  actions: CanvasActions,
  wrapperRef: RefObject<HTMLElement | null>,
  pointerRef: RefObject<FlowPoint | null>
): void {
  useEffect(() => {
    const run: Partial<Record<CanvasShortcutId, () => boolean | void>> = {
      'tool.select': () => useCanvasUiStore.getState().setTool('select'),
      'tool.hand': () => useCanvasUiStore.getState().setTool('hand'),
      'node.add': () => actions.openAddMenu(pointerRef.current),
      'edit.undo': actions.undo,
      'edit.redo': actions.redo,
      'edit.copy': () => {
        // Selected text keeps the native copy.
        const wrapper = wrapperRef.current;
        if ((wrapper && readSelectedText(wrapper)) || !useCanvasStore.getState().nodes.some((node) => node.selected)) return false;
        actions.copySelection();
      },
      'edit.duplicate': actions.duplicateSelection,
      'edit.delete': () => {
        if (!hasSelection()) return false;
        actions.deleteSelection();
      },
      'edit.selectAll': actions.selectAll,
      'organize.group': actions.groupSelection,
      'organize.ungroup': actions.ungroupSelection,
      'organize.connect': actions.connectSelection,
      'organize.tidy': actions.organizeCanvas,
      'view.zoomIn': actions.zoomIn,
      'view.zoomOut': actions.zoomOut,
      'view.fit': actions.fitView,
      'view.actualSize': () => actions.zoomTo(1),
      'view.palette': () => useCanvasUiStore.getState().setSheet('palette'),
      'view.shortcuts': () => useCanvasUiStore.getState().setSheet('shortcuts'),
      'generate.run': actions.generateSelection,
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || isEditableTarget(event.target)) return;
      const ui = useCanvasUiStore.getState();
      if (ui.sheet || useCanvasStore.getState().activeDirectorStudioNodeId) return;
      if (document.querySelector(BLOCKING_SURFACES)) return;

      if (event.key === 'Escape') {
        if (ui.addMenu || ui.contextMenu) {
          ui.closeMenus();
        } else if (hasSelection()) {
          actions.clearSelection();
        } else {
          return;
        }
        event.preventDefault();
        return;
      }

      const id = matchShortcut(event);
      const handler = id ? run[id] : undefined;
      if (!handler) return;
      // Close transient menus first so a key that opens one (Tab) keeps it open.
      ui.closeMenus();
      if (handler() === false) return;
      event.preventDefault();
      ui.closeMenus();
    };

    // macOS menu accelerators can dispatch `copy` directly without a DOM keydown.
    const handleCopy = (event: ClipboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target) || document.querySelector(BLOCKING_SURFACES)) return;
      const ui = useCanvasUiStore.getState();
      if (ui.sheet || useCanvasStore.getState().activeDirectorStudioNodeId) return;
      const wrapper = wrapperRef.current;
      if (!wrapper || readSelectedText(wrapper) || !useCanvasStore.getState().nodes.some(node => node.selected)) return;
      event.preventDefault();
      actions.copySelection();
    };

    window.addEventListener('keydown', handleKeyDown);
    document.addEventListener('copy', handleCopy);
    return () => { window.removeEventListener('keydown', handleKeyDown); document.removeEventListener('copy', handleCopy); };
  }, [actions, pointerRef, wrapperRef]);
}
