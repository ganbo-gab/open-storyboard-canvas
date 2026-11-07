import { useEffect, useRef } from 'react';

import { isTauri } from '@tauri-apps/api/core';
import type { ClipboardContentReadResult } from './clipboardIO';
import { isAudioFile, isImageFile, isVideoFile, isMaterialFile } from '@/features/canvas/application/imageDragDrop';
import { isEditableTarget } from '@/features/canvas/engine/domTargets';
import { eventMatchesChord, matchShortcut } from '@/features/canvas/engine/shortcuts';
import { useCanvasStore } from '@/stores/canvasStore';

function namedClipboardFile(file: File, mime: string, fallbackExtension: string, prefix: string): File {
  if (typeof file.name === 'string' && file.name.trim()) return file;
  const subtype = mime.split('/')[1]?.split('+')[0] || fallbackExtension;
  return new File([file], `${prefix}.${subtype}`, { type: file.type || mime, lastModified: Date.now() });
}

export function resolveClipboardImageFile(event: ClipboardEvent): File | null {
  for (const item of Array.from(event.clipboardData?.items ?? [])) {
    if (!item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) return namedClipboardFile(file, item.type, 'png', 'pasted-image');
  }
  return null;
}

function resolveClipboardMediaFile(event: ClipboardEvent): File | null {
  const candidates: File[] = [];
  for (const item of Array.from(event.clipboardData?.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (!file) continue;
    const kind = item.type.startsWith('video/') ? 'video' : item.type.startsWith('audio/') ? 'audio' : 'image';
    const extension = kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'mp3';
    candidates.push(namedClipboardFile(file, item.type, extension, `pasted-${kind}`));
  }
  return candidates.find(isImageFile) ?? candidates.find(isVideoFile) ?? candidates.find(isAudioFile) ?? null;
}

export interface PasteBridgeHandlers {
  capturePosition(): { x: number; y: number } | Promise<{ x: number; y: number }>;
  pasteFromShortcut(position?: { x: number; y: number } | Promise<{ x: number; y: number }>, content?: ClipboardContentReadResult): Promise<boolean>;
}

/** Desktop keyboard and context menus both read the native clipboard. Browser paste events
 * supply the same pipeline with their clipboard snapshot, including binary media files. */
export function usePasteBridge(handlers: PasteBridgeHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  useEffect(() => {
    let suppressNativeUntil = 0;
    const blocked = (target: EventTarget | null) => isEditableTarget(target)
      || Boolean(useCanvasStore.getState().activeDirectorStudioNodeId)
      || Boolean(document.querySelector('[aria-modal="true"], dialog[open], [data-canvas-shortcuts-disabled="true"]'));
    const handlePaste = (event: ClipboardEvent) => {
      if (blocked(event.target)) return;
      event.preventDefault();
      if (Date.now() < suppressNativeUntil) return;
      const position = handlersRef.current.capturePosition();
      if (isTauri()) { void handlersRef.current.pasteFromShortcut(position); return; }
      const files = Array.from(event.clipboardData?.files ?? []).filter(isMaterialFile);
      const fallback = resolveClipboardMediaFile(event);
      if (!files.length && fallback) files.push(fallback);
      const text = event.clipboardData?.getData('text/plain') ?? '';
      const content = { mediaFiles: files, mediaFile: files[0] ?? null,
        imageFile: files.find(isImageFile) ?? null, text };
      void handlersRef.current.pasteFromShortcut(position, content);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || matchShortcut(event) !== 'edit.paste' || blocked(event.target)) return;
      // Browser standard paste must retain its native event (binary clipboard access).
      if (!isTauri() && eventMatchesChord(event, 'mod+v')) return;
      event.preventDefault();
      // Some WebViews still dispatch a native event after handled keydown. Consume it once.
      suppressNativeUntil = Date.now() + 500;
      void handlersRef.current.pasteFromShortcut(handlersRef.current.capturePosition());
    };
    document.addEventListener('paste', handlePaste);
    document.addEventListener('keydown', handleKeyDown);
    return () => { document.removeEventListener('paste', handlePaste); document.removeEventListener('keydown', handleKeyDown); };
  }, []);
}
