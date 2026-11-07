import { z } from 'zod';
import { stageActionIdSchema, stagePoseIdSchema, stageVectorSchema } from '../domain/stageSchemas';
import { stageSceneCatalog } from './stageCatalogs';

const id = z.string().trim().min(1).max(300);
const number = z.number().finite();
const catalog = stageSceneCatalog();
const personPreset = z.enum(catalog.filter((entry) => entry.category === 'person').map((entry) => entry.presetId) as [string, ...string[]]);
const setPreset = z.enum(catalog.filter((entry) => entry.category !== 'person').map((entry) => entry.presetId) as [string, ...string[]]);
export const storyPositionSchema = z.union([
  stageVectorSchema,
  z.object({ actorId: id, offset: stageVectorSchema.optional() }).strict(),
  z.object({ markId: id, offset: stageVectorSchema.optional() }).strict(),
]);
const blocking = z.object({
  itemId: id, from: storyPositionSchema.optional(), to: storyPositionSchema.optional(),
  travelSpeedMps: number.positive().max(20).optional(),
  actionId: stageActionIdSchema.optional(), poseId: stagePoseIdSchema.optional(),
  facing: z.union([number, storyPositionSchema]).optional(), lookAt: storyPositionSchema.optional(),
}).strict();
export const storyShotSchema = z.object({
  start: number.min(0).max(120), duration: number.min(0.2).max(120),
  size: z.enum(['extreme-wide', 'wide', 'full', 'medium', 'close', 'extreme-close']),
  angle: z.enum(['eye', 'high', 'low', 'overhead']),
  movement: z.enum(['static', 'push', 'pull', 'pan', 'orbit', 'track', 'crane']),
  subjectItemIds: z.array(id).min(1).max(20), transition: z.enum(['cut', 'blend']),
  fov: number.min(10).max(150).optional(), azimuth: number.optional(),
  blendSeconds: number.min(0.01).max(5).optional(),
}).strict();
/** Data-only authoring plan. Existing ids and all temporal references are resolved by the compiler. */
export const storyPlanSchema = z.object({
  version: z.literal(1), duration: number.min(0.5).max(120),
  cast: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('existing'), itemId: id }).strict(),
    z.object({ kind: z.literal('new'), itemId: id, presetId: personPreset, label: id, heightM: number.min(0.3).max(3), position: stageVectorSchema.optional() }).strict(),
  ])).max(30),
  setObjects: z.array(z.object({ itemId: id, presetId: setPreset, label: id, position: stageVectorSchema, rotation: stageVectorSchema.optional(), scale: stageVectorSchema.refine((v) => v.x > 0 && v.y > 0 && v.z > 0, 'Scale must be positive').optional() }).strict()).max(50),
  marks: z.array(z.object({ id, position: stageVectorSchema }).strict()).max(100).optional(),
  beats: z.array(z.object({ start: number.min(0).max(120), duration: number.min(0.2).max(120), blocking: z.array(blocking).min(1).max(30) }).strict()).max(100),
  shots: z.array(storyShotSchema).max(100),
}).strict().superRefine((plan, context) => {
  for (const [kind, ranges] of [['beats', plan.beats], ['shots', plan.shots]] as const) {
    ranges.forEach((range, index) => {
      if (range.start + range.duration > plan.duration + 1e-9) context.addIssue({ code: 'custom', path: [kind, index, 'duration'], message: 'Range exceeds plan duration.' });
    });
  }
  plan.shots.forEach((shot, index) => {
    if (shot.blendSeconds !== undefined && (shot.transition !== 'blend' || shot.blendSeconds >= shot.duration)) context.addIssue({ code: 'custom', path: ['shots', index, 'blendSeconds'], message: 'Blend must be shorter than a blend shot.' });
  });
});
export type StoryPlan = z.infer<typeof storyPlanSchema>;
export type StoryPosition = z.infer<typeof storyPositionSchema>;
export type StoryShot = z.infer<typeof storyShotSchema>;
export const stageDirectInputSchema = z.object({ nodeId: id, plan: storyPlanSchema, dryRun: z.boolean(), expectedRevision: z.number().int().nonnegative().optional() }).strict();
