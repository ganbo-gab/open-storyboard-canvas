import { useMemo, useSyncExternalStore } from 'react';
import type { ChannelRecord } from '../store/channelStore';
import { channelProviderId, credentialConfigured, subscribeChannelCredentials, useChannelStore } from '../store/channelStore';
import { listModelModes, type ResolvedMode } from './modelModes';

export interface ChannelAudioModelEntry {
  id: string;
  modelId: string;
  modelLabel: string;
  providerLabel: string;
  usable: boolean;
  notReadyReason?: string;
  modes: ResolvedMode[];
  channelModelRef: { profileId: string; modelId: string };
}

/** Catalog native audio declarations directly; never infer audio support from model names. */
export function buildChannelAudioModelCatalog(channels: readonly ChannelRecord[]): ChannelAudioModelEntry[] {
  return channels.filter((channel) => channel.origin === 'native').flatMap(({ profile }) => profile.models.flatMap((model) => {
    const modes = model.modes ? listModelModes(model).filter((mode) => mode.operation === 'audio.generate')
      : model.operations.includes('audio.generate') ? listModelModes(model).map((mode): ResolvedMode => ({ ...mode, operation: 'audio.generate', mode: { ...mode.mode, operation: 'audio.generate' } })) : [];
    const supportsAudio = modes.length > 0;
    if (!supportsAudio) return [];
    const usable = profile.auth.type === 'none' || credentialConfigured(profile.id);
    return [{ id: `custom:${channelProviderId(profile.id, 'audio')}:${model.id}`, modelId: model.id,
      modelLabel: model.label ?? model.id, providerLabel: profile.name, usable,
      ...(usable ? {} : { notReadyReason: '渠道未配置 API Key' }), modes,
      channelModelRef: { profileId: profile.id, modelId: model.id } }];
  }));
}

export function useChannelAudioModelCatalog(): ChannelAudioModelEntry[] {
  const channels = useChannelStore((state) => state.channels);
  const availability = () => channels.map((entry) => credentialConfigured(entry.profile.id) ? '1' : '0').join('');
  const credentialAvailability = useSyncExternalStore(subscribeChannelCredentials, availability, availability);
  return useMemo(() => buildChannelAudioModelCatalog(channels), [channels, credentialAvailability]);
}
