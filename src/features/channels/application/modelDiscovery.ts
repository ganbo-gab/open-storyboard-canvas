import type { ChannelCapability } from './channelCapabilities';

/** A suggestion for review, never an executable protocol or a verified upstream capability. */
export function suggestModelCapability(id: string): ChannelCapability {
  if (/(?:tts|speech|audio|voice|whisper|music|suno)/i.test(id)) return 'audio';
  if (/(?:seedance|video|sora|veo|kling|vidu|wan[-_.]?\d|hailuo)/i.test(id)) return 'video';
  if (/(?:image|dall-e|flux|stable-diffusion|seedream|imagen|recraft)/i.test(id)) return 'image';
  if (/(?:hunyuan.?3d|trellis|tripo|mesh|3d)/i.test(id)) return 'model';
  return 'chat';
}
