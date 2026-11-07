import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { BlueprintNodeData } from '@/features/canvas/domain/canvasNodes';
import type { BlueprintSceneExportOptions, BlueprintSceneHandle } from '@/features/canvas/ui/BlueprintScene';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { showErrorDialog } from '@/features/canvas/application/errorDialog';
import { appendSnapshotHistory, isDataImageUrl, normalizeSnapshotHistory, persistDirectorStudioImageSource, persistSnapshotHistory, waitForNextStageFrame } from '../application/stageSnapshotMedia';

type SnapshotData = Pick<BlueprintNodeData, 'snapshotUrl' | 'snapshotHistory' | 'activeDirectorStudioProjectId'>;
interface Options {
  nodeId: string;
  data: SnapshotData;
  editorRef: RefObject<Pick<BlueprintSceneHandle, 'exportPng'> | null>;
  exportOptions(): BlueprintSceneExportOptions;
  commitPendingTextDrafts(): boolean;
  onUpdateNodeData(patch: Partial<BlueprintNodeData>): void;
  onAddSnapshotToCanvas?: (url: string) => Promise<boolean | void> | boolean | void;
  onClose(): void;
}

/** Owns screenshot history edits, publication, feedback and async lifetime for one stage. */
export function useStageSnapshotActions(options: Options) {
  const { t } = useTranslation();
  const current = useRef(options); current.current = options;
  const lifecycle = useRef({ active: true });
  const editing = useRef(false), publishing = useRef(false);
  const editRevision = useRef(0);
  const [isAddingSnapshotToCanvas, setIsAddingSnapshotToCanvas] = useState(false);
  const [captureToast, setCaptureToast] = useState<string | null>(null);
  const [captureFlashKey, setCaptureFlashKey] = useState(0);
  useEffect(() => {
    const scope = { active: true }; lifecycle.current = scope;
    editing.current = false; publishing.current = false;
    setIsAddingSnapshotToCanvas(false); setCaptureToast(null);
    return () => { scope.active = false; };
  }, [options.nodeId, options.data.activeDirectorStudioProjectId]);
  const fail = useCallback(async (error: unknown) => {
    await showErrorDialog(error instanceof Error ? error.message : t('directorStudio.addToCanvasFailed'), t('common.error'));
  }, [t]);
  const historyOf = (data: SnapshotData) => normalizeSnapshotHistory(data.snapshotUrl, data.snapshotHistory);
  const capturePersistedSceneSnapshot = useCallback(async (fallback: string | null | undefined) => {
    const state = current.current;
    const source = state.editorRef.current?.exportPng(state.exportOptions()) ?? fallback ?? null;
    return source ? await persistDirectorStudioImageSource(source) : null;
  }, []);

  const edit = useCallback(async (prepare: (data: SnapshotData) => Promise<Partial<BlueprintNodeData> | null>, feedback = false) => {
    if (editing.current || publishing.current) return;
    const scope = lifecycle.current; const state = current.current; const revision = editRevision.current;
    editing.current = true;
    try {
      const patch = await prepare(state.data);
      if (!scope.active || revision !== editRevision.current || !patch) return;
      current.current.onUpdateNodeData(patch);
      if (feedback && patch.snapshotUrl) { setCaptureFlashKey((value) => value + 1); setCaptureToast(resolveImageDisplayUrl(patch.snapshotUrl) ?? patch.snapshotUrl); }
    } catch (error) { if (scope.active) await fail(error); }
    finally { if (scope.active) editing.current = false; }
  }, [fail]);
  const captureScreenshot = useCallback(async () => {
    await edit(async (data) => {
      const snapshotUrl = await capturePersistedSceneSnapshot(null);
      if (!snapshotUrl) throw new Error(t('directorStudio.addToCanvasNoSnapshot'));
      return { snapshotUrl, snapshotHistory: appendSnapshotHistory(await persistSnapshotHistory(historyOf(data)), snapshotUrl) };
    }, true);
  }, [capturePersistedSceneSnapshot, edit, t]);
  const selectSnapshot = useCallback(async (source: string) => {
    await edit(async (data) => {
      const snapshotUrl = await persistDirectorStudioImageSource(source);
      const history = await persistSnapshotHistory(historyOf(data));
      return { snapshotUrl, snapshotHistory: history.map((url) => url === source ? snapshotUrl : url) };
    });
  }, [edit]);
  const deleteSnapshot = useCallback(async (source: string) => {
    await edit(async (data) => {
      const snapshotHistory = await persistSnapshotHistory(historyOf(data).filter((url) => url !== source));
      const next = data.snapshotUrl === source ? snapshotHistory.at(-1) ?? null : data.snapshotUrl ?? snapshotHistory.at(-1) ?? null;
      return { snapshotHistory, snapshotUrl: next ? await persistDirectorStudioImageSource(next) : null };
    });
  }, [edit]);
  const clearCurrentSnapshot = useCallback(() => { const source = current.current.data.snapshotUrl; if (source) void deleteSnapshot(source); }, [deleteSnapshot]);
  const clearAllSnapshots = useCallback(() => {
    // An in-flight encode must not repopulate screenshots after Clear all.
    editRevision.current++;
    current.current.onUpdateNodeData({ snapshotUrl: null, snapshotHistory: [] });
  }, []);

  const publish = useCallback(async (all: boolean) => {
    const state = current.current;
    const history = historyOf(state.data);
    if (!state.onAddSnapshotToCanvas || publishing.current || editing.current || (all && !history.length)) return;
    const scope = lifecycle.current;
    publishing.current = true; setIsAddingSnapshotToCanvas(true);
    try {
      const hadDraftWrites = state.commitPendingTextDrafts();
      const raw = state.data.snapshotUrl ?? (all ? history.at(-1) : state.editorRef.current?.exportPng(state.exportOptions()));
      if (!raw) throw new Error(t('directorStudio.addToCanvasNoSnapshot'));
      const snapshotUrl = await persistDirectorStudioImageSource(raw);
      const persisted = await persistSnapshotHistory(history);
      if (!scope.active) return;
      const changed = persisted.some((url, index) => url !== history[index]);
      if (snapshotUrl !== state.data.snapshotUrl || (!all && isDataImageUrl(raw)) || changed) {
        current.current.onUpdateNodeData({ snapshotUrl, snapshotHistory: all ? persisted : appendSnapshotHistory(persisted, snapshotUrl) });
      }
      if (hadDraftWrites) await waitForNextStageFrame();
      for (const url of all ? persisted : [snapshotUrl]) {
        if (!scope.active) return;
        const result = await current.current.onAddSnapshotToCanvas?.(url);
        if (result === false) return;
      }
      if (scope.active) current.current.onClose();
    } catch (error) { if (scope.active) await fail(error); }
    finally { if (scope.active) { publishing.current = false; setIsAddingSnapshotToCanvas(false); } }
  }, [fail, t]);
  const addSnapshotToCanvas = useCallback(() => publish(false), [publish]);
  const addAllSnapshotsToCanvas = useCallback(() => publish(true), [publish]);
  return { captureScreenshot, capturePersistedSceneSnapshot, selectSnapshot, deleteSnapshot, clearCurrentSnapshot, clearAllSnapshots,
    addSnapshotToCanvas, addAllSnapshotsToCanvas, isAddingSnapshotToCanvas, captureToast, setCaptureToast, captureFlashKey };
}
