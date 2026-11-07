import { AudioLines, Box, Clapperboard, ImageIcon, MessageSquareText, type LucideIcon } from 'lucide-react';
import type { ChannelCapability } from '../application/channelCapabilities';

/** One look per capability across the app: icon + cap-* token tint. Literal classes so Tailwind emits them. */
export const CAPABILITY_ICON: Record<ChannelCapability, LucideIcon> = {
  chat: MessageSquareText,
  image: ImageIcon,
  video: Clapperboard,
  audio: AudioLines,
  model: Box,
};

export const CAPABILITY_TINT: Record<ChannelCapability, string> = {
  chat: 'text-cap-chat bg-cap-chat/12',
  image: 'text-cap-image bg-cap-image/12',
  video: 'text-cap-video bg-cap-video/12',
  audio: 'text-cap-audio bg-cap-audio/12',
  model: 'text-cap-model bg-cap-model/12',
};

export const CAPABILITY_TEXT: Record<ChannelCapability, string> = {
  chat: 'text-cap-chat',
  image: 'text-cap-image',
  video: 'text-cap-video',
  audio: 'text-cap-audio',
  model: 'text-cap-model',
};
