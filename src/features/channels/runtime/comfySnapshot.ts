import { z } from 'zod';
import type { JsonValue } from './types';

const json: z.ZodType<JsonValue> = z.lazy(() => z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(json), z.record(z.string(), json)]));
const binding = z.object({ nodeId: z.string().min(1), input: z.string().min(1) }).strict();
export const comfyAdapterSnapshotSchema = z.object({
  workflow: z.record(z.string(), z.record(z.string(), z.unknown())), bindings: z.record(z.string(), binding.nullable()),
  outputNodeIds: z.array(z.string()).optional(),
  urls: z.object({ base: z.string(), prompt: z.string(), history: z.string(), view: z.string(), ws: z.string(), objectInfo: z.string(), systemStats: z.string(), upload: z.string(),
    defaultedScheme: z.boolean(), strippedPath: z.string().nullable() }).strict(),
  auth: z.discriminatedUnion('mode', [z.object({ mode: z.literal('none') }).strict(), z.object({ mode: z.literal('bearer') }).strict(),
    z.object({ mode: z.literal('header'), name: z.string().min(1) }).strict(), z.object({ mode: z.literal('query'), name: z.string().min(1) }).strict()]),
  comfyOrgKeyRequired: z.boolean(), mediaKind: z.enum(['image', 'video', 'audio']),
}).strict();
const recoveryRouteSchema = z.object({
  providerId: z.string().min(1), baseUrl: z.string().url(), originalBaseUrl: z.string().url(), externalTaskId: z.string().min(1),
  auth: comfyAdapterSnapshotSchema.shape.auth, authPrefix: z.string(), headerNames: z.array(z.string()), queryNames: z.array(z.string()),
}).strict();
export const comfyExecutionSnapshotSchema = z.object({
  version: z.literal(2), adapter: z.literal('comfyui'),
  input: z.object({ jobId: z.string().min(1), channelId: z.string().min(1), modelId: z.string(),
    operation: z.enum(['image.generate', 'image.edit', 'video.generate']), prompt: z.literal(''),
    params: z.record(z.string(), json), refs: z.array(z.never()).max(0), count: z.number().int().positive() }).strict(),
  pollIntervalMs: z.number().finite().positive(), pollTimeoutMs: z.number().finite().positive(), authPrefix: z.string(),
  headerNames: z.array(z.string()), queryNames: z.array(z.string()),
  outputs: z.array(z.object({ kind: z.enum(['image', 'video']), url: z.string().url() }).strict()).optional(), assets: z.array(z.string()).optional(),
  recoveryRoute: recoveryRouteSchema.optional(),
}).strict();
export type ComfyRecoveryRoute = z.infer<typeof recoveryRouteSchema>;
