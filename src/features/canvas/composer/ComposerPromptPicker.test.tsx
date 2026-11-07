// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { usePromptDraft } from './usePromptDraft';
import { applyComposerPrompt, type ComposerPromptOption } from './useSourceCommands';
import { ComposerPromptPicker } from './ComposerPromptPicker';
import { useCanvasStore } from '@/stores/canvasStore';
import type { ComposerReference } from './useNodeReferences';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const option: ComposerPromptOption = { id: 'preset:portrait', label: 'Portrait', prompt: 'Soft light portrait', group: 'preset' };
const refs: ComposerReference[] = ['a', 'b'].map((sourceNodeId, index) => ({ sourceNodeId, kind: 'image', imageUrl: `/${sourceNodeId}.png`, displayUrl: null, title: sourceNodeId, label: `Image ${index + 1}`, token: `@Image${index + 1}` }));
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('requires an explicit target with multiple reference images and applies only after choosing', () => {
  const apply = vi.fn(), close = vi.fn(), edit = vi.fn();
  render(<ComposerPromptPicker options={[{ ...option, group: 'image' }]} initialGroup="image" images={refs} onApply={apply} onClose={close} onEditImage={edit} />);
  const choice = screen.getByRole('button', { name: /Portrait/ });
  expect(choice.hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Image 2' }));
  expect(choice.hasAttribute('disabled')).toBe(false);
  fireEvent.click(choice);
  expect(apply).toHaveBeenCalledWith({ ...option, group: 'image' }, false, refs[1]);
  expect(close).toHaveBeenCalledOnce(); expect(edit).not.toHaveBeenCalled();
});
it('lets users choose replace and search presets without requiring a model or reference', () => {
  const apply = vi.fn();
  render(<ComposerPromptPicker options={[option]} initialGroup="preset" images={[]} onApply={apply} onClose={() => {}} onEditImage={() => {}} />);
  fireEvent.click(screen.getByRole('radio', { name: 'ui.canvas.replacePrompt' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Soft light' } });
  fireEvent.click(screen.getByRole('button', { name: /Portrait/ }));
  expect(apply).toHaveBeenCalledWith(option, true, undefined);
});
it('keeps uncommitted text, materializes a preset once, clears legacy sources and creates one undo step', () => {
  useCanvasStore.getState().setCanvasData([{ id: 'generator', type: 'imageNode', position: { x: 0, y: 0 }, data: { imageUrl: null, prompt: 'Saved', aspectRatio: '1:1', resolution: '2K', selectedPromptPresetId: 'old', selectedFunctionChip: 'predictNext' } }], []);
  function Harness() {
    const node = useCanvasStore(state => state.nodes[0]);
    const draft = usePromptDraft('generator', 'prompt', typeof node.data.prompt === 'string' ? node.data.prompt : '');
    return <><input aria-label="Draft" value={draft.value} onChange={event => draft.set(event.target.value)} /><button onClick={() => applyComposerPrompt(draft, option.prompt)}>Apply</button></>;
  }
  render(<Harness />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Still typing' } });
  const count = useCanvasStore.getState().history.past.length;
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  expect(useCanvasStore.getState().nodes[0].data).toMatchObject({ prompt: 'Still typing\n\nSoft light portrait', selectedPromptPresetId: null, selectedFunctionChip: null });
  expect(useCanvasStore.getState().history.past.length).toBe(count + 1);
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  expect(useCanvasStore.getState().nodes[0].data.prompt).toBe('Still typing\n\nSoft light portrait');
  act(() => useCanvasStore.getState().undo());
  expect(useCanvasStore.getState().nodes[0].data).toMatchObject({ prompt: 'Saved', selectedPromptPresetId: 'old' });
});
