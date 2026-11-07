import { describe, expect, it } from 'vitest';
import { createSecretStore, secretToken, type SecretRef } from './secretStore';
import { createSecretResponseRedactor } from './transportSecrets';

const ref: SecretRef = { namespace: 'channel', id: 'redactor-fixture' };
function storeWith(value: string) {
  return createSecretStore({ get: async () => value, has: async () => true, set: async () => undefined, delete: async () => undefined });
}
describe('request-scoped credential echo redaction', () => {
  it('re-tokenizes raw, URL and JSON escaped values without persisting key material', async () => {
    const value = 'private +&"\\key'; const token = secretToken(ref);
    const redactor = await createSecretResponseRedactor({ headers: { Authorization: `Bearer ${token}` } }, storeWith(value));
    expect(redactor.redact(`echo ${value}`)).toBe(`echo ${token}`);
    expect(redactor.redact(`https://api.test/?key=${encodeURIComponent(value)}`)).toBe(`https://api.test/?key=${token}`);
    expect(redactor.redact(JSON.stringify({ echo: value }))).toBe(JSON.stringify({ echo: token }));
  });
  it('never emits a credential split across stream chunks, including overlapping prefixes', async () => {
    const token = secretToken(ref);
    const redactor = await createSecretResponseRedactor(token, storeWith('abab'));
    expect(redactor.chunk('event: ready\n\ndata: ab')).toBe('event: ready\n\ndata: ');
    expect(redactor.chunk('ab\n\n')).toBe(`${token}\n\n`);
    expect(redactor.finish()).toBe('');
    const complete = await createSecretResponseRedactor(token, storeWith('abab'));
    expect(complete.chunk('abab')).toBe(token);
    expect(complete.finish()).toBe('');
  });
  it('does not rewrite ordinary unauthenticated responses', async () => {
    const redactor = await createSecretResponseRedactor({ headers: {} }, storeWith('unused-private-value'));
    expect(redactor.chunk('ordinary')).toBe('ordinary');
    expect(redactor.redact('{"ok":true}')).toBe('{"ok":true}');
    expect(redactor.finish()).toBe('');
  });
});
