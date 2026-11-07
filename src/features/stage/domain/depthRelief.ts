import { z } from 'zod';

/** Width at the front image plane; depth is a relative relief span, not measured scene depth. */
export const depthReliefParametersSchema = z.object({
  widthM: z.number().finite().positive().max(1_000),
  depthM: z.number().finite().min(0).max(1_000),
  /** Vertical field of view of the source image's virtual camera. */
  fovDeg: z.number().finite().min(1).max(179),
  /** Horizontal grid subdivisions; vertical subdivisions preserve image aspect. */
  segments: z.number().int().min(1).max(512),
}).strict();

const durableImageSource = z.string().trim().min(1).refine(
  (value) => !/^(blob:|javascript:)/i.test(value),
  'Relief images must use durable asset references',
);

export const depthReliefSchema = depthReliefParametersSchema.extend({
  imageUrl: durableImageSource,
  depthUrl: durableImageSource,
}).strict();

export type DepthReliefParameters = z.infer<typeof depthReliefParametersSchema>;
export type DepthRelief = z.infer<typeof depthReliefSchema>;

export const DEFAULT_DEPTH_RELIEF_PARAMETERS: Readonly<DepthReliefParameters> = {
  widthM: 12,
  depthM: 3,
  fovDeg: 55,
  segments: 128,
};

/** Row-major, top-left origin, normalized inverse depth: 0 is far, 1 is near. */
export interface DepthReliefMap {
  width: number;
  height: number;
  data: Float32Array;
}

/** Invalid persisted payloads are dropped, never converted into a plausible fake scene. */
export function normalizeDepthRelief(value: unknown): DepthRelief | undefined {
  const result = depthReliefSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
