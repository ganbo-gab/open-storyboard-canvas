// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ComfyRecoveryControl } from './ComfyRecoveryControl';
import { getComfyChannelRecoveryConnection } from '@/features/channels/runtime/comfyExecution';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/customProvidersStore', () => ({ useCustomProvidersStore: (selector: (value: { providers: [] }) => unknown) => selector({ providers: [] }) }));
vi.mock('@/features/channels/runtime/comfyExecution', () => ({ getComfyChannelRecoveryConnection: vi.fn(), switchComfyChannelJobRoute: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('shows a local record error and can retry metadata without remounting the task', async () => {
  vi.mocked(getComfyChannelRecoveryConnection).mockRejectedValueOnce(new Error('Local record temporarily unavailable')).mockResolvedValueOnce({ originalBaseUrl: 'https://old.example', selectedBaseUrl: 'https://old.example', providerId: 'saved', externalTaskId: 'original-task' });
  render(<ComfyRecoveryControl jobId="job" onRecovered={vi.fn()} />);
  expect((await screen.findByRole('alert')).textContent).toContain('Local record temporarily unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'rework.retryQuery' }));
  expect(await screen.findByText(/original-task/)).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(getComfyChannelRecoveryConnection).toHaveBeenCalledTimes(2);
});
