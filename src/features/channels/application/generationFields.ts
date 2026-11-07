/** Persisted UI state only. Live request validation must never silently discard invalid references. */
export interface ChannelGenerationFields {
  channelModeId?: string;
  referenceSlots?: Record<string, string[]>;
}
export function normalizeChannelGenerationFields(value: unknown): ChannelGenerationFields {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const channelModeId = typeof record.channelModeId === 'string' && record.channelModeId.trim() ? record.channelModeId : undefined;
  const raw = record.referenceSlots;
  const referenceSlots = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? Object.fromEntries(Object.entries(raw).flatMap(([slot, sources]) => {
      if (!slot.trim() || !Array.isArray(sources)) return [];
      const strings = sources.filter((source): source is string => typeof source === 'string' && Boolean(source.trim()));
      return strings.length ? [[slot, strings]] : [];
    })) : undefined;
  // Retain an explicit empty map: it must still fail a mode's required-slot validation.
  return { channelModeId, referenceSlots };
}
