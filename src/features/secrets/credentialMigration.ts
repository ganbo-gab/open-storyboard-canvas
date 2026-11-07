import type { StateStorage } from 'zustand/middleware';
import { isSecretRef, secretRefFromToken, secretStore, secretToken, type SecretNamespace, type SecretRef, type SecretStore } from './secretStore';

interface CredentialWrite { ref: SecretRef; value: string }
export interface CredentialMigration<T> { value: T; writes: CredentialWrite[]; refs: SecretRef[] }
const SECRET_FIELD = /^(?:api[-_]?key|api_key_comfy_org|agnesApiKey|access[-_]?token|refresh[-_]?token|token|password|secret|secretKey|comfyOrgKey|authorization|cookie|private[-_]?key)$/i;
const SECRET_QUERY = /^(?:api[-_]?key|api_key_comfy_org|access[-_]?token|refresh[-_]?token|token|password|secret|signature|sig|authorization|auth|credential|x-amz-signature)$/i;

/** Pure planning: values leave ordinary state before the asynchronous vault write begins. */
export function planCredentialMigration<T>(input: T, namespace: SecretNamespace, id: string): CredentialMigration<T> {
  const writes: CredentialWrite[] = []; const refs: SecretRef[] = [];
  function protect(value: string, path: string[]): string {
    if (!value) return value;
    const existing = secretRefFromToken(value);
    if (existing) { refs.push(existing); return value; }
    // Channel templates are instructions, not credential values.
    if (/^\{\{[^{}]+\}\}$/.test(value)) return value;
    const primary = path.at(-1) === 'apiKey' && path.length === 1;
    const ref: SecretRef = { namespace, id: primary ? id : `${id}/${path.map(encodeURIComponent).join('/')}` };
    writes.push({ ref, value }); refs.push(ref); return secretToken(ref);
  }
  function visit(value: unknown, path: string[], sensitive = false): unknown {
    if (typeof value === 'string') {
      if (sensitive) return protect(value, path);
      if (/^https?:\/\//i.test(value)) {
        try {
          const url = new URL(value); let changed = false;
          if (url.username) { url.username = protect(decodeURIComponent(url.username), [...path, 'username']); changed = true; }
          if (url.password) { url.password = protect(decodeURIComponent(url.password), [...path, 'password']); changed = true; }
          for (const [key, item] of [...url.searchParams]) if (SECRET_QUERY.test(key) && item) {
            url.searchParams.set(key, protect(item, [...path, 'query', key])); changed = true;
          }
          if (changed) return url.href;
        } catch { /* Non-URL templates are preserved by their domain validator. */ }
      }
      return value;
    }
    if (Array.isArray(value)) return value.map((entry: unknown, index) => visit(entry, [...path, String(index)]));
    if (!value || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(record).map(([key, item]) => {
      if (key.endsWith('Ref')) {
        if (isSecretRef(item)) { refs.push(item); return [key, { namespace: item.namespace, id: item.id }]; }
        return [key, visit(item, [...path, key])];
      }
      if (key === 'credentialState') return [key, item];
      const map = ['apiKeys', 'credentials', 'extraHeaders', 'queryParams'].includes(key);
      if (map && item && typeof item === 'object' && !Array.isArray(item)) return [key, Object.fromEntries(Object.entries(item).map(([name, entry]) => [name, visit(entry, [...path, key, name], true)]))];
      return [key, visit(item, [...path, key], SECRET_FIELD.test(key) || (key === 'value' && path.at(-1) === 'auth'))];
    }));
  }
  return { value: visit(input, []) as T, writes, refs };
}
export async function commitCredentialMigration<T>(plan: CredentialMigration<T>, store: SecretStore = secretStore): Promise<T> {
  for (const { ref, value } of plan.writes) {
    // Idempotent after partial failure: do not rewrite verified entries.
    if (await store.get(ref) !== value) await store.set(ref, value);
  }
  // Existing refs are already persistence-safe. Saving a setting must not probe the vault.
  return plan.value;
}
export async function protectCredentials<T>(input: T, namespace: SecretNamespace, id: string, store: SecretStore = secretStore): Promise<T> {
  return commitCredentialMigration(planCredentialMigration(input, namespace, id), store);
}

