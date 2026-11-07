import { secretRefFromToken, secretStore, secretToken, type SecretStore } from './secretStore';

export interface SecretResponseRedactor {
  redact(value: string): string;
  chunk(value: string): string;
  finish(): string;
}
/** Request-scoped only: upstream echoes cannot leak resolved browser credentials into jobs/logs. */
export async function createSecretResponseRedactor(request: unknown, store: SecretStore = secretStore): Promise<SecretResponseRedactor> {
  const tokens = new Set<string>();
  function visit(value: unknown): void {
    if (typeof value === 'string') for (const match of value.matchAll(/__SC_SECRET_[A-Za-z0-9_-]+?__/g)) tokens.add(match[0]);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  }
  visit(request);
  const replacements = new Map<string, string>();
  for (const token of tokens) {
    const ref = secretRefFromToken(token);
    if (!ref) continue;
    const value = await store.get(ref);
    if (!value) continue;
    for (const variant of [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]) replacements.set(variant, secretToken(ref));
  }
  const entries = [...replacements].sort(([left], [right]) => right.length - left.length);
  const pattern = entries.length ? new RegExp(entries.map(([secret]) => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : null;
  const redact = (value: string) => pattern ? value.replace(pattern, (secret) => replacements.get(secret)!) : value;
  let buffer = '';
  return {
    redact,
    chunk(value) {
      buffer += value;
      let safe = ''; let cursor = 0;
      while (cursor < buffer.length) {
        const complete = entries.find(([secret]) => buffer.startsWith(secret, cursor));
        if (complete) { safe += complete[1]; cursor += complete[0].length; continue; }
        const remaining = buffer.slice(cursor);
        if (entries.some(([secret]) => secret.startsWith(remaining))) break;
        safe += buffer[cursor]; cursor++;
      }
      buffer = buffer.slice(cursor); return safe;
    },
    finish() { const safe = redact(buffer); buffer = ''; return safe; },
  };
}
