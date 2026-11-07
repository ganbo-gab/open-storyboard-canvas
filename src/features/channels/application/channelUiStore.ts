import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { z } from 'zod';

/**
 * Settings-page UI memory only: whether a channel has been tested and which migration notice was
 * dismissed. Never holds profiles or credentials (those stay in channelStore / the vault).
 */
const testRecordSchema = z.strictObject({
  result: z.enum(['passed', 'failed']),
  method: z.enum(['models', 'smoke']),
  at: z.number().finite(),
  modelCount: z.number().int().nonnegative().optional(),
  message: z.string().max(2000).optional(),
});
export type ChannelTestRecord = z.infer<typeof testRecordSchema>;
export type ChannelTestStatus = 'untested' | ChannelTestRecord['result'];

const persistedSchema = z.object({
  tests: z.record(z.string(), testRecordSchema).catch({}),
  dismissedMigrationNotice: z.string().catch(''),
});

interface ChannelUiState {
  tests: Record<string, ChannelTestRecord>;
  dismissedMigrationNotice: string;
  /** Saved-config list → channel page handoff; consumed once, not persisted. */
  focusChannelId: string | null;
}

export const useChannelUiStore = create<ChannelUiState>()(persist<ChannelUiState, [], [], Pick<ChannelUiState, 'tests' | 'dismissedMigrationNotice'>>(() => ({
  tests: {},
  dismissedMigrationNotice: '',
  focusChannelId: null,
}), {
  name: 'channel-settings-ui',
  version: 1,
  storage: createJSONStorage(() => localStorage),
  partialize: (state) => ({ tests: state.tests, dismissedMigrationNotice: state.dismissedMigrationNotice }),
  merge: (persisted, current) => {
    const parsed = persistedSchema.safeParse(persisted);
    return parsed.success ? { ...current, ...parsed.data } : current;
  },
}));

export function recordChannelTest(channelId: string, record: Omit<ChannelTestRecord, 'at'>): void {
  const entry = testRecordSchema.parse({ ...record, at: Date.now(), ...(record.message ? { message: record.message.slice(0, 2000) } : {}) });
  useChannelUiStore.setState((state) => ({ tests: { ...state.tests, [channelId]: entry } }));
}

export function clearChannelTest(channelId: string): void {
  useChannelUiStore.setState((state) => {
    if (!(channelId in state.tests)) return state;
    const tests = { ...state.tests };
    delete tests[channelId];
    return { tests };
  });
}

/** Drops results of channels that no longer exist (deleted elsewhere or never saved). */
export function pruneChannelTests(keepIds: readonly string[]): void {
  const keep = new Set(keepIds);
  useChannelUiStore.setState((state) => {
    const entries = Object.entries(state.tests);
    const kept = entries.filter(([id]) => keep.has(id));
    return kept.length === entries.length ? state : { tests: Object.fromEntries(kept) };
  });
}

export function channelTestStatus(record: ChannelTestRecord | undefined): ChannelTestStatus {
  return record?.result ?? 'untested';
}

export function dismissMigrationNotice(signature: string): void {
  useChannelUiStore.setState({ dismissedMigrationNotice: signature });
}

export function requestChannelFocus(channelId: string): void {
  useChannelUiStore.setState({ focusChannelId: channelId });
}

export function consumeChannelFocus(): string | null {
  const id = useChannelUiStore.getState().focusChannelId;
  if (id) useChannelUiStore.setState({ focusChannelId: null });
  return id;
}
