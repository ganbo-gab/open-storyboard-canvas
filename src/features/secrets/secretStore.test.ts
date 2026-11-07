import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSecretStore, credentialState, resolveSecretTokens, resolveSecretValue, secretRefFromToken, secretToken, SecretStoreError, useSecretStatusStore, type SecretBackend, type SecretRef } from './secretStore';
import { commitCredentialMigration, createSecretStorage, planCredentialMigration, protectCredentials } from './credentialMigration';

function memoryBackend() {
  const values = new Map<string, string>();
  const key = (ref: SecretRef) => JSON.stringify(ref);
  const backend: SecretBackend = {
    get: vi.fn(async (ref) => values.get(key(ref)) ?? null),
    set: vi.fn(async (ref, value) => { values.set(key(ref), value); }),
    delete: vi.fn(async (ref) => { values.delete(key(ref)); }),
    has: vi.fn(async (ref) => values.has(key(ref))),
  };
  return { values, backend, store: createSecretStore(backend) };
}
function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { values, storage: {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: vi.fn((name: string, value: string) => { values.set(name, value); }),
    removeItem: (name: string) => { values.delete(name); },
  } };
}
const ref: SecretRef = { namespace: 'channel', id: '用户/provider:one' };
beforeEach(() => useSecretStatusStore.setState({ states: {} }));

describe('system credential vault contract', () => {
  it('round-trips typed URL-safe refs without exposing a value', () => {
    const token = secretToken(ref);
    expect(encodeURIComponent(token)).toBe(token);
    expect(secretRefFromToken(token)).toEqual(ref);
    expect(secretRefFromToken('plaintext-key')).toBeNull();
    expect(() => secretToken({ namespace: 'channel', id: '' })).toThrow('invalid-reference');
  });
  it('sets and verifies values, reveals only explicitly, deletes idempotently, and stores only status', async () => {
    const { store } = memoryBackend();
    expect(await store.has(ref)).toBe(false);
    expect(credentialState(ref)).toBe('missing');
    await store.set(ref, 'VAULT_ONLY_SECRET');
    expect(await store.has(ref)).toBe(true);
    expect(await store.reveal(ref)).toBe('VAULT_ONLY_SECRET');
    expect(JSON.stringify(useSecretStatusStore.getState())).not.toContain('VAULT_ONLY_SECRET');
    await store.delete(ref); await store.delete(ref);
    expect(await store.get(ref)).toBeNull();
    expect(credentialState(ref)).toBe('missing');
  });
  it('reports a safe error rather than leaking backend messages', async () => {
    const { backend } = memoryBackend();
    vi.mocked(backend.set).mockRejectedValue(new Error('key=DO_NOT_LOG_THIS'));
    const store = createSecretStore(backend);
    await expect(store.set(ref, 'DO_NOT_LOG_THIS')).rejects.toMatchObject({ state: 'error', code: 'vault-operation-failed' });
    expect(credentialState(ref)).toBe('error');
    expect(JSON.stringify(useSecretStatusStore.getState())).not.toContain('DO_NOT_LOG_THIS');
  });
  it('reports locked separately and rejects a failed read-back', async () => {
    const { backend } = memoryBackend();
    vi.mocked(backend.get).mockRejectedValueOnce({ state: 'locked', code: 'os-access-denied', detail: 'PRIVATE' });
    const store = createSecretStore(backend);
    await expect(store.get(ref)).rejects.toMatchObject({ state: 'locked' });
    expect(credentialState(ref)).toBe('locked');
    vi.mocked(backend.get).mockResolvedValue(null);
    await expect(store.set(ref, 'NOT_READ_BACK')).rejects.toMatchObject({ code: 'read-back-mismatch' });
    expect(credentialState(ref)).toBe('error');
  });
  it('resolves only at browser request time and URL-encodes key data', async () => {
    const { store } = memoryBackend(); await store.set(ref, 'secret +&=?/#');
    const token = secretToken(ref);
    expect(await resolveSecretTokens(`Bearer ${token}`, false, store)).toBe('Bearer secret +&=?/#');
    expect(await resolveSecretTokens(`https://api.example/?key=${token}&page=1`, true, store))
      .toBe('https://api.example/?key=secret%20%2B%26%3D%3F%2F%23&page=1');
    expect(await resolveSecretValue({ headers: { Authorization: `Bearer ${token}` }, body: [token] }, store))
      .toEqual({ headers: { Authorization: 'Bearer secret +&=?/#' }, body: ['secret +&=?/#'] });
    await store.delete(ref);
    await expect(resolveSecretTokens(token, false, store)).rejects.toBeInstanceOf(SecretStoreError);
  });
  it('coalesces overlapping existence probes without reading or caching secret values', async () => {
    const { backend, store } = memoryBackend();
    const result = Promise.withResolvers<boolean>();
    vi.mocked(backend.has).mockReturnValueOnce(result.promise);
    const probes = [store.has(ref), store.has({ ...ref }), store.has(ref)];
    await vi.waitFor(() => expect(backend.has).toHaveBeenCalledOnce());
    expect(backend.get).not.toHaveBeenCalled();
    expect(credentialState(ref)).toBe('missing');
    result.resolve(true);
    expect(await Promise.all(probes)).toEqual([true, true, true]);
    expect(credentialState(ref)).toBe('present');
    vi.mocked(backend.has).mockResolvedValueOnce(false);
    expect(await store.has(ref)).toBe(false);
    expect(backend.has).toHaveBeenCalledTimes(2);
    expect(credentialState(ref)).toBe('missing');
  });
  it('does not clear a denied read merely because metadata says the item exists', async () => {
    const { backend, store } = memoryBackend();
    vi.mocked(backend.get).mockRejectedValueOnce({ state: 'locked', code: 'access-denied' });
    await expect(store.get(ref)).rejects.toMatchObject({ state: 'locked' });
    vi.mocked(backend.has).mockResolvedValue(true);
    expect(await store.has(ref)).toBe(true);
    expect(credentialState(ref)).toBe('locked');
    vi.mocked(backend.get).mockResolvedValueOnce('EXPLICIT_RECOVERY');
    expect(await store.reveal(ref)).toBe('EXPLICIT_RECOVERY');
    expect(credentialState(ref)).toBe('present');
  });
  it('ignores stale metadata when a later credential operation has changed its status', async () => {
    const { backend, store } = memoryBackend();
    const probe = Promise.withResolvers<boolean>();
    vi.mocked(backend.has).mockReturnValueOnce(probe.promise);
    const checking = store.has(ref);
    await vi.waitFor(() => expect(backend.has).toHaveBeenCalledOnce());
    await store.set(ref, 'NEW_VERIFIED_VALUE');
    probe.resolve(false);
    expect(await checking).toBe(false);
    expect(credentialState(ref)).toBe('present');
    expect(await store.get(ref)).toBe('NEW_VERIFIED_VALUE');
  });
  it('keeps explicit authorization status when an older metadata probe finishes later', async () => {
    const { backend } = memoryBackend();
    const probe = Promise.withResolvers<boolean>();
    vi.mocked(backend.has).mockReturnValueOnce(probe.promise);
    const retryAccess = vi.fn(async () => true);
    const store = createSecretStore({ ...backend, retryAccess });
    const checking = store.has(ref);
    await vi.waitFor(() => expect(backend.has).toHaveBeenCalledOnce());
    expect(await store.retryAccess(ref)).toBe(true);
    probe.resolve(false);
    expect(await checking).toBe(false);
    expect(credentialState(ref)).toBe('present');
    expect(retryAccess).toHaveBeenCalledExactlyOnceWith(ref);
    expect(backend.get).not.toHaveBeenCalled();
  });
});

