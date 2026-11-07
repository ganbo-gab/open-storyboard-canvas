// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { PromptEditor, type SlashCommand } from './PromptEditor';
import { useTextDraft } from './usePromptDraft';
import type { ComposerReference } from './useNodeReferences';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(100, 300, 0, 20) });
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const reference: ComposerReference = { kind: 'image', sourceNodeId: 'a', label: '图1', token: '@图1', title: 'First image', displayUrl: null };
function Harness({ identity = 'a', value = '', references = [], write = () => {}, paste, submit = () => {}, commands, slashRequest }: {
  identity?: string; value?: string; references?: ComposerReference[]; write?: (id: string, text: string) => void;
  paste?: (file: File) => Promise<string | null>; submit?: () => void;
  commands?: SlashCommand[]; slashRequest?: number;
}) {
  const draft = useTextDraft(identity, value, (text) => write(identity, text));
  return <PromptEditor draft={draft} references={references} pickable={references} placeholder="Write" onSubmit={submit} submitOnEnter onPasteImage={paste} slashCommands={commands} slashPickerRequest={slashRequest} />;
}
function currentEditor(): Editor {
  const textbox = screen.getByRole('textbox', { name: 'rework.prompt' });
  if ('editor' in textbox && textbox.editor instanceof Editor) return textbox.editor;
  throw new Error('Real TipTap editor was not mounted');
}
async function ready(): Promise<Editor> { await screen.findByRole('textbox', { name: 'rework.prompt' }); return currentEditor(); }

it('updates reference titles and converts a deleted reference back to plain text without losing the caret', async () => {
  const view = render(<Harness value="Hello @图1 end" references={[reference]} />);
  const editor = await ready();
  expect(editor.view.dom.querySelector('[data-prompt-reference]')?.getAttribute('title')).toBe('First image');
  act(() => editor.commands.setTextSelection(8));
  view.rerender(<Harness value="Hello @图1 end" references={[{ ...reference, title: 'Renamed image' }]} />);
  await waitFor(() => expect(editor.view.dom.querySelector('[data-prompt-reference]')?.getAttribute('title')).toBe('Renamed image'));
  view.rerender(<Harness value="Hello @图1 end" references={[]} />);
  await waitFor(() => expect(editor.view.dom.querySelector('[data-prompt-reference]')).toBeNull());
  expect(editor.getText({ blockSeparator: '\n' })).toBe('Hello @图1 end');
  expect(editor.state.selection.from).toBeGreaterThan(6);
});

it('does not tokenize the prefix of a nonexistent @图10 and supports video/audio text markers', async () => {
  render(<Harness value="@图10 @视频1 @音频1 @文本1" references={[reference,
    { ...reference, kind: 'video', sourceNodeId: 'v', token: '@视频1' }, { ...reference, kind: 'audio', sourceNodeId: 's', token: '@音频1' }, { ...reference, kind: 'text', sourceNodeId: 't', token: '@文本1' }]} />);
  const editor = await ready();
  expect([...editor.view.dom.querySelectorAll('[data-prompt-reference]')].map((node) => node.textContent)).toEqual(['@视频1', '@音频1', '@文本1']);
  expect(editor.getText({ blockSeparator: '\n' })).toBe('@图10 @视频1 @音频1 @文本1');
});

it('rejects a late paste result after switching to a different draft and preserves both writers', async () => {
  const upload = Promise.withResolvers<string | null>(); const paste = vi.fn(() => upload.promise); const write = vi.fn();
  const view = render(<Harness identity="old" value="old text" paste={paste} write={write} />);
  const old = await ready();
  act(() => old.commands.insertContentAt(9, '!'));
  fireEvent.paste(old.view.dom, { clipboardData: { files: [new File(['png'], 'image.png', { type: 'image/png' })], getData: () => '' } });
  expect(paste).toHaveBeenCalledOnce();
  view.rerender(<Harness identity="new" value="new text" paste={paste} write={write} />);
  await waitFor(() => expect(currentEditor().getText()).toBe('new text'));
  await act(async () => upload.resolve('@图1'));
  expect(currentEditor().getText()).toBe('new text');
  expect(write.mock.calls).toContainEqual(['old', 'old text!']);
  expect(write.mock.calls.filter(([id]) => id === 'new')).toEqual([]);
});

it('keeps content and edits when moving the same editor into and out of the expanded dialog', async () => {
  render(<Harness value={'first\nsecond'} references={[reference]} />);
  const editor = await ready();
  fireEvent.click(screen.getByRole('button', { name: 'ui.workbench.expandPrompt' }));
  await waitFor(() => expect(screen.getByRole('dialog').contains(editor.view.dom)).toBe(true));
  act(() => editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' amended'));
  fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }));
  await waitFor(() => expect(currentEditor().getText({ blockSeparator: '\n' })).toBe('first\nsecond amended'));
  expect(currentEditor()).toBe(editor);
});

it('does not submit Enter during IME and submits the plain-text draft once afterwards', async () => {
  const submit = vi.fn(); const write = vi.fn(); render(<Harness value="你好" submit={submit} write={write} />);
  const editor = await ready();
  fireEvent.keyDown(editor.view.dom, { key: 'Enter', isComposing: true }); expect(submit).not.toHaveBeenCalled();
  fireEvent.keyDown(editor.view.dom, { key: 'Enter' }); expect(submit).toHaveBeenCalledOnce();
});

