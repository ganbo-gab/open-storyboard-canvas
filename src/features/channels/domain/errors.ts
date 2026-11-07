import type { ChannelError, ChannelErrorCategory } from '../runtime/types';
import { credentialFailureOf, CREDENTIAL_ACCESS_MESSAGE } from '@/features/secrets/credentialFailure';

const moderationPattern = /content[_ -]?(policy|filter|safety)|safety[_ -]?(filter|system|violation)|moderation|nsfw|responsible[_ -]?ai|色情|违规|内容审核|安全策略|敏感内容/i;
/** Status and upstream text are preserved separately from the Chinese explanation. */
export function normalizeChannelError(status: number | undefined, upstreamMessage = '', url?: string): ChannelError {
  let category: ChannelErrorCategory = 'upstream';
  let message = '上游请求失败';
  let retryable = false;
  if (moderationPattern.test(upstreamMessage)) { category = 'moderation'; message = '输入或输出未通过内容审核'; }
  else if (status === 401 || status === 403) { category = 'auth'; message = 'Key 无效或无权限'; }
  else if (status === 402) { category = 'balance'; message = '余额不足'; }
  else if (status === 404) { category = 'not_found'; message = `接口路径或模型名不存在${url ? `：${url}` : ''}`; }
  else if (status === 413) { category = 'too_large'; message = '参考素材超出上游限制'; }
  else if (status === 429) { category = 'rate_limit'; message = '并发或额度限制'; retryable = true; }
  else if (status !== undefined && status >= 500) { message = '上游服务错误'; retryable = true; }
  return { category, message, retryable, ...(status === undefined ? {} : { status }), ...(upstreamMessage ? { upstreamMessage } : {}) };
}
/** Only explicit pre-send evidence permits a retry; unknown transport failures are ambiguous. */
export function classifyTransportError(error: unknown): { beforeSend: boolean; error: ChannelError } {
  if (credentialFailureOf(error)) return { beforeSend: true, error: { category: 'credential', message: CREDENTIAL_ACCESS_MESSAGE, retryable: false } };
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : String(record.message ?? '网络连接异常');
  const code = String(record.code ?? '').toUpperCase();
  const beforeSend = record.sent === false || record.requestSent === false || record.phase === 'connect' || ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'DNS_ERROR'].includes(code) || /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|dns (?:lookup|resolution) failed|connection refused|连接被拒绝|域名解析失败/i.test(message);
  const timeout = /timeout|timed out|超时/i.test(`${code} ${message}`);
  return { beforeSend, error: { category: timeout ? 'timeout' : 'network', message: beforeSend ? '连接失败，请检查网络或渠道地址' : '提交结果未知，上游可能已接受请求；为避免重复计费未自动重试', upstreamMessage: message, retryable: beforeSend } };
}

const MAX_ERROR_TEXT = 2000;
/** Preserve provider wording, replacing secrets before truncation or persistence. */
export function redactChannelErrorText(text: string, credential = ''): string {
  const known = credential ? text.split(credential).join('[redacted]').split(encodeURIComponent(credential)).join('[redacted]') : text;
  return known
    .replace(/(Bearer\s+)[^\s,"'}]+/gi, '$1[redacted]')
    .replace(/(["']?(?:api[-_]?key|authorization|access[-_]?token|token|secret|password|cookie)["']?\s*[:=]\s*["']?)[^\s,"'}&]+/gi, '$1[redacted]')
    .replace(/data:[^,\s]+,[A-Za-z0-9+/_=-]+/gi, '[media omitted]')
    .slice(0, MAX_ERROR_TEXT);
}

export function safeChannelError(error: ChannelError, credential = ''): ChannelError {
  return { ...error, message: redactChannelErrorText(error.message, credential),
    ...(error.upstreamMessage === undefined ? {} : { upstreamMessage: redactChannelErrorText(error.upstreamMessage, credential) }) };
}

export function formatChannelError(error: ChannelError): string {
  return [error.message, error.status === undefined ? '' : `HTTP ${error.status}`, error.upstreamMessage ?? ''].filter(Boolean).join('\n').slice(0, MAX_ERROR_TEXT);
}

export class ChannelRequestFailure extends Error {
  readonly category: ChannelErrorCategory;
  readonly status?: number;
  readonly upstreamMessage?: string;
  readonly retryable: boolean;
  constructor(error: ChannelError, credential = '') {
    const safe = safeChannelError(error, credential);
    super(formatChannelError(safe));
    this.name = 'ChannelRequestFailure'; this.category = safe.category; this.status = safe.status;
    this.upstreamMessage = safe.upstreamMessage; this.retryable = safe.retryable;
  }
}
