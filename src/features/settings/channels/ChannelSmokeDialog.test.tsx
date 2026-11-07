// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerationJobStatus } from '@/commands/ai';
import type * as ChannelService from '@/features/channels/application/channelService';
import type * as ChannelExecution from '@/features/channels/runtime/channelExecution';
import { openAIStandardProfile } from '@/features/channels/presets/openai';
import { secretToken, useSecretStatusStore } from '@/features/secrets/secretStore';
import { ChannelSmokeDialog } from './ChannelSmokeDialog';

// Only the paid submit and the job runtime are fixtures; previews, profiles and the vault state are real.
const runtime = vi.hoisted(() => ({
  record: null as GenerationJobStatus | null,
  submit: vi.fn<(...args: unknown[]) => Promise<string>>(),
  recover: vi.fn<(...args: unknown[]) => Promise<GenerationJobStatus>>(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/features/assets/ui/AssetPickerDialog', () => ({ AssetPickerDialog: () => null }));
vi.mock('@/features/assets/ui/useAssetDisplaySource', () => ({ useAssetDisplaySource: () => ({ url: null, error: null }) }));
vi.mock('@/features/channels/application/channelService', async (importOriginal) => ({
  ...await importOriginal<typeof ChannelService>(), submitChannelSmoke: runtime.submit,
}));
vi.mock('@/features/channels/runtime/channelExecution', async (importOriginal) => ({
  ...await importOriginal<typeof ChannelExecution>(),
  getChannelJob: (id: string): GenerationJobStatus => runtime.record ?? { job_id: id, status: 'not_found' },
  subscribeChannelJob: () => () => undefined,
  recoverChannelJob: runtime.recover,
}));

const vaultKey = JSON.stringify(['channel', openAIStandardProfile.id]);
const vaultToken = secretToken({ namespace: 'channel', id: openAIStandardProfile.id });
const chatProfile = { ...openAIStandardProfile, models: [openAIStandardProfile.models[0]] };

beforeEach(() => {
  // jsdom has no layout observer; these cases cover task recovery, not geometry.
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  runtime.record = null;
  runtime.submit.mockResolvedValue('job-original');
  useSecretStatusStore.setState({ states: {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function approveOnce() {
  fireEvent.change(screen.getByLabelText('rework.channels.samplePrompt'), { target: { value: 'hello' } });
  fireEvent.click(screen.getByRole('button', { name: 'rework.channels.smoke.review' }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'rework.channels.smoke.approve' })); });
}

describe('ChannelSmokeDialog', () => {
  it('does not offer a stream toggle the smoke executor would reject, and previews a complete-response request', () => {
    render(<ChannelSmokeDialog profile={chatProfile} credential="sk-test" onClose={vi.fn()} />);
    expect(document.querySelector('pre')?.textContent).toContain('"stream": false');
    fireEvent.change(screen.getByLabelText('rework.channels.samplePrompt'), { target: { value: 'hello' } });
    expect(screen.getByRole('button', { name: 'rework.channels.smoke.review' }).hasAttribute('disabled')).toBe(false);
  });

  it('recovers a resumable unknown job once, without resubmitting', async () => {
    runtime.record = { job_id: 'job-original', status: 'unknown', resumable: true, external_task_id: 'task-9', phase: 'poll', error_category: 'timeout', error: 'timeout' };
    const recovery = Promise.withResolvers<GenerationJobStatus>();
    runtime.recover.mockReturnValue(recovery.promise);
    render(<ChannelSmokeDialog profile={chatProfile} credential="sk-test" onClose={vi.fn()} />);
    await approveOnce();

    const recover = screen.getByRole('button', { name: 'rework.channels.smoke.recover' });
    fireEvent.click(recover);
    fireEvent.click(recover);
    expect(runtime.recover).toHaveBeenCalledTimes(1);

    await act(async () => recovery.resolve({ job_id: 'job-original', status: 'succeeded', resumable: false, results: [] }));
    expect(screen.queryByRole('button', { name: 'rework.channels.smoke.recover' })).toBeNull();
    expect(runtime.submit).toHaveBeenCalledTimes(1);
  });

  it('offers no recovery for an unknown submit that has nothing resumable', async () => {
    runtime.record = { job_id: 'job-original', status: 'unknown', resumable: false, error: 'ambiguous submit' };
    render(<ChannelSmokeDialog profile={chatProfile} credential="sk-test" onClose={vi.fn()} />);
    await approveOnce();
    expect(screen.queryByRole('button', { name: 'rework.channels.smoke.recover' })).toBeNull();
  });

  it('blocks recovery while the vault credential is locked', async () => {
    useSecretStatusStore.setState({ states: { [vaultKey]: 'present' } });
    runtime.record = { job_id: 'job-original', status: 'recoverable_wait', resumable: true, external_task_id: 'task-9', error: 'HTTP 401' };
    render(<ChannelSmokeDialog profile={chatProfile} credential={vaultToken} onClose={vi.fn()} />);
    await approveOnce();
    act(() => useSecretStatusStore.setState({ states: { [vaultKey]: 'locked' } }));

    const recover = screen.getByRole('button', { name: 'rework.channels.smoke.recover' });
    expect(recover.hasAttribute('disabled')).toBe(true);
    fireEvent.click(recover);
    expect(runtime.recover).not.toHaveBeenCalled();
  });
});
