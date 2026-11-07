import { z } from 'zod';

const text = z.string().trim().min(1);
const dimension = z.number().finite().int().positive();
const duration = z.number().finite().positive();
const record = z.record(z.string(), z.unknown());
export const assetMetadataSchema = z.object({
  width: dimension.optional(),
  height: dimension.optional(),
  resolution: text.optional(),
  aspectRatio: text.optional(),
  model: text.optional(),
  jobId: text.optional(),
  durationSeconds: duration.optional(),
}).passthrough();
export type AssetMetadata = z.infer<typeof assetMetadataSchema>;

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const parsed = text.safeParse(value);
    if (parsed.success) return parsed.data;
  }
}

function firstDuration(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = duration.safeParse(value);
    if (parsed.success) return parsed.data;
  }
}

/** Preserve legacy provenance; normalize declared facts without inventing pixel dimensions. */
export function normalizeAssetMetadata(value: unknown): AssetMetadata {
  const supplied = record.parse(value);
  const stored = record.safeParse(supplied.assetMetadata);
  const metadata = { ...(stored.success ? stored.data : {}), ...supplied };
  delete metadata.assetMetadata;
  const config = record.safeParse(metadata.config);
  const modelConfig = record.safeParse(metadata.modelConfig);
  const params = record.safeParse(config.success ? config.data.extraParams : undefined);
  const modelParams = record.safeParse(modelConfig.success ? modelConfig.data.extraParams : undefined);
  const outputParams = record.safeParse(params.success ? params.data.output : undefined);
  const output = { ...metadata };
  delete output.generationDebugContext;
  for (const key of ['width', 'height'] as const) {
    const parsed = dimension.safeParse(metadata[key]);
    if (parsed.success) output[key] = parsed.data;
    else delete output[key];
  }
  const fields = {
    resolution: firstText(metadata.resolution, params.success ? params.data.resolution : undefined,
      params.success ? params.data.resolutionType : undefined, params.success ? params.data.size : undefined,
      outputParams.success ? outputParams.data.resolution : undefined, config.success ? config.data.size : undefined,
      modelConfig.success ? modelConfig.data.resolution : undefined,
      modelParams.success ? modelParams.data.resolutionType : undefined, metadata.size),
    aspectRatio: firstText(metadata.aspectRatio, metadata.aspect_ratio,
      params.success ? params.data.aspect_ratio ?? params.data.aspectRatio : undefined, params.success ? params.data.ratio : undefined,
      config.success ? config.data.aspectRatio : undefined, modelConfig.success ? modelConfig.data.aspectRatio ?? modelConfig.data.ratio : undefined),
    model: firstText(metadata.model, metadata.sourceModelId, modelConfig.success ? modelConfig.data.entryId : undefined),
    jobId: firstText(metadata.jobId, metadata.generationLastJobId, metadata.generationJobId),
  };
  for (const key of ['resolution', 'aspectRatio', 'model', 'jobId'] as const) {
    if (fields[key] !== undefined) output[key] = fields[key];
    else delete output[key];
  }
  const seconds = firstDuration(metadata.durationSeconds, params.success ? params.data.duration : undefined,
    outputParams.success ? outputParams.data.duration : undefined, config.success ? config.data.seconds : undefined);
  if (seconds !== undefined) output.durationSeconds = seconds;
  else delete output.durationSeconds;
  return assetMetadataSchema.parse(output);
}