const legacyFixture = {
  state: {
    apiKeys: { builtin: 'BUILTIN_PRIVATE' }, agnesApiKey: 'AGNES_PRIVATE',
    imageHostSettings: { seedvault: { email: 'user@example.test', password: 'HOST_PASSWORD_PRIVATE', token: 'HOST_TOKEN_PRIVATE' } },
    providers: [
      { id: 'comfy', apiKey: 'COMFY_PRIVATE', extraHeaders: { 'X-Tunnel': 'TUNNEL_PRIVATE' }, queryParams: { ticket: 'QUERY_PRIVATE' }, extraParams: { comfyui: { comfyOrgKey: 'ORG_PRIVATE' } } },
      { id: 'agent-model', apiKey: 'AGENT_PRIVATE', extraParams: { auth: { mode: 'header', value: 'AUTH_PRIVATE' } } },
    ],
    baseUrl: 'https://api.example.test/path?token=URL_PRIVATE&version=1',
  }, version: 23,
};
const sentinels = ['BUILTIN_PRIVATE', 'AGNES_PRIVATE', 'HOST_PASSWORD_PRIVATE', 'HOST_TOKEN_PRIVATE', 'COMFY_PRIVATE', 'TUNNEL_PRIVATE', 'QUERY_PRIVATE', 'ORG_PRIVATE', 'AGENT_PRIVATE', 'AUTH_PRIVATE', 'URL_PRIVATE'];

