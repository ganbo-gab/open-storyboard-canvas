import { useCallback, useEffect, useRef } from 'react';

import type {
  CanvasEdge,
  CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';

interface ClipboardSnapshot {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

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
  edges: CanvasEdge[];
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
  /** Implementation lives in Canvas.tsx because it needs access to many
   *  Canvas-local helpers (size measurement, position resolution). The
   *  hook just needs a stable callable to dispatch through. */
  duplicateNodes: (sourceNodeIds: string[]) => string | null;
  pasteImageAtCanvasPosition?: (file: File) => void | Promise<void>;
}

/**
 * Owns every keyboard / clipboard shortcut and the paste-image bridge
 * to upload nodes. Previously inlined in Canvas.tsx as two separate
 * effects (one for `paste` events, one for `keydown`) plus three
 * persistent refs that coordinated between them. Pulling all of that
 * here keeps the call site clean and makes the shortcut policy
 * self-contained.
 *
 * Coordination subtleties baked in (and why the refs exist):
 *   • `pasteImageHandledRef` lets the `paste` listener consume an
 *     image-bearing clipboard event before the `keydown` Cmd-V handler
 *     fires its node-duplication path. Without the flag we'd both
 *     drop the image into the upload node AND duplicate any cached
 *     nodes from a prior copy.
 *   • `copiedSnapshotRef` is a ref (not state) so a re-render between
 *     copy and paste doesn't reset the buffer.
 *   • `duplicateNodesRef` is a ref to a stable callable so the
 *     keydown effect can be set up once instead of re-binding every
 *     time `duplicateNodes`'s identity changes (which would happen on
 *     every nodes/edges change).
 */
export function useCanvasShortcuts(args: UseCanvasShortcutsArgs): void {
  const {
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
    duplicateNodes,
    pasteImageAtCanvasPosition,
  } = args;

  const copiedSnapshotRef = useRef<ClipboardSnapshot | null>(null);
  const pasteImageHandledRef = useRef(false);
  const duplicateNodesRef = useRef<((sourceNodeIds: string[]) => string | null) | null>(null);

  // Keep the ref pointing at the latest duplicateNodes implementation
  // without making the keyboard effect depend on it (which would
  // re-bind document listeners on every nodes/edges change).
  useEffect(() => {
    duplicateNodesRef.current = duplicateNodes;
  }, [duplicateNodes]);

  // Forward image-bearing clipboard events to the selected upload node or,
  // when no upload node is selected, to the canvas-level paste handler.
  // Sets a same-tick flag so the keydown handler's Cmd-V branch knows to
  // skip the node-duplication path.
  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      pasteImageHandledRef.current = false;
      if (isTypingTarget(event.target)) {
        return;
      }

      const imageFile = resolveClipboardImageFile(event);
      if (!imageFile) {
        return;
      }

      event.preventDefault();
      pasteImageHandledRef.current = true;
      if (selectedUploadNodeId) {
        canvasEventBus.publish('upload-node/paste-image', {
          nodeId: selectedUploadNodeId,
          file: imageFile,
        });
        return;
      }

      void pasteImageAtCanvasPosition?.(imageFile);
    };

    document.addEventListener('paste', handlePaste);
    return () => {
      document.removeEventListener('paste', handlePaste);
    };
  }, [pasteImageAtCanvasPosition, selectedUploadNodeId]);

  // Use a ref to keep the keydown handler's closure pointed at the
  // latest snapshot of selection / nodes / edges without re-binding
  // the listener on every change.
  const stateRef = useRef({
    nodes,
    edges,
    selectedNodeId,
    selectedNodeIds,
    selectedUploadNodeId,
  });
  useEffect(() => {
    stateRef.current = {
      nodes,
      edges,
      selectedNodeId,
      selectedNodeIds,
      selectedUploadNodeId,
    };
  }, [edges, nodes, selectedNodeId, selectedNodeIds, selectedUploadNodeId]);

  // Action callbacks also live behind a ref. Same reasoning — we want
  // the keydown effect to mount once.
  const actionsRef = useRef({ undo, redo, groupNodes, deleteNode, deleteNodes, scheduleCanvasPersist });
  useEffect(() => {
    actionsRef.current = { undo, redo, groupNodes, deleteNode, deleteNodes, scheduleCanvasPersist };
  }, [undo, redo, groupNodes, deleteNode, deleteNodes, scheduleCanvasPersist]);

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (isTypingTarget(event.target)) {
      return;
    }

    const { nodes: latestNodes, edges: latestEdges, selectedNodeId: latestSelectedId, selectedNodeIds: latestSelectedIds } = stateRef.current;
    const { undo: doUndo, redo: doRedo, groupNodes: doGroup, deleteNode: doDeleteOne, deleteNodes: doDeleteMany, scheduleCanvasPersist: doPersist } = actionsRef.current;

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
      const selectedIdSet = new Set(latestSelectedIds);
      copiedSnapshotRef.current = {
        nodes: latestNodes.filter((node) => selectedIdSet.has(node.id)),
        edges: latestEdges.filter(
          (edge) => selectedIdSet.has(edge.source) && selectedIdSet.has(edge.target),
        ),
      };
      return;
    }

    if (isPaste) {
      // The browser's Cmd/Ctrl+V keydown can arrive before the actual
      // paste event. Defer one tick so image paste can claim the clipboard
      // first; if it does not, fall back to duplicating copied canvas nodes.
      pasteImageHandledRef.current = false;
      window.setTimeout(() => {
        if (pasteImageHandledRef.current) {
          pasteImageHandledRef.current = false;
          return;
        }

        if (!copiedSnapshotRef.current || copiedSnapshotRef.current.nodes.length === 0) {
          return;
        }

        void duplicateNodesRef.current?.(copiedSnapshotRef.current.nodes.map((node) => node.id));
      }, 0);
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