// Reference identities only, never credential values. Multiple stores may hydrate the same ref.
const hydrationProbes = new WeakMap<SecretStore, Set<string>>();
async function probeHydratedReferences(refs: readonly SecretRef[], store: SecretStore): Promise<void> {
  let attempted = hydrationProbes.get(store);
  if (!attempted) { attempted = new Set(); hydrationProbes.set(store, attempted); }
  const probes: Promise<unknown>[] = [];
  for (const ref of refs) {
    const key = JSON.stringify([ref.namespace, ref.id]);
    if (attempted.has(key)) continue;
    attempted.add(key);
    // A successful plaintext migration has already verified this ref; no existence check is needed.
    if (store.state(ref) === 'present') continue;
    // A later explicit rehydrate can retry a failed probe, but ordinary persistence never does.
    probes.push(store.has(ref).catch(() => { attempted.delete(key); }));
  }
  await Promise.all(probes);
}

/** A failed migration never overwrites the original persisted bytes, even on later Zustand writes. */
export function createSecretStorage(storage: StateStorage, namespace: SecretNamespace, store: SecretStore = secretStore): StateStorage {
  const blocked = new Set<string>();
  const queues = new Map<string, Promise<void>>();
  const hydrating = new Map<string, Promise<string | null>>();
  async function queued<T>(name: string, action: () => Promise<T>): Promise<T> {
    const previous = queues.get(name);
    const work = (async () => { await previous; return await action(); })();
    // Serialize hydration with persistence, including concurrent first reads of legacy plaintext.
    const settled = work.then(() => undefined, () => undefined);
    queues.set(name, settled);
    try { return await work; } finally { if (queues.get(name) === settled) queues.delete(name); }
  }
  async function migrate(name: string, raw: string): Promise<string> {
    const parsed: unknown = JSON.parse(raw);
    const plan = planCredentialMigration(parsed, namespace, name);
    try {
      await commitCredentialMigration(plan, store);
      blocked.delete(name);
      const next = JSON.stringify(plan.value);
      if (next !== raw && await storage.getItem(name) === raw) await storage.setItem(name, next);
      return next;
    } catch {
      blocked.add(name);
      // Hydration can expose refs and state=locked/error, never the legacy values.
      return JSON.stringify(plan.value);
    }
  }
  async function hydrate(name: string): Promise<string | null> {
    // getItem/rehydrate is the explicit recovery boundary; unrelated setItem never retries.
    blocked.delete(name);
    const raw = await storage.getItem(name);
    if (raw === null) return null;
    const next = await migrate(name, raw);
    if (!blocked.has(name)) {
      await probeHydratedReferences(planCredentialMigration(JSON.parse(next) as unknown, namespace, name).refs, store);
    }
    return next;
  }
  return {
    getItem: (name) => {
      const existing = hydrating.get(name);
      if (existing) return existing;
      const work = queued(name, () => hydrate(name));
      hydrating.set(name, work);
      void work.finally(() => { if (hydrating.get(name) === work) hydrating.delete(name); }).catch(() => undefined);
      return work;
    },
    setItem: (name, raw) => queued(name, async () => {
        if (blocked.has(name)) return;
        const old = await storage.getItem(name);
        if (old !== null) {
          const oldPlan = planCredentialMigration(JSON.parse(old) as unknown, namespace, name);
          if (oldPlan.writes.length) await migrate(name, old);
          if (blocked.has(name)) return;
        }
        const plan = planCredentialMigration(JSON.parse(raw) as unknown, namespace, name);
        try { await commitCredentialMigration(plan, store); await storage.setItem(name, JSON.stringify(plan.value)); }
        catch { blocked.add(name); }
      }),
    removeItem: (name) => queued(name, async () => { await storage.removeItem(name); blocked.delete(name); }),
  };
}
