// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BlueprintNodeData } from '@/features/canvas/domain/canvasNodes';
import { persistImageSource } from '@/commands/image';
import { showErrorDialog } from '@/features/canvas/application/errorDialog';
import { useStageSnapshotActions } from './useStageSnapshotActions';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/commands/image', () => ({ persistImageSource: vi.fn(async () => '/persisted/new.png') }));
vi.mock('@/features/canvas/application/imageData', () => ({ resolveImageDisplayUrl: (url: string) => url }));
vi.mock('@/features/canvas/application/errorDialog', () => ({ showErrorDialog: vi.fn(async () => {}) }));
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); vi.mocked(persistImageSource).mockResolvedValue('/persisted/new.png'); });

function fixture(initial: Partial<BlueprintNodeData> = {}, add = vi.fn<(url: string) => Promise<boolean | void>>(async () => {})) {
  const update = vi.fn<(patch: Partial<BlueprintNodeData>) => void>();
  const close = vi.fn();
  const exportPng = vi.fn(() => 'data:image/png;base64,fixture');
  const hook = renderHook(() => {
    const [data, setData] = useState<BlueprintNodeData>({ mode: 'flat', aspectRatio: '16:9', items: [], referenceImages: [], ...initial });
    const actions = useStageSnapshotActions({ nodeId: 'stage', data, editorRef: { current: { exportPng } }, exportOptions: () => ({ targetWidth: 1920, targetHeight: 1080 }),
      commitPendingTextDrafts: () => false, onUpdateNodeData: (patch) => { update(patch); setData((previous) => ({ ...previous, ...patch })); },
      onAddSnapshotToCanvas: add, onClose: close });
    return { actions, data };
  });
  return { hook, add, close, exportPng, update };
}
it('captures persistent media and maintains the existing ordered ten-shot history', async () => {
  const history = Array.from({ length: 10 }, (_, index) => `/old-${index}.png`);
  const { hook, exportPng } = fixture({ snapshotUrl: history[9], snapshotHistory: history });
  await act(async () => { await hook.result.current.actions.captureScreenshot(); });
  expect(exportPng).toHaveBeenCalledWith({ targetWidth: 1920, targetHeight: 1080 });
  expect(hook.result.current.data.snapshotHistory).toEqual([...history.slice(1), '/persisted/new.png']);
  expect(hook.result.current.data.snapshotUrl).toBe('/persisted/new.png');
  expect(hook.result.current.actions.captureToast).toBe('/persisted/new.png');
});
it('serializes duplicate publish invocations and closes only after every saved shot is accepted', async () => {
  const gate = Promise.withResolvers<void>();
  const add = vi.fn<(url: string) => Promise<boolean | void>>().mockImplementationOnce(() => gate.promise).mockResolvedValue(undefined);
  const { hook, close } = fixture({ snapshotUrl: '/second.png', snapshotHistory: ['/first.png', '/second.png'] }, add);
  let publishing: Promise<void> | undefined;
  await act(async () => { publishing = hook.result.current.actions.addAllSnapshotsToCanvas(); await hook.result.current.actions.addAllSnapshotsToCanvas(); });
  expect(add.mock.calls).toEqual([['/first.png']]); expect(close).not.toHaveBeenCalled();
  await act(async () => { gate.resolve(); await publishing; });
  expect(add.mock.calls).toEqual([['/first.png'], ['/second.png']]); expect(close).toHaveBeenCalledOnce();
  expect(hook.result.current.actions.isAddingSnapshotToCanvas).toBe(false);
});
it('does not close the stage when canvas publication declines a screenshot', async () => {
  const add = vi.fn<(url: string) => Promise<boolean | void>>(async () => false);
  const { hook, close } = fixture({ snapshotUrl: '/saved.png' }, add);
  await act(async () => { await hook.result.current.actions.addSnapshotToCanvas(); });
  expect(add).toHaveBeenCalledWith('/saved.png'); expect(close).not.toHaveBeenCalled();
  expect(hook.result.current.actions.isAddingSnapshotToCanvas).toBe(false);
});
it('deleting the current shot selects the remaining latest shot without deleting asset bytes', async () => {
  const { hook } = fixture({ snapshotUrl: '/second.png', snapshotHistory: ['/first.png', '/second.png'] });
  await act(async () => { await hook.result.current.actions.deleteSnapshot('/second.png'); });
  expect(hook.result.current.data).toMatchObject({ snapshotUrl: '/first.png', snapshotHistory: ['/first.png'] });
  expect(persistImageSource).not.toHaveBeenCalled();
});
it('does not publish or update the stage after its capture owner unmounts', async () => {
  const gate = Promise.withResolvers<string>(); vi.mocked(persistImageSource).mockReturnValueOnce(gate.promise);
  const { hook, add, update } = fixture();
  let publishing: Promise<void> | undefined;
  act(() => { publishing = hook.result.current.actions.addSnapshotToCanvas(); });
  hook.unmount();
  await act(async () => { gate.resolve('/late.png'); await publishing; });
  expect(update).not.toHaveBeenCalled(); expect(add).not.toHaveBeenCalled(); expect(showErrorDialog).not.toHaveBeenCalled();
});
it('clearing history prevents a pending capture from repopulating it', async () => {
  const gate = Promise.withResolvers<string>(); vi.mocked(persistImageSource).mockReturnValueOnce(gate.promise);
  const { hook } = fixture({ snapshotUrl: '/old.png' });
  let capture: Promise<void> | undefined;
  act(() => { capture = hook.result.current.actions.captureScreenshot(); });
  act(() => hook.result.current.actions.clearAllSnapshots());
  await act(async () => { gate.resolve('/late.png'); await capture; });
  expect(hook.result.current.data).toMatchObject({ snapshotUrl: null, snapshotHistory: [] });
});
