import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), http: vi.fn() }));
vi.mock('@/commands/ai', async (original) => ({ ...await original<typeof import('@/commands/ai')>(),
  getGenerationJobRecord: mocks.get, updateGenerationJob: mocks.update, customHttpRequest: mocks.http }));
import { getCustomProviderJobAsync, recoverCustomProviderJob, resolveProviderAndModel } from './providerGateway';
import { useChannelStore } from '@/features/channels/store/channelStore';
import { useCustomProvidersStore } from '@/stores/customProvidersStore';
import { resolveChannelCatalogModelId } from '@/features/channels/application/channelCatalog';
import { useMemorySecretVault } from '@/features/secrets/testSupport';

useMemorySecretVault();

beforeEach(async () => {
  vi.clearAllMocks(); mocks.update.mockResolvedValue(undefined);
  useChannelStore.setState({ channels: [], migratedLegacyIds: [] });
  await useCustomProvidersStore.getState().replaceAll([]);
});
describe('channel-only dispatch and upgrade recovery', () => {
  it('resolves existing canvas model IDs through the automatically migrated profile, without a legacy HTTP config', async () => {
    await useCustomProvidersStore.getState().addProvider({ id: 'old-relay', label: 'Old relay', baseUrl: 'https://relay.example',
      endpointPath: '/v1/images/generations', apiKey: 'old-key', apiStyle: 'openai-compatible', models: ['image-v1'], supportsWebSearch: false });
    expect(useCustomProvidersStore.getState().providers.some((provider) => provider.id === 'old-relay')).toBe(false);
    expect(resolveProviderAndModel('custom:old-relay:image-v1')).toMatchObject({ model: 'image-v1', cfg: { apiStyle: 'channel-template-v2', extraParams: { channelProfileId: 'old-relay' } } });
    expect(useChannelStore.getState().channels.find((entry) => entry.profile.id === 'old-relay')?.origin).toBe('native');
    expect(resolveChannelCatalogModelId('custom:old-relay:image-v1')).toBe('custom:channel-old-relay-image:image-v1');
  });
  it('preserves a pre-v2 job but returns a structured terminal unavailable state without guessing poll semantics', async () => {
    mocks.get.mockResolvedValue({ job_id: 'custom-local-old', status: 'running', external_task_id: 'original-paid-123',
      provider_id: 'old-relay', model_id: 'image-v1', media_type: 'image', resumable: true });
    expect(await recoverCustomProviderJob('custom-local-old')).toMatchObject({ job_id: 'custom-local-old', external_task_id: 'original-paid-123',
      status: 'failed', error_category: 'upgrade-recovery-unavailable', phase: 'upgrade-recovery', resumable: false, error: expect.stringContaining('original-paid-123') });
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', errorCategory: 'upgrade-recovery-unavailable', resumable: false }));
    expect(mocks.http).not.toHaveBeenCalled();
  });
  it('makes upgrade unavailability visible through ordinary polling and preserves completed records', async () => {
    mocks.get.mockResolvedValue({ job_id: 'custom-local-unconfirmed', status: 'submitting', provider_id: 'missing', external_task_id: null });
    expect(await getCustomProviderJobAsync('custom-local-unconfirmed')).toMatchObject({ status: 'failed', error_category: 'upgrade-recovery-unavailable', error: expect.stringContaining('custom-local-unconfirmed') });
    mocks.get.mockResolvedValue({ job_id: 'custom-local-complete', status: 'succeeded', result: '/local/old.png' });
    expect(await getCustomProviderJobAsync('custom-local-complete')).toMatchObject({ status: 'succeeded', result: '/local/old.png' });
    expect(mocks.http).not.toHaveBeenCalled();
  });
});
