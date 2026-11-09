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

/** Explain the local failure without claiming an upstream task exists or an OS dialog will appear. */
export function credentialFailureMessage(error: unknown): string {
  const failure = credentialFailureOf(error);
  switch (failure?.code) {
    case 'desktop-vault-required': return '请在桌面客户端中使用已保存的 API Key。';
    case 'credential_missing':
    case 'credential-missing': return '未找到已保存的 API Key，请到渠道设置重新填写并保存。';
    case 'verification_failed':
    case 'read-back-mismatch': return 'API Key 保存校验未通过，请到渠道设置重新填写并保存。';
    case 'invalid_ref':
    case 'invalid-reference':
    case 'invalid_url':
    case 'invalid_encoding':
    case 'ambiguous_entry':
    case 'invalid_credential_binding':
    case 'redaction_failed': return '凭据配置无法读取，请到渠道设置检查并重新保存 API Key。';
    default: return failure?.state === 'locked'
      ? '系统阻止了 API Key 读取。请重试读取凭据；若出现系统授权提示，请确认允许。'
      : '暂时无法读取已保存的 API Key，请重试读取凭据；若仍失败，请到渠道设置检查。';
  }
}

export function isTransientCredentialFailure(error: unknown): boolean {
  const failure = credentialFailureOf(error);
  return failure?.state === 'error' && ['storage_failed', 'storage_unavailable', 'vault-operation-failed'].includes(failure.code);
}
