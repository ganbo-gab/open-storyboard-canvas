import { prepareNodeImageSourceWithHeaders } from '@/commands/image';
import { getChannelCredential, useChannelStore } from '@/features/channels/store/channelStore';
import { useSettingsStore } from '@/stores/settingsStore';

/** Materialize a persisted upstream image; credentials never cross the channel origin. */
export async function materializeCustomProviderImageResult(providerId: string, imageSource: string): Promise<string> {
  if (!/^https?:\/\//i.test(imageSource)) return imageSource;
  const profile = useChannelStore.getState().channels.find(({ profile }) => profile.id === providerId
    || ['image', 'video', 'chat'].some((media) => `channel-${encodeURIComponent(profile.id)}-${media}` === providerId))?.profile;
  if (!profile) return imageSource;
  const headers: Record<string, string> = {};
  const url = new URL(imageSource);
  const origin = new URL(profile.baseUrl).origin;
  if (url.origin === origin) {
    Object.assign(headers, profile.headers);
    const key = getChannelCredential(profile.id);
    if (key && profile.auth.type === 'bearer') headers.Authorization = `Bearer ${key}`;
    else if (key && profile.auth.type === 'header') headers[profile.auth.name] = `${profile.auth.prefix ?? ''}${key}`;
    else if (key && profile.auth.type === 'query') url.searchParams.set(profile.auth.name, key);
  }
  const network = useSettingsStore.getState().generationNetworkSettings;
  return (await prepareNodeImageSourceWithHeaders(url.href, headers, 512,
    { route: network.route, customProxyUrl: network.customProxyUrl, configuredProviderOrigin: origin })).imagePath;
}
