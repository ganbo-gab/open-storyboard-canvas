import { describe, expect, it } from 'vitest';
import { secretNamespaces, secretToken } from '@/features/secrets/secretStore';
import { redactPortableCredentials } from './credentialRedaction';

const legacyFixture = {
  providers: [{
    apiKey: 'sentinel-provider-key',
    baseUrl: 'https://sentinel-user:sentinel-password@example.com/v1?api%5Fkey=sentinel-query-key&mode=portable',
    extraHeaders: { Authorization: 'Bearer sentinel-authorization', 'X-Access-Key': 'sentinel-access-key', Accept: 'application/json' },
    queryParams: { key: 'sentinel-generic-query-key', token: 'sentinel-query-token', vendor_key: 'sentinel-legacy-auth-query', version: 'v1' },
    extraParams: { comfyOrgKey: 'sentinel-comfy-key', workflow: '{"nested":{"password":"sentinel-workflow-password"}}',
      auth: { mode: 'query', name: 'vendor_key', value: 'sentinel-legacy-auth-value' } },
  }],
  settings: {
    imageHost: { password: 'sentinel-image-password', token: 'sentinel-image-token' },
    agentModels: [{ apiKey: 'sentinel-agent-key', maxOutputTokens: 4096 }],
    oldBackup: JSON.stringify({ providers: [{ apiKey: 'sentinel-encoded-key' }], nested: { session: 'sentinel-session' } }),
    request: { headers: [{ name: 'Authorization', value: 'sentinel-entry-header' }] },
    malformedBackup: '{"apiKey":"sentinel-malformed-backup"',
    rawRequest: 'Authorization: sentinel-raw-header\nAccept: application/json',
    formQuery: 'api_key=sentinel-form-key&mode=portable',
  },
  channels: [{
    auth: { type: 'query', name: 'vendor_auth', value: 'sentinel-auth-value' },
    operations: { chat: { path: '/v1/chat?vendor_auth=sentinel-custom-query&mode=portable', template: { password: 'sentinel-channel-template' } } },
    queryParams: { vendor_auth: 'sentinel-custom-map' },
    migrationIssues: [{ key: 'extraParams.accessToken', value: 'sentinel-migration-issue', reason: 'Unsupported' }],
  }],
};

describe('portable credential redaction', () => {
  it('redacts nested legacy and encoded JSON surfaces without mutating the source', () => {
    const before = JSON.stringify(legacyFixture);
    const output = redactPortableCredentials(legacyFixture);
    expect(JSON.stringify(output)).not.toContain('sentinel-');
    expect(JSON.stringify(legacyFixture)).toBe(before);
    expect(output.providers[0].extraHeaders).toEqual({ Accept: 'application/json' });
    expect(output.providers[0].queryParams).toEqual({ version: 'v1' });
    expect(output.settings.agentModels[0].maxOutputTokens).toBe(4096);
    expect(output.channels[0].auth).toEqual({ type: 'query', name: 'vendor_auth' });
    expect(output.channels[0].operations.chat.path).toBe('/v1/chat?vendor_auth=&mode=portable');
    expect(JSON.stringify(redactPortableCredentials(output))).toBe(JSON.stringify(output));
  });

  it.each(secretNamespaces)('preserves only refs and opaque interpolation tokens for %s', (namespace) => {
    const ref = { namespace, id: 'fixture:模型' };
    const token = secretToken(ref);
    const fixture = { credentialRef: ref, credentialRefs: { model: ref }, apiKey: token,
      header: `Bearer ${token}`, url: `https://example.com?api_key=${token}`, max_tokens: 2048 };
    expect(redactPortableCredentials(fixture)).toEqual(fixture);
  });

  it('rejects secret-looking objects/tokens masquerading as references', () => {
    const source = { namespace: 'provider', id: 'fixture', value: 'sentinel-hidden-value' };
    const encoded = btoa(JSON.stringify(source)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const output = redactPortableCredentials({ credentialRef: source, passwordRef: 'sentinel-fake-ref',
      apiKey: `__SC_SECRET_${encoded}__`, authorization: 'Bearer __SC_SECRET_sentinel_invalid__' });
    expect(output).toEqual({});
  });

  it('preserves legacy auth mode/name declarations but never their credential values', () => {
    expect(redactPortableCredentials({ auth: { mode: 'query', name: 'vendor_key', value: 'sentinel-auth-key' },
      queryParams: { vendor_key: 'sentinel-query-key', format: 'json' } })).toEqual({
      auth: { mode: 'query', name: 'vendor_key' }, queryParams: { format: 'json' },
    });
  });
});
