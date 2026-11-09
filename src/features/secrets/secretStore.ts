import { invoke, isTauri } from '@tauri-apps/api/core';
import { create } from 'zustand';
import { z } from 'zod';
import { credentialFailureOf, isTransientCredentialFailure } from './credentialFailure';

export const secretNamespaces = ['channel', 'provider', 'settings', 'image-host', 'agent-model', 'comfyui'] as const;
export type SecretNamespace = typeof secretNamespaces[number];
export interface SecretRef { namespace: SecretNamespace; id: string }
export type CredentialState = 'missing' | 'present' | 'locked' | 'error';
export interface SecretBackend {
  get(ref: SecretRef): Promise<string | null>;
  set(ref: SecretRef, value: string): Promise<void>;
  delete(ref: SecretRef): Promise<void>;
  has(ref: SecretRef): Promise<boolean>;
  retryAccess?(ref: SecretRef): Promise<boolean>;
}
export interface SecretStore extends SecretBackend {
  retryAccess(ref: SecretRef): Promise<boolean>;
  reveal(ref: SecretRef): Promise<string | null>;
  state(ref: SecretRef | null | undefined): CredentialState;
  subscribe(listener: () => void): () => void;
}
export class SecretStoreError extends Error {
  constructor(readonly state: 'locked' | 'error', readonly code: string) {
    super(`Credential vault ${state}: ${code}`); this.name = 'SecretStoreError';
  }
}
export function isSecretRef(value: unknown): value is SecretRef {
  if (!value || typeof value !== 'object') return false;
  const ref = value as Record<string, unknown>;
  return Object.keys(ref).every((key) => key === 'namespace' || key === 'id')
    && secretNamespaces.includes(ref.namespace as SecretNamespace) && typeof ref.id === 'string'
    && ref.id.length > 0 && new TextEncoder().encode(ref.id).length <= 512 && ref.id.trim() === ref.id
    && !/[\u0000-\u001f\u007f-\u009f]/.test(ref.id);
}
function assertRef(ref: SecretRef): void {
  if (!isSecretRef(ref)) throw new SecretStoreError('error', 'invalid-reference');
}
export function secretToken(ref: SecretRef): string {
  assertRef(ref);
  const bytes = new TextEncoder().encode(JSON.stringify({ namespace: ref.namespace, id: ref.id }));
  return `__SC_SECRET_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}__`;
}
const TOKEN = /__SC_SECRET_([A-Za-z0-9_-]+?)__/g;
export function secretRefFromToken(value: string): SecretRef | null {
  const match = /^__SC_SECRET_([A-Za-z0-9_-]+)__$/s.exec(value);
  if (!match) return null;
  try {
    const data = match[1].replace(/-/g, '+').replace(/_/g, '/');
    const ref: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(data.padEnd(Math.ceil(data.length / 4) * 4, '=')), (c) => c.charCodeAt(0))));
    return isSecretRef(ref) ? ref : null;
  } catch { return null; }
}
function safeError(error: unknown): SecretStoreError {
  if (error instanceof SecretStoreError) return error;
  const known = credentialFailureOf(error);
  if (known) return new SecretStoreError(known.state, known.code);
  let value: unknown = error;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = null; } }
  if (z.object({ state: z.literal('locked') }).safeParse(value).success) return new SecretStoreError('locked', 'vault-locked');
  return new SecretStoreError('error', 'vault-operation-failed');
}
const nativeBackend: SecretBackend = {
  async get(ref) { if (!isTauri()) throw new SecretStoreError('locked', 'desktop-vault-required'); return invoke<string | null>('secret_get', { secretRef: ref }); },
  async set(ref, value) { if (!isTauri()) throw new SecretStoreError('locked', 'desktop-vault-required'); await invoke('secret_set', { secretRef: ref, value }); },
  async delete(ref) { if (!isTauri()) throw new SecretStoreError('locked', 'desktop-vault-required'); await invoke('secret_delete', { secretRef: ref }); },
  async has(ref) { if (!isTauri()) throw new SecretStoreError('locked', 'desktop-vault-required'); return invoke<boolean>('secret_has', { secretRef: ref }); },
  async retryAccess(ref) { if (!isTauri()) throw new SecretStoreError('locked', 'desktop-vault-required'); return invoke<boolean>('secret_retry_access', { secretRef: ref }); },
};
interface VaultState { states: Record<string, CredentialState> }
export const useSecretStatusStore = create<VaultState>(() => ({ states: {} }));
const refKey = (ref: SecretRef) => JSON.stringify([ref.namespace, ref.id]);
// Input-only separation guard, never an execution cache. Backend get/has do not populate it,
// so native hydration never reads key values through JavaScript. Nothing here is observable by React.
const enteredCredentials = new Map<string, string>();
export function credentialAppearsIn(ref: SecretRef | null | undefined, serialized: string): boolean {
  const entered = ref ? enteredCredentials.get(refKey(ref)) : undefined;
  return Boolean(entered && serialized.includes(JSON.stringify(entered).slice(1, -1)));
}
function setState(ref: SecretRef, state: CredentialState): void {
  const key = refKey(ref);
  if (useSecretStatusStore.getState().states[key] !== state) useSecretStatusStore.setState((old) => ({ states: { ...old.states, [key]: state } }));
}
export function credentialState(ref: SecretRef | null | undefined): CredentialState {
  return ref ? useSecretStatusStore.getState().states[refKey(ref)] ?? 'missing' : 'missing';
}
export function useCredentialState(ref: SecretRef | null | undefined): CredentialState {
  return useSecretStatusStore((state) => ref ? state.states[refKey(ref)] ?? 'missing' : 'missing');
}
/** Backend reads are transient and values never enter Zustand. User-entered inputs have a private separation guard. */
export function createSecretStore(backend: SecretBackend): SecretStore {
  const pending = new Map<string, Promise<void>>();
  const probes = new Map<string, Promise<boolean>>();
  const revisions = new Map<string, number>();
  const failures = new Map<string, SecretStoreError>();
  const advance = (ref: SecretRef) => {
    const key = refKey(ref);
    revisions.set(key, (revisions.get(key) ?? 0) + 1);
  };
  async function operation<T>(ref: SecretRef, run: () => Promise<T>): Promise<T> {
    assertRef(ref);
    try { const result = await run(); failures.delete(refKey(ref)); return result; }
    catch (error) { const safe = safeError(error); failures.set(refKey(ref), safe); setState(ref, safe.state); throw safe; }
  }
  const store = {
    get: (ref: SecretRef): Promise<string | null> => operation(ref, async () => {
      advance(ref);
      await pending.get(refKey(ref));
      const value = await backend.get(ref); setState(ref, value === null ? 'missing' : 'present'); return value;
    }),
    set: (ref: SecretRef, value: string): Promise<void> => {
      assertRef(ref);
      advance(ref);
      const key = refKey(ref);
      const previous = pending.get(key);
      const work = operation(ref, async () => {
        await previous?.catch(() => undefined);
        await backend.set(ref, value);
        if (await backend.get(ref) !== value) throw new SecretStoreError('error', 'read-back-mismatch');
        enteredCredentials.set(key, value);
        setState(ref, 'present');
      });
      pending.set(key, work);
      void work.finally(() => { if (pending.get(key) === work) pending.delete(key); }).catch(() => undefined);
      return work;
    },
    delete: (ref: SecretRef): Promise<void> => operation(ref, async () => {
      advance(ref);
      await pending.get(refKey(ref)); await backend.delete(ref); enteredCredentials.delete(refKey(ref)); setState(ref, 'missing');
    }),
    has: (ref: SecretRef): Promise<boolean> => {
      assertRef(ref);
      const key = refKey(ref);
      const existing = probes.get(key);
      if (existing) return existing;
      const probe = (async () => {
        await pending.get(key);
        const revision = revisions.get(key) ?? 0;
        try {
          const present = await backend.has(ref);
          if (revision === (revisions.get(key) ?? 0)) {
            // Existence metadata does not prove that a previously denied secret is readable.
            const state = credentialState(ref);
            // A recovered availability probe may clear a transient storage error, but never
            // a denied read or failed write verification just because an entry exists.
            if (!present || (state !== 'locked' && (state !== 'error' || isTransientCredentialFailure(failures.get(key))))) {
              failures.delete(key);
              setState(ref, present ? 'present' : 'missing');
            }
          }
          return present;
        } catch (error) {
          const safe = safeError(error);
          if (revision === (revisions.get(key) ?? 0)) { failures.set(key, safe); setState(ref, safe.state); }
          throw safe;
        }
      })();
      probes.set(key, probe);
      void probe.finally(() => { if (probes.get(key) === probe) probes.delete(key); }).catch(() => undefined);
      return probe;
    },
    reveal: (ref: SecretRef): Promise<string | null> => store.get(ref),
    retryAccess: (ref: SecretRef): Promise<boolean> => operation(ref, async () => {
      advance(ref);
      await pending.get(refKey(ref));
      if (!backend.retryAccess) throw new SecretStoreError('error', 'vault-operation-failed');
      const present = await backend.retryAccess(ref);
      setState(ref, present ? 'present' : 'missing');
      return present;
    }),
    state: credentialState,
    subscribe: (listener: () => void): (() => void) => useSecretStatusStore.subscribe(listener),
  };
  return store;
}
export const secretStore = createSecretStore(nativeBackend);

