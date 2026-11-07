import { z } from 'zod';

const failureSchema = z.object({ state: z.enum(['locked', 'error']), code: z.string() });
const vaultCodes = ['storage_locked', 'storage_failed', 'storage_unavailable', 'credential_missing', 'access_denied', 'authorization_required',
  'invalid_ref', 'invalid_url', 'invalid_encoding', 'ambiguous_entry', 'invalid_credential_binding', 'redaction_failed', 'verification_failed',
  'vault-locked', 'vault-operation-failed', 'desktop-vault-required', 'credential-missing', 'invalid-reference', 'read-back-mismatch'] as const;

/** Native commands use a JSON error string; distinguish vault failures before applying network retry rules. */
export function credentialFailureOf(error: unknown): { state: 'locked' | 'error'; code: string } | null {
  const structured = failureSchema.safeParse(error);
  if (structured.success && vaultCodes.some((code) => code === structured.data.code)) return structured.data;
  let value: unknown = error instanceof Error ? error.message : error;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  const parsed = failureSchema.safeParse(value);
  return parsed.success && vaultCodes.some((code) => code === parsed.data.code) ? parsed.data : null;
}

export const CREDENTIAL_ACCESS_MESSAGE = '系统凭据尚未授权，已暂停请求。请重新授权后查询原任务；不会重新生成。';
