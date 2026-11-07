import { useTranslation } from 'react-i18next';
import { channelCapabilities, type CapabilityCounts, type ChannelCapability } from '../application/channelCapabilities';
import { CAPABILITY_ICON, CAPABILITY_TINT } from './capabilityStyles';

/** 「视频 4」: capability in its cap-* color, optionally with how many models provide it. */
export function CapabilityBadge({ capability, count, className = '' }: {
  capability: ChannelCapability;
  count?: number;
  className?: string;
}) {
  const { t } = useTranslation();
  const Icon = CAPABILITY_ICON[capability];
  return (
    <span className={`inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full pl-1.5 pr-2 text-[11px] font-medium leading-none ${CAPABILITY_TINT[capability]} ${className}`}>
      <Icon className="h-3 w-3" aria-hidden />
      {t(`ui.channels.cap.${capability}.short`)}
      {count !== undefined && <span className="tabular-nums">{count}</span>}
    </span>
  );
}

/** Badges for every capability with at least one model, in the fixed capability order. */
export function CapabilityBadges({ counts, capabilities, className = '' }: {
  counts?: CapabilityCounts;
  capabilities?: readonly ChannelCapability[];
  className?: string;
}) {
  const list = channelCapabilities.filter((capability) => capabilities ? capabilities.includes(capability) : (counts?.[capability] ?? 0) > 0);
  if (!list.length) return null;
  return (
    <span className={`flex flex-wrap gap-1 ${className}`}>
      {list.map((capability) => <CapabilityBadge key={capability} capability={capability} count={counts?.[capability]} />)}
    </span>
  );
}
