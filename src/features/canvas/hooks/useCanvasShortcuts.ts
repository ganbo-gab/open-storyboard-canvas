import { useCallback, useEffect, useRef } from 'react';

import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) {
    return false;
  }
  const tagName = element.tagName.toLowerCase();
  return tagName === 'input' || tagName === 'textarea' || element.isContentEditable;
}

export function resolveClipboardImageFile(event: ClipboardEvent): File | null {
  const clipboardItems = event.clipboardData?.items;
  if (!clipboardItems) {
    return null;
  }

  for (const item of Array.from(clipboardItems)) {
    if (!item.type.startsWith('image/')) {
      continue;
    }

    const file = item.getAsFile();
    if (!file) {
      continue;
    }

    const existingName = typeof file.name === 'string' ? file.name.trim() : '';
    if (existingName) {
      return file;
    }

    const subtype = item.type.split('/')[1]?.split('+')[0] || 'png';
    return new File([file], `pasted-image.${subtype}`, {
      type: file.type || item.type,
      lastModified: Date.now(),
    });
  }
  return null;
}

export interface UseCanvasShortcutsArgs {
  nodes: CanvasNode[];
  selectedNodeId: string | null;
  selectedNodeIds: string[];
  /** When the only selected node is an UploadNode, paste-image goes to
   *  it directly instead of duplicating clipboard nodes. Pass `null` to
   *  short-circuit the special case. */
  selectedUploadNodeId: string | null;
  /** Hook from useCanvasPersistence. Called after destructive shortcuts
   *  so undo / redo / delete don't lose state on a fast follow-up close. */
  scheduleCanvasPersist: (delayMs?: number) => void;
  undo: () => boolean;
  redo: () => boolean;
  groupNodes: (nodeIds: string[]) => string | null;
  deleteNode: (nodeId: string) => void;
  deleteNodes: (nodeIds: string[]) => void;
  copyNodesToClipboard: (sourceNodeIds: string[]) => void;
  pasteFromShortcut: () => boolean | Promise<boolean>;
  markSystemClipboardFresh: () => void;
  pasteImageAtCanvasPosition?: (file: File) => void | Promise<void>;
  pasteImageFromClipboardEvent?: (file: File) => void | Promise<void>;
  pasteTextFromClipboardEvent?: (text: string) => void | Promise<void>;
  shouldHandleClipboardEventPaste?: (payload: {
    imageFile: File | null;
    text: string;
  }) => boolean | Promise<boolean>;
}

/**
 * Owns every keyboard / clipboard shortcut and the paste-image bridge
 * to upload nodes. Previously inlined in Canvas.tsx as two separate
 * effects (one for `paste` events, one for `keydown`) plus three
 * persistent refs that coordinated between them. Pulling all of that
 * here keeps the call site clean and makes the shortcut policy
 * self-contained.
 *
 * Clipboard source arbitration lives in Canvas.tsx so keyboard shortcuts
 * and context menus share one internal/system paste policy.
 */
