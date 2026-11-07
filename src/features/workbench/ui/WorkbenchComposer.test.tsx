// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkbenchComposer } from './WorkbenchComposer';
import { useWorkbenchStore } from '../store/workbenchStore';
import { readReferenceFile } from '../application/readReferenceFile';
import type { WorkbenchReference } from '../domain/types';
import { useCreationModels } from './useCreationModels';
import { saveChannelRecord, useChannelStore } from '@/features/channels/store/channelStore';
import { resolveChannelCatalogModelId } from '@/features/channels/application/channelCatalog';
import { getWorkbenchValidationContext, validateWorkbenchDraft } from '../application/workbenchValidation';
import { workbenchDocument } from '../application/workbenchPersistence';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: { slot?: string }) => values?.slot ? `${key}:${values.slot}` : key, i18n: { exists: () => false } }) }));
vi.mock('./useCreationModels', () => ({ useCreationModels: vi.fn() }));
vi.mock('../application/readReferenceFile', () => ({ isReferenceFile: () => true, readReferenceFile: vi.fn() }));
const originalSubmit = useWorkbenchStore.getState().submit;
beforeEach(async () => {
  await workbenchDocument.initialize?.();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.mocked(useCreationModels).mockReturnValue([{ id: 'qa-image', label: 'QA image', provider: 'Local', usable: true, ratios: [], resolutions: [], durations: [] }]);
  useWorkbenchStore.setState({ initialized: true, selectedConversationId: 'one', draft: { kind: 'image', prompt: 'A scene', model: 'qa-image', references: [], config: {} } });
});
afterEach(() => { cleanup(); useWorkbenchStore.setState({ submit: originalSubmit }); useChannelStore.setState({ channels: [] }); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function installFrameModel() {
  saveChannelRecord({ version: 2, id: 'frames', name: 'Frame channel', baseUrl: 'https://fixture.test', auth: { type: 'none' },
    operations: { 'image.generate': { method: 'POST', path: '/images', body: 'json', template: { prompt: '{{prompt}}' }, response: { mode: 'sync', outputs: [] } } },
    models: [{ id: 'image', operations: ['image.generate'], params: [], modes: [
      { id: 'pair', label: 'Frame pair', operation: 'image.generate', slots: [{ key: 'first', label: 'First', kind: 'image', max: 1 }, { key: 'last', label: 'Last', kind: 'image', max: 1 }] },
      { id: 'text', label: 'Text only', operation: 'image.generate', slots: [] },
    ] }],
  });
  vi.mocked(useCreationModels).mockReturnValue([{ id: resolveChannelCatalogModelId('custom:frames:image'), label: 'Frame image', provider: 'Frame channel', usable: true, ratios: [], resolutions: [], durations: [] }]);
}

it('sends the collapsed composer once even when its send button receives focus', async () => {
  const pending = Promise.withResolvers<string>(); const submit = vi.fn(() => pending.promise);
  useWorkbenchStore.setState({ submit });
  render(<WorkbenchComposer onSettings={() => undefined} />);
  await screen.findByRole('textbox', { name: 'rework.prompt' });
  fireEvent.click(screen.getByRole('button', { name: 'ui.workbench.collapseComposer' }));
  const send = screen.getByRole('button', { name: 'rework.generate' });
  fireEvent.focus(send);
  fireEvent.click(send); fireEvent.click(send);
  expect(submit).toHaveBeenCalledOnce();
  expect(submit.mock.calls[0]).toMatchObject([{ prompt: 'A scene', model: 'qa-image' }]);
  await act(async () => pending.resolve('task'));
});

it('does not attach a file that finished reading after switching conversations', async () => {
  const reading = Promise.withResolvers<WorkbenchReference>();
  vi.mocked(readReferenceFile).mockReturnValue(reading.promise);
  const view = render(<WorkbenchComposer onSettings={() => undefined} />);
  await screen.findByRole('textbox', { name: 'rework.prompt' });
  const input = view.container.querySelector<HTMLInputElement>('input[type="file"][multiple]');
  if (!input) throw new Error('Missing reference upload');
  fireEvent.change(input, { target: { files: [new File(['image'], 'a.png', { type: 'image/png' })] } });
  act(() => useWorkbenchStore.setState({ selectedConversationId: 'two' }));
  await act(async () => reading.resolve({ id: 'upload', source: '/a.png', kind: 'image' }));
  await waitFor(() => expect(useWorkbenchStore.getState().draft.references).toEqual([]));
});

it('lets users assign ambiguous references, shows full slots, and remove unsupported media without losing mentions', async () => {
  installFrameModel();
  useWorkbenchStore.setState({ draft: { kind: 'image', model: 'custom:frames:image', channelModeId: 'pair', prompt: 'A @图1 B @图2 clip @视1', references: [
    { id: 'a', name: 'A', kind: 'image', source: '/same.png' }, { id: 'b', name: 'B', kind: 'image', source: '/same.png' },
    { id: 'clip', name: 'Clip', kind: 'video', source: '/clip.mp4' },
  ] } });
  render(<WorkbenchComposer onSettings={() => undefined} />);
  await screen.findByRole('textbox', { name: 'rework.prompt' });
  fireEvent.click(screen.getByRole('button', { name: 'ui.workbench.manageReferences' }));
  fireEvent.click(within(screen.getByRole('group', { name: 'B' })).getByRole('button', { name: 'ui.workbench.assignReference:First' }));
  expect(useWorkbenchStore.getState().draft.prompt).toBe('A @图2 B @图1 clip @视频1');
  expect(within(screen.getByRole('group', { name: 'A' })).getByRole<HTMLButtonElement>('button', { name: /ui.workbench.assignReference:First/ }).disabled).toBe(true);
  fireEvent.click(within(screen.getByRole('group', { name: 'A' })).getByRole('button', { name: 'ui.workbench.assignReference:Last' }));
  expect(screen.getByText('ui.workbench.noCompatibleReferenceSlot')).toBeTruthy();
  fireEvent.click(within(screen.getByRole('group', { name: 'Clip' })).getByRole('button', { name: 'rework.removeReference' }));
  const draft = useWorkbenchStore.getState().draft;
  expect(draft.referenceSlots).toEqual({ first: ['/same.png'], last: ['/same.png'] });
  expect(draft.references).toEqual([]);
  expect(draft.prompt).toBe('A @图2 B @图1 clip ');
  expect(validateWorkbenchDraft(draft, getWorkbenchValidationContext(draft)).issues).not.toContainEqual(expect.objectContaining({ code: 'references.slotRequired' }));
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'rework.generate' }).disabled).toBe(false);
});

