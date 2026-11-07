import { useCallback, useEffect, useRef } from 'react';
import type { ReactFlowInstance, Viewport } from '@xyflow/react';

import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';

const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

export interface UseCanvasPersistenceResult {
  /** Mutable ref the caller can read/write — true while a project restore
   *  is in progress, used to short-circuit nodes-changed handlers that
   *  would otherwise try to persist the just-restored data right back. */
  isRestoringCanvasRef: React.MutableRefObject<boolean>;
  /** Debounced persist trigger. Pass 0 for "flush ASAP" (e.g. on connect /
   *  delete which the user expects to survive a fast follow-up close).
   *  Default 140 ms is enough to coalesce typing / dragging chatter
   *  without making the persistent state feel laggy. */
  scheduleCanvasPersist: (delayMs?: number) => void;
}

// Reopening a project discards node selection. Compare every other field,
// including measurements that intentionally do not advance the graph revision.
function hasChangesBeyondNodeSelection<T extends { selected?: boolean }>(
  nodes: readonly T[],
  previous: readonly T[],
): boolean {
  if (nodes.length !== previous.length) return true;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index], before = previous[index];
    if (node === before) continue;
    for (const key in node) {
      if (key !== 'selected' && Object.hasOwn(node, key)
        && (!Object.hasOwn(before, key) || node[key] !== before[key])) return true;
    }
    for (const key in before) {
      if (key !== 'selected' && Object.hasOwn(before, key) && !Object.hasOwn(node, key)) return true;
    }
  }
  return false;
}

/**
 * Owns the project ↔ canvas persistence wiring previously inlined in
 * `Canvas.tsx`. Three responsibilities, deliberately kept together so
 * the lifecycle ordering stays in one file:
 *
 *  1. **Restore on currentProjectId change** — when the user enters a
 *     project, push the persisted nodes/edges/history into canvasStore
 *     and snap the React Flow viewport. The flag `isRestoringCanvasRef`
 *     is set true around this so the persist watcher below doesn't
 *     immediately echo the same data back to SQLite.
 *  2. **Persist watcher** — whenever nodes/edges/history changes (and
 *     we're not mid-drag, mid-restore, or in a transient resize), kick
 *     a debounced save through projectStore.
 *  3. **scheduleCanvasPersist callback** — exposed to the rest of the
 *     canvas so explicit user actions (connect, delete, paste, drop)
 *     can request an immediate flush rather than waiting for the
 *     debounce.
 *
 * The cleanup function intentionally does NOT call persistCanvasSnapshot.
 * The `currentProjectId` change happens AFTER `closeProject` has already
 * scheduled its own `immediate: true` upsert, but BEFORE `setCanvasData`
 * has populated the new project's nodes. Persisting in cleanup would
 * write the OLD project's canvasStore into the NEW project's row. The
 * two real persistence paths are: (a) `closeProject` immediate flush on
 * explicit exit, and (b) this hook's persist watcher debouncing edits.
 */
export function useCanvasPersistence(
  reactFlowInstance: ReactFlowInstance,
): UseCanvasPersistenceResult {
  const isRestoringCanvasRef = useRef(true);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setCanvasData = useCanvasStore((state) => state.setCanvasData);
  const setViewportState = useCanvasStore((state) => state.setViewportState);
  const closeImageViewer = useCanvasStore((state) => state.closeImageViewer);

  const getCurrentProject = useProjectStore((state) => state.getCurrentProject);
  const saveCurrentProject = useProjectStore((state) => state.saveCurrentProject);
  // Subscribe to currentProjectId so the restore effect has a single,
  // stable, primitive dep. Function-ref deps used to retrigger restore
  // on unrelated re-renders, which wiped in-memory edits before the
  // persist pipeline had pushed them into currentProject — that was the
  // original symptom of the "blueprint items disappear after re-open"
  // report a few rounds back.
  const currentProjectId = useProjectStore((state) => state.currentProjectId);

  const persistCanvasSnapshot = useCallback(() => {
    if (isRestoringCanvasRef.current) {
      return;
    }

    const currentProject = getCurrentProject();
    if (!currentProject) {
      return;
    }

    const currentNodes = useCanvasStore.getState().nodes;
    const currentEdges = useCanvasStore.getState().edges;
    const currentHistory = useCanvasStore.getState().history;
    saveCurrentProject(
      currentNodes,
      currentEdges,
      reactFlowInstance.getViewport(),
      currentHistory,
    );
  }, [getCurrentProject, reactFlowInstance, saveCurrentProject]);

  const scheduleCanvasPersist = useCallback(
    (delayMs = 140) => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }

      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        persistCanvasSnapshot();
      }, delayMs);
    },
    [persistCanvasSnapshot],
  );

  // Restore — runs on project enter / leave.
  useEffect(() => {
    isRestoringCanvasRef.current = true;
    const project = getCurrentProject();
    if (project) {
      setCanvasData(project.nodes, project.edges, project.history);
      setViewportState(project.viewport ?? DEFAULT_VIEWPORT);
      requestAnimationFrame(() => {
        reactFlowInstance.setViewport(project.viewport ?? DEFAULT_VIEWPORT, { duration: 0 });
      });
    } else {
      setViewportState(DEFAULT_VIEWPORT);
    }
    const restoreTimer = setTimeout(() => {
      isRestoringCanvasRef.current = false;
    }, 0);

    return () => {
      clearTimeout(restoreTimer);
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      closeImageViewer();
      // Intentionally NO persistCanvasSnapshot() here — see hook docblock
      // for the cross-project clobber that would result.
    };
    // currentProjectId is the only dep we want to re-run on; the rest are
    // stable callbacks/instance refs from zustand/react-flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProjectId]);

  // Persist watcher — fires on every meaningful canvas change. The drag /
  // restore guards keep us from writing transient state (mid-drag values
  // or the just-restored persistence echo).
  // Observe graph changes without making the entire Canvas (chrome and actions) render per drag.
  useEffect(() => useCanvasStore.subscribe((state, previous) => {
    if (state.nodes === previous.nodes && state.edges === previous.edges
      && state.history === previous.history && state.dragHistorySnapshot === previous.dragHistorySnapshot) return;
    if (isRestoringCanvasRef.current || state.dragHistorySnapshot) return;
    if (state.edges === previous.edges && state.history === previous.history
      && state.dragHistorySnapshot === previous.dragHistorySnapshot
      && !hasChangesBeyondNodeSelection(state.nodes, previous.nodes)) return;
    scheduleCanvasPersist();
  }), [scheduleCanvasPersist]);

  return { isRestoringCanvasRef, scheduleCanvasPersist };
}