/** Explicit user action only. Native code retains authorized values; IPC returns presence, never the secret. */
export async function retrySecretAccess(ref: SecretRef): Promise<boolean> {
  return secretStore.retryAccess(ref);
}

/** Browser-only just-in-time interpolation. Native transports send refs directly to Rust. */
export async function resolveSecretTokens(value: string, url = false, store: SecretStore = secretStore): Promise<string> {
  let result = ''; let cursor = 0;
  for (const match of value.matchAll(TOKEN)) {
    const ref = secretRefFromToken(match[0]);
    if (!ref) throw new SecretStoreError('error', 'invalid-reference');
    const secret = await store.get(ref);
    if (secret === null) throw new SecretStoreError('error', 'credential-missing');
    result += value.slice(cursor, match.index) + (url ? encodeURIComponent(secret) : secret);
    cursor = match.index! + match[0].length;
  }
  return result + value.slice(cursor);
}
export async function resolveSecretValue<T>(value: T, store: SecretStore = secretStore): Promise<T> {
  if (typeof value === 'string') return await resolveSecretTokens(value, false, store) as T;
  if (Array.isArray(value)) return await Promise.all(value.map((entry: unknown) => resolveSecretValue(entry, store))) as T;
  if (value && typeof value === 'object') {
    const entries = await Promise.all(Object.entries(value).map(async ([key, entry]: [string, unknown]) => [key, await resolveSecretValue(entry, store)] as const));
    return Object.fromEntries(entries) as T;
  }
  return value;
}
