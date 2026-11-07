import { z } from 'zod';
import { redactSensitiveUrl } from '@/features/canvas/application/imageProviderContracts';
import { isTauri } from '@tauri-apps/api/core';

export interface GenerationDebugContext {
  sourceType: 'imageEdit' | 'storyboardGen' | 'aiVideo' | 'aiText' | 'unknown';
  providerId?: string;
  requestModel?: string;
  requestSize?: string;
  requestAspectRatio?: string;
  channelModeId?: string;
  prompt?: string;
  extraParams?: Record<string, unknown>;
  referenceImageCount?: number;
  referenceImagePlaceholders?: string[];
  appVersion?: string;
  osName?: string;
  osVersion?: string;
  osBuild?: string;
  userAgent?: string;
}

export const CURRENT_RUNTIME_SESSION_ID = `runtime-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
let runtimeDiagnosticsPromise: Promise<Pick<
  GenerationDebugContext,
  'appVersion' | 'osName' | 'osVersion' | 'osBuild' | 'userAgent'
>> | null = null;

interface BuildGenerationErrorReportInput {
  errorMessage: string;
  errorDetails?: string;
  context?: unknown;
}

export type GenerationFailureCategory = 'input_moderation' | 'output_moderation' | 'error';
export interface GenerationFailureClassification {
  category: GenerationFailureCategory;
  /** Provider evidence for an explicit retry action only; never permission to resubmit automatically. */
  retryable: boolean;
  /** Includes moderation errors whose input/output direction is not known. */
  moderation: boolean;
}

const failureEvidenceSchema = z.object({
  failure_reason: z.unknown().optional(), failureReason: z.unknown().optional(),
  reason: z.unknown().optional(), code: z.unknown().optional(), category: z.unknown().optional(),
  retryable: z.unknown().optional(), moderation: z.unknown().optional(),
  message: z.unknown().optional(), upstreamMessage: z.unknown().optional(),
  error: z.unknown().optional(), details: z.unknown().optional(),
  data: z.unknown().optional(), response: z.unknown().optional(), cause: z.unknown().optional(),
});

function directedModeration(value: unknown): GenerationFailureCategory | null {
  if (typeof value !== 'string') return null;
  if (/\binput[_ -]moderation\b|\binput[_ -](?:image[_ -]|text[_ -])?(?:content[_ -])?(?:policy[_ -]violation|safety[_ -]violation)|输入(?:内容|图片|文本|提示词)?违规/i.test(value)) return 'input_moderation';
  if (/\boutput[_ -]moderation\b|\boutput[_ -](?:image[_ -]|text[_ -])?(?:content[_ -])?(?:policy[_ -]violation|safety[_ -]violation)|输出(?:内容|图片|文本)?违规/i.test(value)) return 'output_moderation';
  return null;
}

function inspectGenerationFailure(
  value: unknown,
  ancestors: WeakSet<object>,
  depth: number,
): GenerationFailureClassification {
  const unknownFailure: GenerationFailureClassification = { category: 'error', retryable: false, moderation: false };
  if (depth > 8) return unknownFailure;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(text);
        return inspectGenerationFailure(parsed, ancestors, depth + 1);
      } catch { /* Plain provider text may start with a bracket. */ }
    }
    const category = directedModeration(text);
    return {
      category: category ?? 'error', retryable: false,
      moderation: category !== null || /moderation|content[_ -](?:policy|filter|safety)|safety[_ -](?:filter|violation)|内容审核|安全策略|敏感内容|违规/i.test(text),
    };
  }
  if (!value || typeof value !== 'object' || ancestors.has(value)) return unknownFailure;
  ancestors.add(value);
  try {
    const parsed = failureEvidenceSchema.safeParse(value instanceof Error
      ? {
          ...value,
          message: value.message,
          cause: 'cause' in value && Object.prototype.hasOwnProperty.call(value, 'cause') ? value.cause : undefined,
        }
      : value);
    if (!parsed.success) return unknownFailure;
    const evidence = parsed.data;
    // Explicit provider codes win over prose; do not inspect prompt/config/credential fields.
    const markers = [evidence.failure_reason, evidence.failureReason, evidence.reason, evidence.code, evidence.category];
    for (const field of markers) {
      const category = directedModeration(field);
      if (category) return { category, retryable: false, moderation: true };
    }
    const nested = [
      ...markers,
      evidence.error, evidence.details, evidence.data, evidence.response, evidence.cause,
      evidence.upstreamMessage, evidence.message,
    ].map((child) => inspectGenerationFailure(child, ancestors, depth + 1));
    const directed = nested.find((failure) => failure.category !== 'error');
    if (directed) return directed;
    const moderation = evidence.moderation === true || evidence.category === 'moderation'
      || nested.some((failure) => failure.moderation);
    return {
      category: 'error', moderation,
      retryable: !moderation && (evidence.retryable === true || nested.some((failure) => failure.retryable)),
    };
  } finally {
    ancestors.delete(value);
  }
}

/** Normalizes provider/persisted failure evidence without guessing an input/output direction. */
export function classifyGenerationFailure(value: unknown): GenerationFailureClassification {
  return inspectGenerationFailure(value, new WeakSet<object>(), 0);
}

function toStringSafe(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isSensitiveDiagnosticFieldName(name: string): boolean {
  return /(?:authorization|proxy[-_ ]?authorization|cookie|set[-_ ]?cookie|(?:x[-_ ]?)?api[-_ ]?key|x[-_ ]?goog[-_ ]?api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|secret|signature|credential|password|bearer|(?:^|[-_ ])token(?:$|[-_ ]))/i.test(name);
}

/**
 * Provider failures and saved request context can contain credentials,
 * signed URLs, or inline media. Keep diagnostics readable without copying
 * those values into dialogs, reports, persisted node errors, or logs.
 */
export function sanitizeGenerationDiagnosticText(value: string): string {
  return value
    .replace(/data:[^;\s,]+(?:;[^,\s]+)*;base64,[A-Za-z0-9+/_=-]+/gi, '[data-url omitted]')
    .replace(/\b[A-Za-z0-9+/_-]{160,}={0,2}\b/g, '[base64 omitted]')
    .replace(/\b(Bearer|Basic|Token)\s+[^\s,;"'}]+/gi, '$1 [redacted]')
    .replace(
      /((?:["']?(?:authorization|proxy-authorization|cookie|set-cookie|(?:x-)?api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|secret(?:[-_ ]?key)?|signature|credential|password)["']?\s*[:=]\s*["']?))([^\s,"'}]+)(["']?)/gi,
      '$1[redacted]$3',
    )
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => redactSensitiveUrl(url));
}

function sanitizeGenerationDiagnosticValue(
  value: unknown,
  key = '',
  depth = 0,
  ancestors = new WeakSet<object>(),
): unknown {
  if (isSensitiveDiagnosticFieldName(key)) return '[redacted]';
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return sanitizeGenerationDiagnosticText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return sanitizeGenerationDiagnosticText(String(value));
  if (depth >= 8) return Array.isArray(value) ? `[array ${value.length}]` : '[object]';
  if (ancestors.has(value)) return '[circular]';

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        sanitizeGenerationDiagnosticValue(item, `${key}[${index}]`, depth + 1, ancestors));
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([entryKey]) => !['__proto__', 'prototype', 'constructor'].includes(entryKey))
        .map(([entryKey, entryValue]) => [
          entryKey,
          sanitizeGenerationDiagnosticValue(entryValue, entryKey, depth + 1, ancestors),
        ]),
    );
  } finally {
    ancestors.delete(value);
  }
}

export function createReferenceImagePlaceholders(count: number): string[] {
  const safeCount = Math.max(0, Math.min(64, Math.floor(count)));
  return Array.from({ length: safeCount }, (_, index) => `[IMAGE_${index + 1}]`);
}

function parseOsInfo(userAgent: string): { osName: string; osVersion: string } {
  const ua = userAgent || '';

  const windowsMatch = ua.match(/Windows NT ([0-9.]+)/i);
  if (windowsMatch) {
    const ntVersion = windowsMatch[1];
    if (ntVersion.startsWith('10.0')) {
      return { osName: 'Windows', osVersion: '10/11 (NT 10.0)' };
    }
    return { osName: 'Windows', osVersion: `NT ${ntVersion}` };
  }

  const macMatch = ua.match(/Mac OS X ([0-9_]+)/i);
  if (macMatch) {
    return { osName: 'macOS', osVersion: macMatch[1].replace(/_/g, '.') };
  }

  const linuxLike = /Linux|X11/i.test(ua);
  if (linuxLike) {
    return { osName: 'Linux', osVersion: 'unknown' };
  }

  return { osName: 'Unknown', osVersion: 'unknown' };
}

export async function getRuntimeDiagnostics(): Promise<
  Pick<GenerationDebugContext, 'appVersion' | 'osName' | 'osVersion' | 'osBuild' | 'userAgent'>
> {
  if (!runtimeDiagnosticsPromise) {
    runtimeDiagnosticsPromise = (async () => {
      const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
      const osInfo = parseOsInfo(userAgent);

      let appVersion = 'unknown';
      let resolvedOsName = osInfo.osName;
      let resolvedOsVersion = osInfo.osVersion;
      let resolvedOsBuild = 'unknown';
      if (isTauri()) {
        try {
          const { getVersion } = await import('@tauri-apps/api/app');
          appVersion = await getVersion();
        } catch {
          appVersion = 'unknown';
        }

        try {
          const { getRuntimeSystemInfo } = await import('@/commands/system');
          const systemInfo = await getRuntimeSystemInfo();
          if (systemInfo) {
            if (systemInfo.osName) {
              resolvedOsName = systemInfo.osName;
            }
            if (systemInfo.osVersion) {
              resolvedOsVersion = systemInfo.osVersion;
            }
            if (systemInfo.osBuild) {
              resolvedOsBuild = systemInfo.osBuild;
            }
          }
        } catch {
          // Fallback to user-agent parsed info.
        }
      }

      return {
        appVersion,
        osName: resolvedOsName,
        osVersion: resolvedOsVersion,
        osBuild: resolvedOsBuild,
        userAgent,
      };
    })();
  }

  return runtimeDiagnosticsPromise;
}

export function buildGenerationErrorReport(
  input: BuildGenerationErrorReportInput
): string {
  const context = (input.context ?? {}) as Partial<GenerationDebugContext>;
  const sections: string[] = [];
  sections.push('# Generation Error Report');
  sections.push('');
  sections.push(`- Error: ${sanitizeGenerationDiagnosticText(input.errorMessage || 'unknown error')}`);
  if (input.errorDetails) {
    sections.push(`- Details: ${sanitizeGenerationDiagnosticText(input.errorDetails)}`);
  }
  sections.push(`- App Version: ${sanitizeGenerationDiagnosticText(toStringSafe(context.appVersion ?? 'unknown'))}`);
  sections.push(`- OS: ${sanitizeGenerationDiagnosticText(`${context.osName ?? 'Unknown'} ${context.osVersion ?? 'unknown'}`.trim())}`);
  sections.push(`- OS Build: ${sanitizeGenerationDiagnosticText(toStringSafe(context.osBuild ?? 'unknown'))}`);
  sections.push('');
  sections.push('## Request Context');
  sections.push(`- Source: ${sanitizeGenerationDiagnosticText(toStringSafe(context.sourceType ?? 'unknown'))}`);
  if (context.providerId) {
    sections.push(`- Provider: ${sanitizeGenerationDiagnosticText(context.providerId)}`);
  }
  if (context.requestModel) {
    sections.push(`- Model: ${sanitizeGenerationDiagnosticText(context.requestModel)}`);
  }
  if (context.requestSize) {
    sections.push(`- Size: ${sanitizeGenerationDiagnosticText(context.requestSize)}`);
  }
  if (context.requestAspectRatio) {
    sections.push(`- Aspect Ratio: ${sanitizeGenerationDiagnosticText(context.requestAspectRatio)}`);
  }
  sections.push(`- Reference Images: ${context.referenceImageCount ?? 0}`);
  if (Array.isArray(context.referenceImagePlaceholders) && context.referenceImagePlaceholders.length > 0) {
    sections.push(`- Reference Image Placeholders: ${context.referenceImagePlaceholders.join(', ')}`);
  }
  sections.push('');
  sections.push('## Prompt');
  sections.push(
    context.prompt && context.prompt.trim()
      ? sanitizeGenerationDiagnosticText(context.prompt)
      : '(empty)',
  );
  sections.push('');
  sections.push('## Extra Params');
  const sanitizedExtraParams = sanitizeGenerationDiagnosticValue(context.extraParams);
  sections.push(
    sanitizedExtraParams
      && typeof sanitizedExtraParams === 'object'
      && Object.keys(sanitizedExtraParams).length > 0
      ? toStringSafe(sanitizedExtraParams)
      : '{}'
  );
  if (context.userAgent) {
    sections.push('');
    sections.push('## User Agent');
    sections.push(sanitizeGenerationDiagnosticText(context.userAgent));
  }

  return sections.join('\n');
}