it('renumbers unassigned references when removing a slot reference, and keeps their tokens on a mode change', async () => {
  installFrameModel();
  useWorkbenchStore.setState({ draft: { kind: 'image', model: 'custom:frames:image', channelModeId: 'pair', prompt: 'slot @图1 A @图2 B @图3', referenceSlots: { first: ['/first.png'] }, references: [
    { id: 'a', name: 'A', kind: 'image', source: '/a.png' }, { id: 'b', name: 'B', kind: 'image', source: '/b.png' },
  ] } });
  render(<WorkbenchComposer onSettings={() => undefined} />);
  await screen.findByRole('textbox', { name: 'rework.prompt' });
  fireEvent.click(screen.getByRole('button', { name: 'channelModes.removeFromSlot:First' }));
  expect(useWorkbenchStore.getState().draft.prompt).toBe('slot  A @图1 B @图2');
  fireEvent.click(screen.getByRole('button', { name: 'Frame pair' }));
  fireEvent.click(screen.getByRole('button', { name: 'Text only' }));
  expect(useWorkbenchStore.getState().draft.prompt).toBe('slot  A @图1 B @图2');
  fireEvent.click(screen.getByRole('button', { name: 'ui.workbench.manageReferences' }));
  fireEvent.click(within(screen.getByRole('group', { name: 'A' })).getByRole('button', { name: 'rework.removeReference' }));
  expect(useWorkbenchStore.getState().draft.prompt).toBe('slot  A  B @图1');
});

it('displays a legacy channel model ID and allows its existing draft to submit', async () => {
  installFrameModel();
  const submit = vi.fn(async () => 'submitted');
  useWorkbenchStore.setState({ submit, draft: { kind: 'image', model: 'custom:frames:image', channelModeId: 'pair', prompt: 'Legacy draft', references: [] } });
  render(<WorkbenchComposer onSettings={() => undefined} />);
  expect(await screen.findByRole('button', { name: 'Frame image' })).toBeTruthy();
  const send = screen.getByRole<HTMLButtonElement>('button', { name: 'rework.generate' });
  expect(send.disabled).toBe(false);
  fireEvent.click(send);
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(submit.mock.calls[0]).toMatchObject([{ model: 'custom:frames:image', prompt: 'Legacy draft' }]);
});
