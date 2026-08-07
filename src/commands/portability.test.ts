import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(),
  listen: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauriMocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauriMocks.listen }));
vi.mock('uuid', () => ({ v4: () => 'job-1' }));

import { inspectTauriProjectBundle } from './portability';

describe('native portability cancellation', () => {
  beforeEach(() => {
    tauriMocks.invoke.mockReset();
    tauriMocks.listen.mockReset();
    tauriMocks.unlisten.mockReset();
    tauriMocks.listen.mockResolvedValue(tauriMocks.unlisten);
  });

  it('rejects a pre-aborted operation before listening or invoking Tauri', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(inspectTauriProjectBundle('/tmp/project.oscpack', {
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(tauriMocks.listen).not.toHaveBeenCalled();
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });

  it('sends cancellation for an operation that is already running', async () => {
    let resolveInspect: ((value: unknown) => void) | undefined;
    tauriMocks.invoke.mockImplementation((command) => {
      if (command === 'cancel_portability_operation') return Promise.resolve(undefined);
      return new Promise((resolve) => { resolveInspect = resolve; });
    });
    const controller = new AbortController();
    const operation = inspectTauriProjectBundle('/tmp/project.oscpack', {
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(tauriMocks.invoke).toHaveBeenCalledWith('inspect_project_bundle', {
        path: '/tmp/project.oscpack',
        jobId: 'job-1',
      });
    });

    controller.abort();
    await vi.waitFor(() => {
      expect(tauriMocks.invoke).toHaveBeenCalledWith('cancel_portability_operation', {
        jobId: 'job-1',
      });
    });
    resolveInspect?.({});
    await operation;
    expect(tauriMocks.unlisten).toHaveBeenCalledOnce();
  });
});
