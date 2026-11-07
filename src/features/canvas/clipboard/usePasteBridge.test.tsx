// @vitest-environment jsdom
import { cleanup, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { isTauri } from '@tauri-apps/api/core';
import { usePasteBridge } from './usePasteBridge';
vi.mock('@tauri-apps/api/core', () => ({ isTauri: vi.fn(() => true) }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });
beforeEach(() => vi.mocked(isTauri).mockReturnValue(true));
function setup() { const paste = vi.fn(async () => true); renderHook(() => usePasteBridge({ capturePosition: () => ({ x: 10, y: 20 }), pasteFromShortcut: paste })); return paste; }
it('uses the same desktop pipeline exactly once even if a WebView sends a late native paste event', () => {
  vi.useFakeTimers(); const paste = setup();
  fireEvent.keyDown(document.body, { key: 'v', code: 'KeyV', metaKey: true, ctrlKey: true });
  expect(paste).toHaveBeenCalledTimes(1);
  fireEvent.paste(document.body, { clipboardData: { getData: () => 'old payload' } });
  vi.advanceTimersByTime(1000);
  expect(paste).toHaveBeenCalledTimes(1);
  fireEvent.paste(document.body);
  expect(paste).toHaveBeenCalledTimes(2);
});
it('keeps browser native media paste and blocks editor/modal keyboard ownership', () => {
  vi.mocked(isTauri).mockReturnValue(false); const paste = setup();
  fireEvent.keyDown(document.body, { key: 'v', metaKey: true, ctrlKey: true });
  expect(paste).not.toHaveBeenCalled();
  const file = new File(['video'], 'clip.mp4', { type: 'video/mp4' });
  fireEvent.paste(document.body, { clipboardData: { files: [file], items: [], getData: () => '' } });
  expect(paste).toHaveBeenCalledWith({ x: 10, y: 20 }, expect.objectContaining({ mediaFiles: [file] }));
  const input = document.createElement('textarea'); document.body.append(input);
  fireEvent.paste(input); input.remove();
  const modal = document.createElement('div'); modal.setAttribute('aria-modal', 'true'); document.body.append(modal);
  fireEvent.paste(document.body); modal.remove();
  expect(paste).toHaveBeenCalledTimes(1);
});
