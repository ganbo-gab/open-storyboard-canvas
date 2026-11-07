import { beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateAgnesSettingsCredential } from './agnesChannel';
import { setChannelCredential, useChannelStore } from '../store/channelStore';
import { renderPreview } from '../domain/template';
import { channelJobFromRequest } from './channelExecution';
import { revealChannelCredential, useMemorySecretVault } from '@/features/secrets/testSupport';

useMemorySecretVault();

beforeEach(() => { useChannelStore.setState({ channels: [], migratedLegacyIds: [] }); });
describe('Agnes settings migration boundary', () => {
  it('does not overwrite authoritative credentials on repeated startup migration', async () => {
    migrateAgnesSettingsCredential('old-settings-key');
    await setChannelCredential('settings-agnes-chat', 'updated-native-key');
    migrateAgnesSettingsCredential('old-settings-key');
    expect(await revealChannelCredential('settings-agnes-chat')).toBe('updated-native-key');
    migrateAgnesSettingsCredential('explicit-settings-edit', true);
    await vi.waitFor(async () => expect(await revealChannelCredential('settings-agnes-chat')).toBe('explicit-settings-edit'));
  });
  it('declares exact pixel/frame request fields and explicitly records unrepresentable old reference modes', () => {
    migrateAgnesSettingsCredential('agnes-key');
    const channel = useChannelStore.getState().channels.find((entry) => entry.profile.id === 'settings-agnes-video')!;
    const job = channelJobFromRequest(channel.profile, 'agnes-video-v2.0', { model: 'agnes:video:agnes-video-v2.0', prompt: 'sunrise', size: '1920x1080', aspect_ratio: '16:9', extra_params: { seconds: 18 } }, 'video');
    expect(renderPreview(channel.profile, job).body).toEqual({ mode: 'json', json: { model: 'agnes-video-v2.0', prompt: 'sunrise', width: 1920, height: 1080, num_frames: 441, frame_rate: 24 } });
    expect(channel.migrationIssues.map((issue) => issue.key)).toEqual(['supportedResolutions', 'referenceImages', 'frame_rate']);
    expect(channel.profile.models[0].refs?.image).toBe(0);
  });
});
