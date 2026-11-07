import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { CanvasNodeData } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

const COMMIT_DELAY_MS = 1000;

export interface PromptDraft {
  readonly key?: string;
  value: string;
  /** Update the draft; commits after a typing pause. */
  set(next: string): void;
  /** Commit now (before generating, on blur, on token insertion). */
  flush(next?: string): void;
  /** Adopt text already persisted by an atomic graph edit; clear pending typing without another write. */
  acceptCommitted?(next: string): void;
  /** Apply reusable text and clear legacy hidden prompt sources in the same graph edit. */
  apply?(next: string): void;
  /** Always the latest draft, for handlers that run outside render. */
  read(): string;
}

/**
 * Local, lag-free editing of one text value. Typing does not write the store on every key
 * (each write is an undo entry and a graph revision); it commits after a pause, on flush, when
 * `key` changes (the pending text goes to the previous target's `write`) and on unmount.
 * An external change of `committed` (Agent, undo) replaces the draft.
 */
export function useTextDraft(key: string, committed: string, write: (next: string) => void, writeAppliedText = write): PromptDraft {
  const [value, setValue] = useState(committed);
  const draftRef = useRef(committed);
  const lastCommittedRef = useRef(committed);
  const timerRef = useRef<number | null>(null);
  const writeRef = useRef(write);
  const applyRef = useRef(writeAppliedText);
  useLayoutEffect(() => {
    writeRef.current = write;
    applyRef.current = writeAppliedText;
  });

  const clearTimer = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  const commit = useCallback((next: string) => {
    if (lastCommittedRef.current === next) return;
    lastCommittedRef.current = next;
    writeRef.current(next);
  }, []);

  const flush = useCallback((next = draftRef.current) => {
    clearTimer();
    draftRef.current = next;
    setValue(next);
    commit(next);
  }, [commit]);

  const set = useCallback((next: string) => {
    draftRef.current = next;
    setValue(next);
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      commit(draftRef.current);
    }, COMMIT_DELAY_MS);
  }, [commit]);

  // Leaving a target (another key, deselect, unmount) never loses typed text: it is written
  // with that target's own writer, captured when the target became current.
  useEffect(() => {
    const writeForKey = writeRef.current;
    return () => {
      clearTimer();
      if (draftRef.current !== lastCommittedRef.current) {
        lastCommittedRef.current = draftRef.current;
        writeForKey(draftRef.current);
      }
    };
  }, [key]);

  // Adopt the new target's text, or an external change to the current one.
  useEffect(() => {
    lastCommittedRef.current = committed;
    if (committed === draftRef.current) return;
    clearTimer();
    draftRef.current = committed;
    setValue(committed);
  }, [committed, key]);

  const read = useCallback(() => draftRef.current, []);
  const acceptCommitted = useCallback((next: string) => {
    clearTimer();
    draftRef.current = next;
    lastCommittedRef.current = next;
    setValue(next);
  }, []);
  const apply = useCallback((next: string) => {
    clearTimer();
    draftRef.current = next;
    lastCommittedRef.current = next;
    setValue(next);
    applyRef.current(next);
  }, []);
  return { key, value, set, flush, acceptCommitted, apply, read };
}

/** Draft of a string field on a node (`prompt`, …). */
export function usePromptDraft(nodeId: string, field: string, committed: string): PromptDraft {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  return useTextDraft(`${nodeId}:${field}`, committed, (next) => {
    updateNodeData(nodeId, { [field]: next } as Partial<CanvasNodeData>);
  }, (next) => {
    updateNodeData(nodeId, { [field]: next, ...(field === 'prompt' ? { selectedPromptPresetId: null, selectedFunctionChip: null } : {}) } as Partial<CanvasNodeData>);
  });
}
