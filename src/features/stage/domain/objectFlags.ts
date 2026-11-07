import { z } from 'zod';

/** Missing flags in legacy documents mean visible and editable. */
export const stageObjectFlagsSchema = z.object({
  hidden: z.boolean().optional().catch(undefined),
  locked: z.boolean().optional().catch(undefined),
}).catch({});

/** Persistence is tolerant of old/malformed optional flags, never truthy strings. */
export function normalizeStageObjectFlags(value: unknown): { hidden?: boolean; locked?: boolean } {
  return stageObjectFlagsSchema.parse(value);
}
