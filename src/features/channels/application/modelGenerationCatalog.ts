import { useMemo, useSyncExternalStore } from 'react';
import type { ChannelProfileV2 } from '../domain/profile';
import type { ChannelRecord } from '../store/channelStore';
import { credentialConfigured, subscribeChannelCredentials, useChannelStore } from '../store/channelStore';
import { listModelModes, type ResolvedMode } from './modelModes';

export interface ChannelModelGenerationEntry {
  id: string;
  modelId: string;
  modelLabel: string;
  providerLabel: string;
  usable: boolean;
  notReadyReason?: string;
  modes: ResolvedMode[];
  channelModelRef: { profileId: string; modelId: string };
}
export function modelGenerationModes(profile: ChannelProfileV2, modelId: string): ResolvedMode[] {
  const model = profile.models.find((entry) => entry.id === modelId);
  if (!model) return [];
  const modes = listModelModes(model);
  // The implicit legacy mode still uses its declared model.generate operation even when it is not first.
  if (!model.modes && model.operations.includes('model.generate')) modes[0] = { ...modes[0], operation: 'model.generate', mode: { ...modes[0].mode, operation: 'model.generate' } };
  return modes.filter((mode) => {
    if (mode.operation !== 'model.generate') return false;
    const op = mode.operationSpec ?? profile.operations['model.generate'];
    if (!op) return false;
    const outputs = op.response.mode === 'sync' ? op.response.outputs : op.response.poll.outputs;
    return outputs.some((output) => (output.kind ?? 'model') === 'model');
  });
}
export function buildChannelModelGenerationCatalog(channels: readonly ChannelRecord[]): ChannelModelGenerationEntry[] {
  return channels.filter((entry) => entry.origin === 'native').flatMap(({ profile }) => profile.models.flatMap((model) => {
    const modes = modelGenerationModes(profile, model.id);
    if (!modes.length) return [];
    const notReadyReason = profile.auth.type !== 'none' && !credentialConfigured(profile.id) ? '渠道未配置 API Key'
      : !modes.some((mode) => mode.slots.some((slot) => slot.kind === 'image' && slot.max > 0)) ? '模型未声明参考图槽位' : undefined;
    return [{ id: `channel-model:${encodeURIComponent(profile.id)}:${encodeURIComponent(model.id)}`, modelId: model.id,
      modelLabel: model.label ?? model.id, providerLabel: profile.name, modes, usable: !notReadyReason,
      ...(notReadyReason ? { notReadyReason } : {}), channelModelRef: { profileId: profile.id, modelId: model.id } }];
  }));
}
export function useChannelModelGenerationCatalog(): ChannelModelGenerationEntry[] {
  const channels = useChannelStore((state) => state.channels);
  const availability = () => channels.map((entry) => credentialConfigured(entry.profile.id) ? '1' : '0').join('');
  const credentialAvailability = useSyncExternalStore(subscribeChannelCredentials, availability, availability);
  return useMemo(() => buildChannelModelGenerationCatalog(channels), [channels, credentialAvailability]);
}
