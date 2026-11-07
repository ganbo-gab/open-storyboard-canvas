import { z } from 'zod';
import type { GenerationJobStatus } from '@/commands/ai';

const jobSchema = z.object({
  job_id: z.string().min(1),
  status: z.enum(['queued', 'submitting', 'running', 'recoverable_wait', 'materializing', 'succeeded', 'failed', 'not_found', 'unknown', 'canceled']),
  result: z.string().nullable().optional(),
  results: z.array(z.object({ kind: z.enum(['image', 'video', 'audio', 'model', 'text']), source: z.string(), importedModelId: z.string().optional() })).optional(),
  error: z.string().nullable().optional(), warning: z.string().nullable().optional(),
  media_type: z.enum(['image', 'video', 'audio', 'model', 'unknown']).optional(),
  provider_id: z.string().optional(), model_id: z.string().nullable().optional(),
  config_fingerprint: z.string().nullable().optional(), phase: z.string().optional(),
  external_task_id: z.string().nullable().optional(), poll_descriptor: z.record(z.string(), z.unknown()).nullable().optional(),
  result_url: z.string().nullable().optional(), error_category: z.string().nullable().optional(),
  network_route: z.enum(['system', 'direct', 'custom-proxy']).optional(), resumable: z.boolean().optional(),
  error_status: z.number().optional(), error_raw: z.string().optional(),
  submit_attempts: z.number().optional(), consecutive_network_errors: z.number().optional(),
  last_poll_at: z.number().nullable().optional(), created_at: z.number().optional(), updated_at: z.number().optional(),
});
const envelopeSchema = z.record(z.string(), z.unknown());

/** Preserve unrecognized rows byte-for-value when saving another job. Invalid
 * top-level storage fails closed rather than replacing the user's history.
 */
export function readBrowserJobRecords(key: string): Record<string, unknown> {
  const raw = localStorage.getItem(key);
  return raw === null ? {} : envelopeSchema.parse(JSON.parse(raw));
}
export function readBrowserJobRecord(records: Record<string, unknown>, id: string): GenerationJobStatus | undefined {
  if (!Object.hasOwn(records, id)) return undefined;
  const job = jobSchema.parse(records[id]);
  if (job.job_id !== id) throw new Error('任务记录编号与存储索引不一致；原记录已保留');
  return job;
}
