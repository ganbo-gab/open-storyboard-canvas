import { beforeEach, describe, expect, it, vi } from 'vitest';

const { upsertProjectRecord } = vi.hoisted(() => ({
  upsertProjectRecord: vi.fn(),
}));

vi.mock('@/commands/projectState', () => ({
  deleteProjectRecord: vi.fn(async () => {}),
  getProjectRecord: vi.fn(async () => null),
  listProjectSummaries: vi.fn(async () => []),
  renameProjectRecord: vi.fn(async () => {}),
  updateProjectViewportRecord: vi.fn(async () => {}),
  upsertProjectRecord,
}));

import { useProjectStore } from './projectStore';

describe('project persistence failure propagation', () => {
  beforeEach(() => {
    upsertProjectRecord.mockReset();
    useProjectStore.setState({
      projects: [],
      currentProjectId: null,
      currentProject: null,
      isHydrated: true,
      isOpeningProject: false,
    });
  });

  it('rejects the persistence checkpoint when the project record write fails', async () => {
    upsertProjectRecord.mockRejectedValueOnce(new Error('disk unavailable'));
    const projectId = useProjectStore.getState().createProject('Failure case');

    await expect(
      useProjectStore.getState().waitForProjectPersistence(projectId),
    ).rejects.toThrow('disk unavailable');
  });

  it('clears an earlier failure after a later successful write', async () => {
    upsertProjectRecord.mockRejectedValueOnce(new Error('temporary failure'));
    const failedProjectId = useProjectStore.getState().createProject('Failed once');
    await expect(
      useProjectStore.getState().waitForProjectPersistence(failedProjectId),
    ).rejects.toThrow('temporary failure');

    upsertProjectRecord.mockResolvedValueOnce(undefined);
    const recoveredProjectId = useProjectStore.getState().createProject('Recovered');
    await expect(
      useProjectStore.getState().waitForProjectPersistence(recoveredProjectId),
    ).resolves.toBeUndefined();
  });
});
