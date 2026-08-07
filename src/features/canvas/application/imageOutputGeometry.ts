export type ImageResolutionTier = '1k' | '2k' | '4k';

export interface ImageOutputLimits {
  maxPixels?: number;
  maxWidth?: number;
  maxHeight?: number;
  alignment?: number;
}

export type ImageOutputGeometrySource =
  | 'ratio-mapping'
  | 'explicit-pixel-size'
  | 'provider-supported-size'
  | 'tier-derived'
  | 'automatic'
  | 'fallback';

export type ImageOutputConstraint = 'maxPixels' | 'maxWidth' | 'maxHeight';

export interface ImageOutputViolation {
  constraint: ImageOutputConstraint;
  actual: number;
  limit: number;
}

export interface ImageOutputGeometryDiagnostic {
  kind: 'image-output-geometry';
  status: 'valid' | 'adjusted' | 'invalid' | 'unverified';
  code:
    | 'valid'
    | 'inferred-scaled-to-limits'
    | 'explicit-size-exceeds-limits'
    | 'constraints-unsatisfiable'
    | 'explicit-size-not-pixel'
    | 'automatic-size';
  source: ImageOutputGeometrySource;
  requestedSize: string;
  requestedAspectRatio: string;
  requestedTier: ImageResolutionTier | null;
  resolvedSize: string;
  width: number | null;
  height: number | null;
  pixels: number | null;
  targetPixels: number | null;
  limits: ImageOutputLimits;
  violations: ImageOutputViolation[];
  suggestedActions: Array<
    'reduce-output-size'
    | 'choose-supported-size'
    | 'review-provider-limits'
    | 'review-provider-contract'
  >;
}

export interface ResolvedImageOutputGeometry {
  ok: true;
  size: string;
  width: number | null;
  height: number | null;
  source: ImageOutputGeometrySource;
  diagnostic: ImageOutputGeometryDiagnostic;
}

export interface InvalidImageOutputGeometry {
  ok: false;
  error: string;
  diagnostic: ImageOutputGeometryDiagnostic;
}

export type ImageOutputGeometryResult =
  | ResolvedImageOutputGeometry
  | InvalidImageOutputGeometry;

export interface ResolveImageOutputGeometryInput {
  aspectRatio?: unknown;
  selectedSize?: unknown;
  mappedSize?: unknown;
  supportedPixelSizes?: readonly unknown[];
  limits?: unknown;
  defaultTier?: ImageResolutionTier;
}

export const MODERN_OPENAI_IMAGE_OUTPUT_LIMITS: Readonly<ImageOutputLimits> = {
  maxPixels: 8_294_400,
  alignment: 8,
};

export const IMAGE_RESOLUTION_TIER_TARGET_PIXELS: Readonly<Record<ImageResolutionTier, number>> = {
  '1k': 1024 * 1024,
  '2k': 2048 * 2048,
  '4k': 3840 * 2160,
};

const PIXEL_SIZE_PATTERN = /^(\d{1,6})\s*[xX\u00d7]\s*(\d{1,6})$/;
const RATIO_PATTERN = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.floor(parsed)) : undefined;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function normalizeImageOutputLimits(
  value: unknown,
  defaults: ImageOutputLimits = {},
): ImageOutputLimits {
  const record = plainRecord(value);
  const normalized: ImageOutputLimits = { ...defaults };
  if (!record) return normalized;
  const maxPixels = positiveInteger(record.maxPixels);
  const maxWidth = positiveInteger(record.maxWidth);
  const maxHeight = positiveInteger(record.maxHeight);
  const alignment = positiveInteger(record.alignment);
  if (maxPixels !== undefined) normalized.maxPixels = maxPixels;
  if (maxWidth !== undefined) normalized.maxWidth = maxWidth;
  if (maxHeight !== undefined) normalized.maxHeight = maxHeight;
  if (alignment !== undefined) normalized.alignment = alignment;
  return normalized;
}

export function parseImagePixelSize(value: unknown): { width: number; height: number; size: string } | null {
  const match = PIXEL_SIZE_PATTERN.exec(text(value));
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height, size: `${width}x${height}` };
}

export function parseImageAspectRatio(value: unknown): number | null {
  const normalized = text(value);
  if (!normalized || normalized.toLowerCase() === 'auto') return null;
  const ratioMatch = RATIO_PATTERN.exec(normalized);
  if (ratioMatch) {
    const width = Number(ratioMatch[1]);
    const height = Number(ratioMatch[2]);
    return width > 0 && height > 0 ? width / height : null;
  }
  const pixelSize = parseImagePixelSize(normalized);
  return pixelSize ? pixelSize.width / pixelSize.height : null;
}

