import { useEffect, useRef } from 'react';

import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { isAudioFile, isImageFile, isVideoFile } from '@/features/canvas/application/imageDragDrop';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { isEditableTarget } from '@/features/canvas/engine/domTargets';
import { eventMatchesChord } from '@/features/canvas/engine/shortcuts';
import { useCanvasStore } from '@/stores/canvasStore';

/** A native `paste` event normally follows ⌘V within a frame; past this, assume none is coming. */
const NATIVE_PASTE_GRACE_MS = 40;

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
  /** Paste the internal snapshot or read the system clipboard (no native event available). */
  pasteFromShortcut: () => Promise<boolean>;
  markSystemClipboardFresh: () => void;
  /** Decide whether a native paste event carries newer content than the internal snapshot. */
  shouldHandleClipboardEventPaste: (payload: { mediaFile: File | null; imageFile: File | null; text: string }) => Promise<boolean>;
  pasteMediaFromClipboardEvent: (file: File) => void | Promise<void>;
  pasteTextFromClipboardEvent: (text: string) => void | Promise<void>;
}

/**
 * Paste is the one shortcut driven by a DOM event rather than a keydown: the native `paste`
 * event carries files the async Clipboard API cannot read. Pasted media goes to a selected
 * upload node when there is one; ⌘V without a native event (WebView quirk) falls back to
 * `pasteFromShortcut`. Every other canvas shortcut lives in useCanvasHotkeys.
 */
export function usePasteBridge(handlers: PasteBridgeHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    let nativePasteAt = 0;
    const blocked = (target: EventTarget | null) => (
      isEditableTarget(target) || Boolean(useCanvasStore.getState().activeDirectorStudioNodeId)
    );

    const handlePaste = (event: ClipboardEvent) => {
      if (blocked(event.target)) return;
      const mediaFile = resolveClipboardMediaFile(event);
      const imageFile = mediaFile && isImageFile(mediaFile) ? mediaFile : resolveClipboardImageFile(event);
      const text = event.clipboardData?.getData('text/plain')?.trim() ?? '';
      if (!mediaFile && !imageFile && !text) return;
      event.preventDefault();
      nativePasteAt = Date.now();

      void (async () => {
        const current = handlersRef.current;
        let fromEvent = true;
        try {
          fromEvent = await current.shouldHandleClipboardEventPaste({ mediaFile, imageFile, text });
        } catch (error) {
          console.warn('Failed to classify clipboard paste event', error);
        }
        if (!fromEvent) {
          void current.pasteFromShortcut();
          return;
        }
        current.markSystemClipboardFresh();

        const material = mediaFile ?? imageFile;
        const selected = useCanvasStore.getState().nodes.filter((node) => node.selected);
        if (material && selected.length === 1 && selected[0].type === CANVAS_NODE_TYPES.upload) {
          canvasEventBus.publish('upload-node/paste-material', { nodeId: selected[0].id, file: material });
          return;
        }
        if (material) await current.pasteMediaFromClipboardEvent(material);
        else await current.pasteTextFromClipboardEvent(text);
      })();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !eventMatchesChord(event, 'mod+v') || blocked(event.target)) return;
      const pressedAt = Date.now();
      window.setTimeout(() => {
        if (nativePasteAt < pressedAt) void handlersRef.current.pasteFromShortcut();
      }, NATIVE_PASTE_GRACE_MS);
    };

    document.addEventListener('paste', handlePaste);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('paste', handlePaste);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);
}
