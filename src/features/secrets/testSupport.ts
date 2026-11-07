import { afterEach, beforeEach, vi } from 'vitest';
import { getChannelCredentialRef } from '@/features/channels/store/channelStore';
import { createSecretStore, secretStore, useSecretStatusStore, type SecretRef } from './secretStore';

/** Deterministic test-only backend; this module is never imported by application code. */
export function useMemorySecretVault(): void {
  beforeEach(() => {
    const values = new Map<string, string>();
    const key = (ref: SecretRef) => JSON.stringify(ref);
    const memory = createSecretStore({
      get: async (ref) => values.get(key(ref)) ?? null,
      set: async (ref, value) => { values.set(key(ref), value); },
      has: async (ref) => values.has(key(ref)),
      delete: async (ref) => { values.delete(key(ref)); },
    });
    useSecretStatusStore.setState({ states: {} });
    vi.spyOn(secretStore, 'get').mockImplementation(memory.get);
    vi.spyOn(secretStore, 'set').mockImplementation(memory.set);
    vi.spyOn(secretStore, 'has').mockImplementation(memory.has);
    vi.spyOn(secretStore, 'delete').mockImplementation(memory.delete);
  });
  afterEach(() => vi.restoreAllMocks());
}
export async function revealChannelCredential(id: string): Promise<string | null> {
  const ref = getChannelCredentialRef(id);
  return ref ? secretStore.reveal(ref) : null;
}
