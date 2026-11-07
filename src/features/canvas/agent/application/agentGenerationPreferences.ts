import { z } from 'zod';
import { operationKinds } from '@/features/channels/domain/profile';

const modeSummarySchema = z.strictObject({
  id: z.string().min(1).max(300), label: z.string().max(500), operation: z.enum(operationKinds), description: z.string().max(4000).optional(),
  slots: z.array(z.strictObject({ key: z.string().min(1).max(100), label: z.string().max(500), kind: z.enum(['image', 'video', 'audio']),
    min: z.number().int().nonnegative(), max: z.number().int().nonnegative() })).max(100),
  params: z.array(z.strictObject({ key: z.string().min(1).max(100), label: z.string().max(500), type: z.enum(['enum', 'number', 'boolean', 'text']),
    required: z.boolean().optional(), values: z.array(z.json()).optional(), default: z.json().optional(),
    min: z.number().optional(), max: z.number().optional() })).max(100),
});
const targetSchema = z.strictObject({ modelId: z.string().min(1).max(1000), supportedRatios: z.array(z.string().max(100)).max(100).optional(),
  supportedResolutions: z.array(z.string().max(100)).max(100).optional(), modes: z.array(modeSummarySchema).max(100).optional() });
/** Persist only the selected declarations, never a channel or transport snapshot. */
export const agentGenerationPreferencesSchema = z.strictObject({ image: targetSchema.optional(),
  video: targetSchema.extend({ supportedDurations: z.array(z.string().max(100)).max(100).optional() }).optional() });
export type AgentGenerationPreferences = z.infer<typeof agentGenerationPreferencesSchema>;