export function normalizeImageResolutionTier(value: unknown): ImageResolutionTier | 'auto' | null {
  const normalized = text(value).toLowerCase();
  if (!normalized) return null;
  if (normalized === 'auto' || normalized === '\u667a\u80fd' || normalized === '\u81ea\u52a8') return 'auto';
  if (/^(0\.5k|512|512px|1k|1024|1024p)$/.test(normalized)) return '1k';
  if (/^(2k|2048|1080p|1440p)$/.test(normalized)) return '2k';
  if (/^(4k|4096|2160p|uhd)$/.test(normalized)) return '4k';
  return null;
}

function collectViolations(
  width: number,
  height: number,
  limits: ImageOutputLimits,
): ImageOutputViolation[] {
  const violations: ImageOutputViolation[] = [];
  const pixels = width * height;
  if (limits.maxPixels !== undefined && pixels > limits.maxPixels) {
    violations.push({ constraint: 'maxPixels', actual: pixels, limit: limits.maxPixels });
  }
  if (limits.maxWidth !== undefined && width > limits.maxWidth) {
    violations.push({ constraint: 'maxWidth', actual: width, limit: limits.maxWidth });
  }
  if (limits.maxHeight !== undefined && height > limits.maxHeight) {
    violations.push({ constraint: 'maxHeight', actual: height, limit: limits.maxHeight });
  }
  return violations;
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function explicitLimitError(
  size: string,
  width: number,
  height: number,
  violations: ImageOutputViolation[],
): string {
  const details = violations.map((violation) => {
    if (violation.constraint === 'maxPixels') {
      return `${formatNumber(width * height)} \u50cf\u7d20 > ${formatNumber(violation.limit)} \u50cf\u7d20`;
    }
    return `${violation.constraint === 'maxWidth' ? '\u5bbd\u5ea6' : '\u9ad8\u5ea6'} ${formatNumber(violation.actual)} > ${formatNumber(violation.limit)}`;
  }).join('\uff0c');
  return `\u56fe\u7247\u8f93\u51fa\u5c3a\u5bf8 ${size}\uff08${formatNumber(width * height)} \u50cf\u7d20\uff09\u8d85\u8fc7\u670d\u52a1\u5546\u9650\u5236\uff1a${details}\u3002\u8bf7\u964d\u4f4e\u5206\u8fa8\u7387\u6216\u9009\u62e9\u66f4\u5c0f\u7684\u50cf\u7d20\u5c3a\u5bf8\uff1b\u5982\u679c\u670d\u52a1\u5546\u5df2\u653e\u5bbd\u9650\u5236\uff0c\u8bf7\u5728\u670d\u52a1\u5546\u914d\u7f6e imageOutputLimits \u4e2d\u6838\u5bf9\u771f\u5b9e\u4e0a\u9650\u3002`;
}

function diagnosticForPixelSize(input: {
  requestedSize: string;
  requestedAspectRatio: string;
  requestedTier: ImageResolutionTier | null;
  resolved: { width: number; height: number; size: string };
  source: ImageOutputGeometrySource;
  limits: ImageOutputLimits;
  targetPixels?: number | null;
  adjusted?: boolean;
}): ImageOutputGeometryDiagnostic {
  const violations = collectViolations(input.resolved.width, input.resolved.height, input.limits);
  const invalid = violations.length > 0;
  const inferred = input.source === 'tier-derived' || input.source === 'fallback';
  return {
    kind: 'image-output-geometry',
    status: invalid ? 'invalid' : input.adjusted ? 'adjusted' : 'valid',
    code: invalid
      ? inferred ? 'constraints-unsatisfiable' : 'explicit-size-exceeds-limits'
      : input.adjusted
        ? 'inferred-scaled-to-limits'
        : 'valid',
    source: input.source,
    requestedSize: input.requestedSize,
    requestedAspectRatio: input.requestedAspectRatio,
    requestedTier: input.requestedTier,
    resolvedSize: input.resolved.size,
    width: input.resolved.width,
    height: input.resolved.height,
    pixels: input.resolved.width * input.resolved.height,
    targetPixels: input.targetPixels ?? null,
    limits: input.limits,
    violations,
    suggestedActions: invalid
      ? inferred
        ? ['review-provider-limits']
        : ['reduce-output-size', 'choose-supported-size', 'review-provider-limits']
      : [],
  };
}

function resolveExplicitSize(input: {
  value: unknown;
  source: 'ratio-mapping' | 'explicit-pixel-size';
  aspectRatio: string;
  limits: ImageOutputLimits;
}): ImageOutputGeometryResult | null {
  const requestedSize = text(input.value);
  if (!requestedSize) return null;
  const parsed = parseImagePixelSize(requestedSize);
  if (!parsed) {
    if (input.source !== 'ratio-mapping') return null;
    return {
      ok: true,
      size: requestedSize,
      width: null,
      height: null,
      source: input.source,
      diagnostic: {
        kind: 'image-output-geometry',
        status: 'unverified',
        code: 'explicit-size-not-pixel',
        source: input.source,
        requestedSize,
        requestedAspectRatio: input.aspectRatio,
        requestedTier: normalizeImageResolutionTier(requestedSize) === 'auto'
          ? null
          : normalizeImageResolutionTier(requestedSize) as ImageResolutionTier | null,
        resolvedSize: requestedSize,
        width: null,
        height: null,
        pixels: null,
        targetPixels: null,
        limits: input.limits,
        violations: [],
        suggestedActions: ['review-provider-contract'],
      },
    };
  }
  const diagnostic = diagnosticForPixelSize({
    requestedSize,
    requestedAspectRatio: input.aspectRatio,
    requestedTier: null,
    resolved: parsed,
    source: input.source,
    limits: input.limits,
  });
  if (diagnostic.status === 'invalid') {
    return {
      ok: false,
      error: explicitLimitError(parsed.size, parsed.width, parsed.height, diagnostic.violations),
      diagnostic,
    };
  }
  return {
    ok: true,
    size: parsed.size,
    width: parsed.width,
    height: parsed.height,
    source: input.source,
    diagnostic,
  };
}

function closestSupportedPixelSize(
  values: readonly unknown[] | undefined,
  aspectRatio: number,
  targetPixels: number | null,
): { width: number; height: number; size: string } | null {
  const candidates = (values ?? [])
    .map(parseImagePixelSize)
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
  candidates.sort((left, right) => {
    const leftRatioDistance = Math.abs(Math.log((left.width / left.height) / aspectRatio));
    const rightRatioDistance = Math.abs(Math.log((right.width / right.height) / aspectRatio));
    if (Math.abs(leftRatioDistance - rightRatioDistance) > 1e-9) {
      return leftRatioDistance - rightRatioDistance;
    }
    if (targetPixels === null) return 0;
    const leftAreaDistance = Math.abs(Math.log((left.width * left.height) / targetPixels));
    const rightAreaDistance = Math.abs(Math.log((right.width * right.height) / targetPixels));
    return leftAreaDistance - rightAreaDistance;
  });
  return candidates[0] ?? null;
}

function deriveTierPixelSize(
  tier: ImageResolutionTier,
  aspectRatio: number,
  limits: ImageOutputLimits,
): { resolved: { width: number; height: number; size: string }; adjusted: boolean } {
  const targetPixels = IMAGE_RESOLUTION_TIER_TARGET_PIXELS[tier];
  const targetWidth = Math.sqrt(targetPixels * aspectRatio);
  const targetHeight = Math.sqrt(targetPixels / aspectRatio);
  const scale = Math.min(
    1,
    limits.maxPixels !== undefined ? Math.sqrt(limits.maxPixels / targetPixels) : 1,
    limits.maxWidth !== undefined ? limits.maxWidth / targetWidth : 1,
    limits.maxHeight !== undefined ? limits.maxHeight / targetHeight : 1,
  );
  const alignment = Math.max(1, Math.floor(limits.alignment ?? 1));
  const alignDown = (value: number) => Math.floor(value / alignment) * alignment;
  const scaledWidth = targetWidth * scale;
  const scaledHeight = targetHeight * scale;
  const candidates = [
    {
      height: alignDown(scaledHeight),
      width: alignDown(alignDown(scaledHeight) * aspectRatio),
    },
    {
      width: alignDown(scaledWidth),
      height: alignDown(alignDown(scaledWidth) / aspectRatio),
    },
    {
      width: alignDown(scaledWidth),
      height: alignDown(scaledHeight),
    },
  ].filter((candidate) =>
    candidate.width > 0
    && candidate.height > 0
    && collectViolations(candidate.width, candidate.height, limits).length === 0
  );
  candidates.sort((left, right) => {
    const leftRatioError = Math.abs(Math.log((left.width / left.height) / aspectRatio));
    const rightRatioError = Math.abs(Math.log((right.width / right.height) / aspectRatio));
    if (Math.abs(leftRatioError - rightRatioError) > 1e-9) {
      return leftRatioError - rightRatioError;
    }
    return right.width * right.height - left.width * left.height;
  });
  const best = candidates[0] ?? { width: alignment, height: alignment };

  return {
    resolved: { width: best.width, height: best.height, size: `${best.width}x${best.height}` },
    adjusted: scale < 1 - 1e-9,
  };
}

export function resolveImageOutputGeometry(
  input: ResolveImageOutputGeometryInput,
): ImageOutputGeometryResult {
  const aspectRatioLabel = text(input.aspectRatio) || '1:1';
  const aspectRatio = parseImageAspectRatio(aspectRatioLabel) ?? 1;
  const limits = normalizeImageOutputLimits(input.limits);
  const mapped = resolveExplicitSize({
    value: input.mappedSize,
    source: 'ratio-mapping',
    aspectRatio: aspectRatioLabel,
    limits,
  });
  if (mapped) return mapped;

  const explicit = resolveExplicitSize({
    value: input.selectedSize,
    source: 'explicit-pixel-size',
    aspectRatio: aspectRatioLabel,
    limits,
  });
  if (explicit) return explicit;

  const selectedSize = text(input.selectedSize);
  const normalizedTier = normalizeImageResolutionTier(selectedSize);
  if (normalizedTier === 'auto') {
    return {
      ok: true,
      size: 'auto',
      width: null,
      height: null,
      source: 'automatic',
      diagnostic: {
        kind: 'image-output-geometry',
        status: 'unverified',
        code: 'automatic-size',
        source: 'automatic',
        requestedSize: selectedSize,
        requestedAspectRatio: aspectRatioLabel,
        requestedTier: null,
        resolvedSize: 'auto',
        width: null,
        height: null,
        pixels: null,
        targetPixels: null,
        limits,
        violations: [],
        suggestedActions: [],
      },
    };
  }

  const tier = normalizedTier ?? input.defaultTier ?? null;
  const targetPixels = tier ? IMAGE_RESOLUTION_TIER_TARGET_PIXELS[tier] : null;
  const supported = closestSupportedPixelSize(input.supportedPixelSizes, aspectRatio, targetPixels);
  if (supported) {
    const diagnostic = diagnosticForPixelSize({
      requestedSize: selectedSize,
      requestedAspectRatio: aspectRatioLabel,
      requestedTier: tier,
      resolved: supported,
      source: 'provider-supported-size',
      limits,
      targetPixels,
    });
    if (diagnostic.status === 'invalid') {
      return {
        ok: false,
        error: explicitLimitError(supported.size, supported.width, supported.height, diagnostic.violations),
        diagnostic,
      };
    }
    return {
      ok: true,
      size: supported.size,
      width: supported.width,
      height: supported.height,
      source: 'provider-supported-size',
      diagnostic,
    };
  }

  const resolvedTier = tier ?? '1k';
  const derived = deriveTierPixelSize(resolvedTier, aspectRatio, limits);
  const source: ImageOutputGeometrySource = tier ? 'tier-derived' : 'fallback';
  const diagnostic = diagnosticForPixelSize({
    requestedSize: selectedSize,
    requestedAspectRatio: aspectRatioLabel,
    requestedTier: tier,
    resolved: derived.resolved,
    source,
    limits,
    targetPixels: IMAGE_RESOLUTION_TIER_TARGET_PIXELS[resolvedTier],
    adjusted: derived.adjusted,
  });
  if (diagnostic.status === 'invalid') {
    return {
      ok: false,
      error: '\u65e0\u6cd5\u5728\u5f53\u524d imageOutputLimits \u4e0b\u6c42\u51fa\u540c\u65f6\u6ee1\u8db3\u753b\u5e45\u6bd4\u4f8b\u548c\u5bf9\u9f50\u8981\u6c42\u7684\u56fe\u7247\u5c3a\u5bf8\uff0c\u8bf7\u68c0\u67e5 maxWidth\u3001maxHeight \u548c alignment \u914d\u7f6e\u3002',
      diagnostic,
    };
  }
  return {
    ok: true,
    size: derived.resolved.size,
    width: derived.resolved.width,
    height: derived.resolved.height,
    source,
    diagnostic,
  };
}

export class ImageOutputGeometryError extends Error {
  constructor(
    message: string,
    readonly diagnostic: ImageOutputGeometryDiagnostic,
  ) {
    super(message);
    this.name = 'ImageOutputGeometryError';
  }
}

export function requireImageOutputGeometry(
  input: ResolveImageOutputGeometryInput,
): ResolvedImageOutputGeometry {
  const result = resolveImageOutputGeometry(input);
  if (!result.ok) throw new ImageOutputGeometryError(result.error, result.diagnostic);
  return result;
}
