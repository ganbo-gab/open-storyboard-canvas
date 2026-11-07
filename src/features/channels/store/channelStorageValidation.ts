import type { StateStorage } from 'zustand/middleware';
import { z } from 'zod';

// Validate the durable container before Zustand can treat an unsupported version
// as empty defaults. Parse only structural fields here: older declarations and
// unknown extension fields must remain byte-for-byte available to their owners.
const storedChannelSchema = z.looseObject({
  profile: z.looseObject({
    version: z.literal(2), id: z.string().min(1), name: z.string(), baseUrl: z.string(),
    auth: z.looseObject({ type: z.enum(['none', 'bearer', 'header', 'query']) }),
    operations: z.record(z.string(), z.unknown()),
    models: z.array(z.looseObject({ id: z.string(), operations: z.array(z.string()), params: z.array(z.unknown()) })),
  }),
  origin: z.enum(['native', 'legacy']),
  migrationIssues: z.array(z.looseObject({ key: z.string(), reason: z.string() })),
  createdAt: z.number(), updatedAt: z.number(),
});
const channelEnvelopeSchema = z.looseObject({
  version: z.literal(2).optional(),
  state: z.looseObject({ channels: z.array(storedChannelSchema), migratedLegacyIds: z.array(z.string()).optional() }),
});
const credentialEnvelopeSchema = z.looseObject({
  version: z.literal(1).optional(),
  state: z.looseObject({ credentials: z.record(z.string(), z.string()) }),
});

/** Invalid/future channel data stays recoverable even if an unrelated writer fires. */
export function createChannelStorageBoundary(storage: StateStorage, protectedStorage: StateStorage): StateStorage {
  const blocked = new Set<string>();
  const validate = (name: string, raw: string): void => {
    const schema = name === 'channels-v2-storage' ? channelEnvelopeSchema
      : name === 'channel-credentials-storage' ? credentialEnvelopeSchema : undefined;
    if (!schema) return;
    let input: unknown;
    try { input = JSON.parse(raw); }
    catch { throw new Error('已保存的渠道配置无法读取，原始配置已保留。'); }
    if (!schema.safeParse(input).success) throw new Error('已保存的渠道配置格式或版本不受支持，原始配置已保留。');
  };
  return {
    async getItem(name) {
      try {
        const raw = await storage.getItem(name);
        if (raw !== null) validate(name, raw);
        blocked.delete(name);
        return raw === null ? null : await protectedStorage.getItem(name);
      } catch (error) {
        blocked.add(name);
        throw error;
      }
    },
    async setItem(name, raw) {
      if (blocked.has(name)) return;
      let preserved = raw;
      try {
        const previous = await storage.getItem(name);
        if (previous !== null) validate(name, previous);
        validate(name, raw);
        if (previous !== null && (name === 'channels-v2-storage' || name === 'channel-credentials-storage')) {
          const envelope = z.record(z.string(), z.unknown());
          preserved = JSON.stringify({ ...envelope.parse(JSON.parse(previous)), ...envelope.parse(JSON.parse(raw)) });
        }
      } catch {
        blocked.add(name);
        return;
      }
      await protectedStorage.setItem(name, preserved);
    },
    async removeItem(name) {
      if (!blocked.has(name)) await protectedStorage.removeItem(name);
    },
  };
}
