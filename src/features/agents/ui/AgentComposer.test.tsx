// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemClipboardContent } from '@/commands/image';

const native = vi.hoisted(() => ({ enabled: false, read: vi.fn(), load: vi.fn() }));
vi.mock('@tauri-apps/api/core', async (original) => ({ ...await original<typeof import('@tauri-apps/api/core')>(), isTauri: () => native.enabled }));
vi.mock('@/commands/image', async (original) => ({ ...await original<typeof import('@/commands/image')>(), readSystemClipboard: native.read, loadImage: native.load }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { AgentComposer, shouldSubmitAgentComposerEnter } from './AgentComposer';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  native.enabled = false; native.read.mockReset(); native.load.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function renderComposer(props: { submitDisabled: boolean; running?: boolean; onSubmit: () => void }) {
  act(() => {
    root.render(
      <AgentComposer
        value="draft"
        placeholder="placeholder"
        textareaRef={createRef<HTMLTextAreaElement>()}
        running={props.running ?? false}
        submitDisabled={props.submitDisabled}
        tools={null}
        onChange={() => {}}
        onSubmit={props.onSubmit}
        onStop={() => {}}
      />,
    );
  });
}

function pressEnter() {
  act(() => {
    container.querySelector('textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}

describe('AgentComposer', () => {
  it('does not submit the Enter key that commits an IME composition', () => {
    expect(shouldSubmitAgentComposerEnter({
      key: 'Enter', shiftKey: false, nativeIsComposing: true, trackedIsComposing: true, compositionEndedAgoMs: 0,
    })).toBe(false);
    expect(shouldSubmitAgentComposerEnter({
      key: 'Enter', shiftKey: false, nativeIsComposing: false, trackedIsComposing: false, compositionEndedAgoMs: 20,
    })).toBe(false);
    expect(shouldSubmitAgentComposerEnter({
      key: 'Enter', shiftKey: true, nativeIsComposing: false, trackedIsComposing: false, compositionEndedAgoMs: 120,
    })).toBe(false);
    expect(shouldSubmitAgentComposerEnter({
      key: 'Enter', shiftKey: false, nativeIsComposing: false, trackedIsComposing: false, compositionEndedAgoMs: 120,
    })).toBe(true);
  });

  it('never submits from the keyboard while the owner blocks sending or a turn is running', () => {
    const onSubmit = vi.fn();
    renderComposer({ submitDisabled: true, onSubmit });
    pressEnter();
    renderComposer({ submitDisabled: false, running: true, onSubmit });
    pressEnter();
    expect(onSubmit).not.toHaveBeenCalled();
    renderComposer({ submitDisabled: false, onSubmit });
    pressEnter();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

it('pastes an image as an attachment and keeps the accompanying file path out of the prompt', async () => {
  const attach = vi.fn().mockResolvedValue(undefined); const change = vi.fn();
  act(() => root.render(<AgentComposer value="" placeholder="paste" textareaRef={createRef<HTMLTextAreaElement>()} running={false} submitDisabled tools={null} onChange={change} onSubmit={() => {}} onStop={() => {}} onAttachFiles={attach} />));
  const file = new File(['image'], 'scene.png', { type: 'image/png' });
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files: [file], getData: () => '/tmp/scene.png' } });
  await act(async () => { container.querySelector('textarea')?.dispatchEvent(event); });
  expect(event.defaultPrevented).toBe(true); expect(attach).toHaveBeenCalledWith([file]); expect(change).not.toHaveBeenCalled();
});

function paste(text = '', files: File[] = []) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files, items: [], getData: () => text } });
  container.querySelector('textarea')?.dispatchEvent(event);
  return event;
}
function attachmentComposer(attach: (files: File[]) => Promise<void>, submit = vi.fn(), key = 'session') {
  root.render(<AgentComposer key={key} value="Describe the picture" placeholder="paste" textareaRef={createRef<HTMLTextAreaElement>()} running={false} submitDisabled={false} tools={null} onChange={() => {}} onSubmit={submit} onStop={() => {}} onAttachFiles={attach} />);
}

it('reads a text-only native image path directly instead of attaching a different global clipboard image', async () => {
  native.enabled = true;
  native.read.mockResolvedValue({ image: { bytes: [2], mimeType: 'image/png', fileName: 'wrong.png' } });
  native.load.mockResolvedValue('data:image/png;base64,AQ==');
  const attach = vi.fn(async (_files: File[]) => {});
  act(() => attachmentComposer(attach));
  await act(async () => { paste('/tmp/explicit.png'); });
  expect(native.load).toHaveBeenCalledExactlyOnceWith('/tmp/explicit.png');
  expect(native.read).not.toHaveBeenCalled();
  expect(attach).toHaveBeenCalledOnce();
  expect(attach.mock.calls[0][0][0]).toMatchObject({ name: 'explicit.png', type: 'image/png' });
});

it('holds a synchronous busy guard through native clipboard resolution and ignores overlapping paste/drop', async () => {
  native.enabled = true;
  const clipboard = Promise.withResolvers<SystemClipboardContent | null>();
  native.read.mockReturnValue(clipboard.promise);
  const attach = vi.fn(async (_files: File[]) => {}); const submit = vi.fn();
  act(() => attachmentComposer(attach, submit));
  act(() => { paste(); paste();
    container.querySelector('textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  expect(native.read).toHaveBeenCalledOnce(); expect(submit).not.toHaveBeenCalled(); expect(attach).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="canvasAgent.send"]')?.disabled).toBe(true);
  await act(async () => { clipboard.resolve({ image: { bytes: [1], mimeType: 'image/png', fileName: 'pasted.png' } }); });
  expect(attach).toHaveBeenCalledOnce();
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="canvasAgent.send"]')?.disabled).toBe(false);
});

it('drops a late native image after its conversation composer is replaced', async () => {
  native.enabled = true;
  const clipboard = Promise.withResolvers<SystemClipboardContent | null>();
  native.read.mockReturnValue(clipboard.promise);
  const oldAttach = vi.fn(async (_files: File[]) => {}); const nextAttach = vi.fn(async (_files: File[]) => {});
  act(() => attachmentComposer(oldAttach));
  act(() => { paste(); });
  act(() => attachmentComposer(nextAttach, vi.fn(), 'next-session'));
  await act(async () => { clipboard.resolve({ image: { bytes: [1], mimeType: 'image/png', fileName: 'old.png' } }); });
  expect(oldAttach).not.toHaveBeenCalled(); expect(nextAttach).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="canvasAgent.send"]')?.disabled).toBe(false);
});

it('prefers event image bytes over the screenshot path and does not query the native clipboard', async () => {
  native.enabled = true;
  const attach = vi.fn(async (_files: File[]) => {});
  const screenshot = new File(['shot'], 'screenshot.png', { type: 'image/png' });
  act(() => attachmentComposer(attach));
  await act(async () => { paste('/tmp/screenshot.png', [screenshot]); });
  expect(attach).toHaveBeenCalledExactlyOnceWith([screenshot]);
  expect(native.read).not.toHaveBeenCalled(); expect(native.load).not.toHaveBeenCalled();
});