it('keeps delayed paste at its mapped insertion point while the user continues editing', async () => {
  const upload = Promise.withResolvers<string | null>(); const paste = vi.fn(() => upload.promise);
  render(<Harness value="AB" paste={paste} references={[reference]} />);
  const editor = await ready();
  act(() => editor.commands.setTextSelection(2));
  fireEvent.paste(editor.view.dom, { clipboardData: { files: [new File(['png'], 'image.png', { type: 'image/png' })], getData: () => '' } });
  act(() => { editor.commands.insertContentAt(1, 'X'); editor.commands.setTextSelection(editor.state.doc.content.size - 1); });
  await act(async () => upload.resolve('@图1'));
  expect(editor.getText({ blockSeparator: '\n' })).toBe('XA@图1 B');
});

it('drops delayed paste when a saved preset replaces the same draft externally', async () => {
  const upload = Promise.withResolvers<string | null>(); const paste = vi.fn(() => upload.promise);
  const view = render(<Harness value="old prompt" paste={paste} />); const editor = await ready();
  fireEvent.paste(editor.view.dom, { clipboardData: { files: [new File(['png'], 'image.png', { type: 'image/png' })], getData: () => '' } });
  view.rerender(<Harness value="replacement prompt" paste={paste} />);
  await waitFor(() => expect(editor.getText()).toBe('replacement prompt'));
  await act(async () => upload.resolve('@图1'));
  expect(editor.getText()).toBe('replacement prompt');
});

it('does not allow local undo to restore text from a previous draft identity', async () => {
  const view = render(<Harness identity="old" value="old" />); const old = await ready();
  act(() => old.commands.insertContentAt(4, ' edited'));
  view.rerender(<Harness identity="new" value="new" />);
  await waitFor(() => expect(currentEditor().getText()).toBe('new'));
  act(() => currentEditor().commands.undo());
  expect(currentEditor().getText()).toBe('new');
});

it('replaces typed @ query at the caret and selects by keyboard without submitting', async () => {
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(200, 300, 0, 20) });
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) });
  const submit = vi.fn();
  render(<Harness value="去除" references={[reference]} submit={submit} />);
  const editor=await ready();
  act(()=>editor.commands.insertContentAt(editor.state.doc.content.size-1,'@@图'));
  await screen.findByRole('option');
  fireEvent.keyDown(editor.view.dom,{key:'Enter'});
  expect(submit).not.toHaveBeenCalled();
  expect(editor.getText()).toBe('去除@图1 ');
  expect(editor.view.dom.querySelectorAll('[data-prompt-reference]')).toHaveLength(1);
});

it('normalizes old duplicate triggers only for actual references and keeps unknown markers', async () => {
  render(<Harness value="去除@@图1 保留@@图2" references={[reference]} />);
  const editor=await ready();
  expect(editor.getText()).toBe('去除@图1 保留@@图2');
});

it.each(['/', '／', '描述/'])('opens slash commands from actual inserted text %s and applies without submitting', async (prefix) => {
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(100, 300, 0, 20) });
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) });
  const submit = vi.fn(), run = vi.fn(), write = vi.fn();
  render(<Harness commands={[{ id: 'preset', label: '电影', run }]} submit={submit} write={write} />);
  const editor = await ready();
  act(() => editor.commands.insertContent(`${prefix}电影`));
  await screen.findByRole('menuitem', { name: '电影' });
  fireEvent.keyDown(editor.view.dom, { key: 'Enter' });
  expect(run).toHaveBeenCalledOnce(); expect(submit).not.toHaveBeenCalled();
  expect(editor.getText()).toBe(prefix === '描述/' ? '描述' : '');
});

it('ignores URLs and removes only the slash query at the caret while preserving surrounding text', async () => {
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(100, 300, 0, 20) });
  const run = vi.fn(); render(<Harness value="https://example.com/path tail" commands={[{ id: 'p', label: 'Preset', run }]} />);
  const editor = await ready();
  act(() => editor.commands.setTextSelection(25));
  expect(screen.queryByRole('menu')).toBeNull();
  act(() => editor.commands.insertContentAt(1, '/Pre '));
  expect(screen.queryByRole('menu')).toBeNull();
  act(() => { editor.commands.setContent('<p>before /Pre after</p>'); editor.commands.setTextSelection(12); });
  await screen.findByRole('menuitem', { name: 'Preset' });
  fireEvent.keyDown(editor.view.dom, { key: 'Enter' });
  expect(editor.getText()).toBe('before  after'); expect(run).toHaveBeenCalledOnce();
});

it('lets the visible command button open and search without adding a slash to the prompt', async () => {
  const run = vi.fn(); const view = render(<Harness value="Keep me" slashRequest={0} commands={[{ id: 'p', label: 'Preset', run }]} />);
  await ready();
  view.rerender(<Harness value="Keep me" slashRequest={1} commands={[{ id: 'p', label: 'Preset', run }]} />);
  fireEvent.change(await screen.findByRole('textbox', { name: 'rework.search' }), { target: { value: 'Pre' } });
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'rework.search' }), { key: 'Enter' });
  expect(run).toHaveBeenCalledOnce(); expect(currentEditor().getText()).toBe('Keep me');
});