export function useCanvasShortcuts(args: UseCanvasShortcutsArgs): void {
  const {
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
    pasteFromShortcut,
    markSystemClipboardFresh,
    pasteImageAtCanvasPosition,
    pasteImageFromClipboardEvent,
    pasteTextFromClipboardEvent,
    shouldHandleClipboardEventPaste,
  } = args;
  const pasteEventHandledAtRef = useRef(0);

  // Forward image-bearing clipboard events to the selected upload node or,
  // when no upload node is selected, to the canvas-level paste handler.
  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      if (isTypingTarget(event.target)) {
        return;
      }

      const imageFile = resolveClipboardImageFile(event);
      const text = event.clipboardData?.getData('text/plain')?.trim() ?? '';
      if (!imageFile && !text) {
        return;
      }

      event.preventDefault();
      pasteEventHandledAtRef.current = Date.now();

      void (async () => {
        let shouldHandle = true;
        try {
          shouldHandle = shouldHandleClipboardEventPaste
            ? await shouldHandleClipboardEventPaste({ imageFile, text })
            : true;
        } catch (error) {
          console.warn('Failed to classify clipboard paste event', error);
        }

        if (!shouldHandle) {
          void pasteFromShortcut();
          return;
        }

        markSystemClipboardFresh();

        if (imageFile) {
          if (selectedUploadNodeId) {
            canvasEventBus.publish('upload-node/paste-image', {
              nodeId: selectedUploadNodeId,
              file: imageFile,
            });
            return;
          }

          void (pasteImageFromClipboardEvent ?? pasteImageAtCanvasPosition)?.(imageFile);
          return;
        }

        if (text && pasteTextFromClipboardEvent) {
          void pasteTextFromClipboardEvent(text);
        }
      })();
    };

    document.addEventListener('paste', handlePaste);
    return () => {
      document.removeEventListener('paste', handlePaste);
    };
  }, [
    markSystemClipboardFresh,
    pasteImageAtCanvasPosition,
    pasteImageFromClipboardEvent,
    pasteFromShortcut,
    pasteTextFromClipboardEvent,
    selectedUploadNodeId,
    shouldHandleClipboardEventPaste,
  ]);

  // Use a ref to keep the keydown handler's closure pointed at the
  // latest snapshot of selection / nodes / edges without re-binding
  // the listener on every change.
  const stateRef = useRef({
    nodes,
    selectedNodeId,
    selectedNodeIds,
    selectedUploadNodeId,
  });
  useEffect(() => {
    stateRef.current = {
      nodes,
      selectedNodeId,
      selectedNodeIds,
      selectedUploadNodeId,
    };
  }, [nodes, selectedNodeId, selectedNodeIds, selectedUploadNodeId]);

  // Action callbacks also live behind a ref. Same reasoning — we want
  // the keydown effect to mount once.
  const actionsRef = useRef({
    undo,
    redo,
    groupNodes,
    deleteNode,
    deleteNodes,
    scheduleCanvasPersist,
    copyNodesToClipboard,
    pasteFromShortcut,
    markSystemClipboardFresh,
  });
  useEffect(() => {
    actionsRef.current = {
      undo,
      redo,
      groupNodes,
      deleteNode,
      deleteNodes,
      scheduleCanvasPersist,
      copyNodesToClipboard,
      pasteFromShortcut,
      markSystemClipboardFresh,
    };
  }, [
    undo,
    redo,
    groupNodes,
    deleteNode,
    deleteNodes,
    scheduleCanvasPersist,
    copyNodesToClipboard,
    pasteFromShortcut,
    markSystemClipboardFresh,
  ]);

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (isTypingTarget(event.target)) {
      return;
    }

    const { selectedNodeId: latestSelectedId, selectedNodeIds: latestSelectedIds } = stateRef.current;
    const {
      undo: doUndo,
      redo: doRedo,
      groupNodes: doGroup,
      deleteNode: doDeleteOne,
      deleteNodes: doDeleteMany,
      scheduleCanvasPersist: doPersist,
      copyNodesToClipboard: doCopy,
      pasteFromShortcut: doPasteFromShortcut,
    } = actionsRef.current;

    const commandPressed = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    const isUndo = commandPressed && key === 'z' && !event.shiftKey;
    const isRedo = commandPressed && (key === 'y' || (key === 'z' && event.shiftKey));
    const isGroup = commandPressed && key === 'g';
    const isCopy = commandPressed && key === 'c' && !event.shiftKey;
    const isPaste = commandPressed && key === 'v' && !event.shiftKey;

    if (isCopy) {
      if (latestSelectedIds.length === 0) {
        return;
      }
      event.preventDefault();
      doCopy(latestSelectedIds);
      return;
    }

    if (isPaste) {
      const pasteStartedAt = Date.now();
      window.setTimeout(() => {
        if (pasteEventHandledAtRef.current >= pasteStartedAt) {
          return;
        }
        void doPasteFromShortcut();
      }, 40);
      return;
    }

    if (isUndo || isRedo) {
      event.preventDefault();
      const changed = isUndo ? doUndo() : doRedo();
      if (changed) {
        doPersist(0);
      }
      return;
    }

    if (isGroup) {
      if (latestSelectedIds.length < 2) {
        return;
      }
      event.preventDefault();
      const createdGroupId = doGroup(latestSelectedIds);
      if (createdGroupId) {
        doPersist(0);
      }
      return;
    }

    if (event.key !== 'Delete' && event.key !== 'Backspace') {
      return;
    }

    const idsToDelete = latestSelectedIds.length > 0
      ? latestSelectedIds
      : latestSelectedId
        ? [latestSelectedId]
        : [];
    if (idsToDelete.length === 0) {
      return;
    }

    event.preventDefault();
    if (idsToDelete.length === 1) {
      doDeleteOne(idsToDelete[0]);
    } else {
      doDeleteMany(idsToDelete);
    }
    doPersist(0);
  }, []);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);
}
