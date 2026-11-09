import { z } from 'zod';

const text = z.string().trim().min(1);
const params = z.record(z.string(), z.unknown());
const configuration = z.object({
  entryId: text, ratio: z.string().optional(), aspectRatio: z.string().optional(),
  resolution: z.string().optional(), extraParams: params.optional(),
});
const nodeData = z.object({
  modelConfig: z.unknown().optional(), model: z.unknown().optional(), modelId: z.unknown().optional(),
  size: z.unknown().optional(), resolution: z.unknown().optional(), aspectRatio: z.unknown().optional(),
  requestAspectRatio: z.unknown().optional(), extraParams: z.unknown().optional(),
});

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) { const parsed = text.safeParse(value); if (parsed.success) return parsed.data; }
}

/** Actual pixel sizes determine display geometry without altering provider request fields. */
export function aspectRatioFromPixelSize(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i.exec(value.trim());
  if (!match) return undefined;
  const width = Number(match[1]); const height = Number(match[2]);
  if (!width || !height) return undefined;
  let a = width; let b = height;
  while (b) { const remainder = a % b; a = b; b = remainder; }
  return `${width / a}:${height / a}`;
}

export interface GenerationConfiguration {
  source: 'modelConfig' | 'legacy' | 'unconfigured';
  model?: string;
  size?: string;
  aspectRatio?: string;
  extraParams: Record<string, unknown>;
}

/** A persisted selection is authoritative as a whole; missing fields never inherit another model's defaults. */
export function readGenerationConfiguration(value: unknown): GenerationConfiguration {
  const parsed = nodeData.safeParse(value);
  if (!parsed.success) return { source: 'unconfigured', extraParams: {} };
  const data = parsed.data;
  const selected = configuration.safeParse(data.modelConfig);
  if (selected.success) {
    const config = selected.data;
    const extraParams = config.extraParams ?? {};
    const size = firstText(extraParams.size, extraParams.resolution, extraParams.resolutionType, extraParams.imageSize, extraParams.image_size, config.resolution);
    return { source: 'modelConfig', model: config.entryId, size,
      aspectRatio: aspectRatioFromPixelSize(size) ?? firstText(extraParams.aspectRatio, extraParams.aspect_ratio, extraParams.ratio, config.ratio, config.aspectRatio), extraParams };
  }
  // A malformed current selection is not permission to silently use a different legacy model.
  if (data.modelConfig !== undefined && data.modelConfig !== null) return { source: 'unconfigured', extraParams: {} };
  const legacyParams = params.safeParse(data.extraParams);
  const extraParams = legacyParams.success ? legacyParams.data : {};
  const model = firstText(data.modelId, data.model);
  const size = firstText(extraParams.size, extraParams.resolution, extraParams.resolutionType, data.resolution, data.size);
  return { source: model ? 'legacy' : 'unconfigured', model, size,
    aspectRatio: aspectRatioFromPixelSize(size) ?? firstText(extraParams.aspectRatio, extraParams.aspect_ratio, extraParams.ratio, data.requestAspectRatio, data.aspectRatio), extraParams };
}