describe('first-run credential migration and persistence', () => {
  it('moves every plaintext fixture field into the vault and commits ref-only JSON after verified read-back', async () => {
    const { store, values: vault } = memoryBackend();
    const { storage, values } = memoryStorage({ settings: JSON.stringify(legacyFixture) });
    const secured = createSecretStorage(storage, 'settings', store);
    const hydrated = await secured.getItem('settings');
    const persisted = values.get('settings')!;
    expect(hydrated).toBe(persisted);
    for (const secret of sentinels) { expect(persisted).not.toContain(secret); expect([...vault.values()]).toContain(secret); }
    const parsed = JSON.parse(persisted) as typeof legacyFixture;
    expect(secretRefFromToken(parsed.state.apiKeys.builtin)).toMatchObject({ namespace: 'settings' });
    expect(parsed.state.imageHostSettings.seedvault.email).toBe('user@example.test');
    expect(new URL(parsed.state.baseUrl).searchParams.get('version')).toBe('1');
  });
  it('is idempotent including recovery after a partial migration', async () => {
    const { backend, store } = memoryBackend(); const raw = JSON.stringify(legacyFixture);
    const { storage, values } = memoryStorage({ settings: raw });
    const set = vi.mocked(backend.set); const original = set.getMockImplementation()!;
    set.mockImplementationOnce(original).mockRejectedValueOnce(new Error('keychain temporarily unavailable'));
    const secured = createSecretStorage(storage, 'settings', store);
    await secured.getItem('settings');
    expect(values.get('settings')).toBe(raw);
    await secured.getItem('settings');
    const writes = set.mock.calls.length;
    const migrated = values.get('settings');
    await secured.getItem('settings');
    expect(values.get('settings')).toBe(migrated);
    expect(set.mock.calls.length).toBe(writes);
  });
  it('preserves the exact legacy bytes on failure and never hydrates plaintext or overwrites it with later changes', async () => {
    const { backend, store } = memoryBackend();
    vi.mocked(backend.set).mockRejectedValue(new Error('locked keychain SECRET_FROM_BACKEND'));
    const raw = JSON.stringify(legacyFixture, null, 2);
    const { storage, values } = memoryStorage({ settings: raw });
    const secured = createSecretStorage(storage, 'settings', store);
    const hydrated = await secured.getItem('settings');
    for (const secret of sentinels) expect(hydrated).not.toContain(secret);
    expect(values.get('settings')).toBe(raw);
    const reads = vi.mocked(backend.get).mock.calls.length;
    const writes = vi.mocked(backend.set).mock.calls.length;
    for (const theme of ['light', 'dark', 'light']) await secured.setItem('settings', JSON.stringify({ state: { apiKeys: {}, theme }, version: 23 }));
    expect(values.get('settings')).toBe(raw);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(Object.values(useSecretStatusStore.getState().states)).toContain('error');
    expect(backend.get).toHaveBeenCalledTimes(reads);
    expect(backend.set).toHaveBeenCalledTimes(writes);
    expect(backend.has).not.toHaveBeenCalled();
  });
  it('guards writes even before async hydration completes', async () => {
    const { backend, store } = memoryBackend();
    vi.mocked(backend.set).mockRejectedValue(new Error('vault unavailable'));
    const raw = JSON.stringify(legacyFixture);
    const { storage, values } = memoryStorage({ settings: raw });
    await createSecretStorage(storage, 'settings', store).setItem('settings', JSON.stringify({ state: {} }));
    expect(values.get('settings')).toBe(raw);
  });
  it('protects future provider saves before values reach ordinary state', async () => {
    const { store } = memoryBackend();
    const original = { id: 'custom', apiKey: 'NEW_PROVIDER_SECRET', extraParams: { comfyOrgKey: 'NEW_PARTNER_SECRET' } };
    const safe = await protectCredentials(original, 'provider', original.id, store);
    expect(safe.apiKey).not.toBe(original.apiKey);
    expect(secretRefFromToken(safe.apiKey)).toEqual({ namespace: 'provider', id: 'custom' });
    expect(JSON.stringify(safe)).not.toContain('NEW_PARTNER_SECRET');
    expect(original.apiKey).toBe('NEW_PROVIDER_SECRET');
  });
  it('does not treat template declarations as literal credentials', async () => {
    const { backend, store } = memoryBackend();
    const input = { apiKey: '{{apiKey}}', queryParams: { key: '{{apiKey}}' }, extraParams: { max_tokens: 2048 } };
    expect(await commitCredentialMigration(planCredentialMigration(input, 'provider', 'template'), store)).toEqual(input);
    expect(backend.set).not.toHaveBeenCalled();
  });
  it('probes saved refs once on hydration and never probes them on repeated safe persistence', async () => {
    const { backend, store, values: vault } = memoryBackend();
    vault.set(JSON.stringify(ref), 'VAULT_ONLY_EXISTING');
    const token = secretToken(ref);
    const payload = { state: { apiKeys: { builtIn: token }, credentialRef: ref, theme: 'dark' }, version: 25 };
    const { storage, values } = memoryStorage({ settings: JSON.stringify(payload) });
    const secured = createSecretStorage(storage, 'settings', store);
    await secured.getItem('settings');
    expect(backend.has).toHaveBeenCalledOnce();
    expect(backend.get).not.toHaveBeenCalled();
    expect(credentialState(ref)).toBe('present');
    for (const theme of ['light', 'dark', 'light']) {
      await secured.setItem('settings', JSON.stringify({ ...payload, state: { ...payload.state, theme } }));
      await secured.getItem('settings');
      await protectCredentials(payload, 'settings', 'already-safe', store);
    }
    expect(backend.has).toHaveBeenCalledOnce();
    expect(backend.get).not.toHaveBeenCalled();
    expect(backend.set).not.toHaveBeenCalled();
    expect(values.get('settings')).toContain('"theme":"light"');
    expect(values.get('settings')).not.toContain('VAULT_ONLY_EXISTING');
  });
  it('does not grant present state to unprobed refs merely by saving or protecting them', async () => {
    const { backend, store } = memoryBackend();
    const payload = { apiKey: secretToken(ref), credentialRef: ref };
    expect(await protectCredentials(payload, 'provider', 'safe-ref', store)).toEqual(payload);
    const { storage } = memoryStorage();
    await createSecretStorage(storage, 'provider', store).setItem('safe-ref', JSON.stringify(payload));
    expect(credentialState(ref)).toBe('missing');
    expect(backend.has).not.toHaveBeenCalled();
    expect(backend.get).not.toHaveBeenCalled();
    expect(backend.set).not.toHaveBeenCalled();
  });
  it('merges concurrent denied hydration, blocks unrelated writes, and permits explicit rehydrate recovery', async () => {
    const { backend, store } = memoryBackend();
    const gate = Promise.withResolvers<string | null>();
    const read = vi.mocked(backend.get);
    read.mockReturnValueOnce(gate.promise);
    const raw = JSON.stringify({ state: { apiKey: 'LEGACY_RECOVERABLE', theme: 'dark' }, version: 25 }, null, 2);
    const { storage, values } = memoryStorage({ settings: raw });
    const secured = createSecretStorage(storage, 'settings', store);
    const initial = [secured.getItem('settings'), secured.getItem('settings'), secured.getItem('settings')];
    await vi.waitFor(() => expect(backend.get).toHaveBeenCalledOnce());
    const unrelated = secured.setItem('settings', JSON.stringify({ state: { theme: 'light' }, version: 25 }));
    gate.reject({ state: 'locked', code: 'access-denied' });
    const hydrated = await Promise.all(initial);
    await unrelated;
    expect(new Set(hydrated).size).toBe(1);
    expect(hydrated[0]).not.toContain('LEGACY_RECOVERABLE');
    expect(values.get('settings')).toBe(raw);
    expect(backend.get).toHaveBeenCalledOnce();
    expect(backend.set).not.toHaveBeenCalled();
    expect(backend.has).not.toHaveBeenCalled();
    const recovered = await secured.getItem('settings');
    expect(recovered).toBe(values.get('settings'));
    expect(recovered).not.toContain('LEGACY_RECOVERABLE');
    expect(backend.set).toHaveBeenCalledOnce();
    await secured.setItem('settings', recovered!.replace('"dark"', '"light"'));
    expect(values.get('settings')).toContain('"light"');
  });
  it('does not misreport or destroy a missing existing reference', async () => {
    const { backend, store } = memoryBackend();
    const raw = JSON.stringify({ state: { apiKey: secretToken(ref), theme: 'dark' } });
    const { storage, values } = memoryStorage({ settings: raw });
    const secured = createSecretStorage(storage, 'settings', store);
    await secured.getItem('settings');
    expect(credentialState(ref)).toBe('missing');
    await secured.setItem('settings', raw.replace('"dark"', '"light"'));
    expect(values.get('settings')).toContain(secretToken(ref));
    expect(backend.has).toHaveBeenCalledOnce();
    expect(backend.get).not.toHaveBeenCalled();
    expect(backend.delete).not.toHaveBeenCalled();
  });
});
