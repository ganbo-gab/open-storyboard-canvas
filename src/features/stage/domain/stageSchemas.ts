import { z } from 'zod';
import { BLUEPRINT_PRESET_LABELS } from '@/features/canvas/domain/blueprintPresetCatalog';

const id = z.string().trim().min(1).max(300);
const number = z.number().finite();
const text = z.string().max(10000);
export const stageVectorSchema = z.object({ x: number, y: number, z: number }).strict();
const rotation = z.object({ x: number.optional(), y: number.optional(), z: number.optional() }).strict();
const hinge = z.object({ x: number.optional() }).strict();
const pose = z.object({ leftShoulder: rotation.optional(), rightShoulder: rotation.optional(), leftElbow: hinge.optional(), rightElbow: hinge.optional(), leftHip: rotation.optional(), rightHip: rotation.optional(), leftKnee: hinge.optional(), rightKnee: hinge.optional(), head: rotation.optional(), torso: hinge.optional(), scaleY: number.optional(), groupY: number.optional(), groupRotX: number.optional() }).strict();
const bodyControls = z.object({ style: z.enum(['preset', 'slim', 'strong', 'heavy', 'childlike']).optional(), showControls: z.boolean().optional(), core: z.object({ height: number.optional(), torsoWidth: number.optional(), headScale: number.optional(), torsoLeanDeg: number.optional() }).strict().optional(), arms: z.object({ length: number.optional(), thickness: number.optional(), spreadDeg: number.optional() }).strict().optional(), legs: z.object({ length: number.optional(), thickness: number.optional(), spreadDeg: number.optional() }).strict().optional() }).strict();
export const stageItemSchema = z.object({ id, label: id, x: number, y: number, color: id, showLabel: z.boolean().optional(), refImageUrl: z.string().nullable().optional(), refImageName: text.nullable().optional(), note: text.optional(), pos3d: stageVectorSchema.optional(), rotation3d: stageVectorSchema.optional(), scale3d: stageVectorSchema.optional(), category: z.enum(['person', 'object', 'scene']).optional(), presetId: id.optional(), relation: text.optional(), action: text.optional(), directorStudioRole: z.literal('pedestrian').optional(), directorStudioNumber: z.number().int().nonnegative().optional(), bodyControls: bodyControls.optional() }).strict();
const base = { id, time: number.nonnegative(), easing: z.enum(['linear', 'smooth', 'hold']), easingRange: z.tuple([number.min(0).max(1), number.min(0).max(1)]).optional() };
const actionState = { poseId: id.nullable().optional(), actionId: id.nullable().optional(), clipId: id.nullable().optional(), pose: pose.optional(), bodyControls: bodyControls.optional(), actionOffsetSeconds: number.nonnegative().optional() };
const objectFrame = z.object({ ...base, position: stageVectorSchema, rotation: stageVectorSchema, scale: stageVectorSchema, orientToPath: z.boolean().optional() }).strict();
const cameraFrame = z.object({ ...base, position: stageVectorSchema, target: stageVectorSchema, fov: number.min(10).max(150), trackTargetId: id.nullable().optional(), trackTargetBodyPart: z.enum(['head', 'torso', 'feet']).nullable().optional(), freeRotation: stageVectorSchema.optional() }).strict();
const actionFrame = z.object({ ...base, ...actionState }).strict();
const clip = z.object({ id, name: id, durationSeconds: number.min(0.5).max(30), loop: z.boolean(), keyframes: z.array(actionFrame).max(1000) }).strict();
const track = z.discriminatedUnion('kind', [z.object({ kind: z.literal('camera') }).strict(), z.object({ kind: z.enum(['object', 'action']), itemId: id }).strict(), z.object({ kind: z.literal('clip'), clipId: id, clipStart: number.nonnegative() }).strict()]);
const lookAt = z.discriminatedUnion('mode', [z.object({ mode: z.literal('target'), targetId: id, bodyPart: z.enum(['head', 'torso', 'feet']).optional() }).strict(), z.object({ mode: z.literal('point'), point: stageVectorSchema }).strict(), z.object({ mode: z.literal('free'), rotation: stageVectorSchema }).strict()]);
const draftObject = z.object({ label: id, category: z.enum(['person', 'object', 'scene']), presetId: z.enum(Object.keys(BLUEPRINT_PRESET_LABELS) as [string, ...string[]]), position: stageVectorSchema, rotation: stageVectorSchema, scale: stageVectorSchema.refine((v) => v.x > 0 && v.y > 0 && v.z > 0, 'Scale must be positive'), action: text.optional() }).strict();
const draftCamera = z.object({ position: stageVectorSchema, target: stageVectorSchema, fov: number.min(10).max(150) }).strict();
export const stageSceneDraftSchema = z.object({ version: z.literal(1), description: text, objects: z.array(draftObject).max(100), camera: draftCamera.optional() }).strict();
export const stageDraftInputSchema = z.object({ prompt: z.string().trim().max(10000), images: z.array(id).max(3).optional(), modelId: id.optional() }).strict().refine((v) => v.prompt.length > 0 || Boolean(v.images?.length), 'Provide a description or image asset');
export const stageCreateInputSchema = z.object({ mode: z.enum(['flat', 'panorama']).optional(), workspace: z.enum(['director', 'previs']).optional(), position: z.object({ x: number, y: number }).strict().optional(), name: id.optional() }).strict();
export const stageCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('object.add'), item: stageItemSchema }).strict(),
  z.object({ type: z.literal('object.update'), itemId: id, patch: stageItemSchema.omit({ id: true }).partial() }).strict(),
  z.object({ type: z.literal('object.remove'), itemId: id }).strict(),
  z.object({ type: z.literal('camera.lookAt'), time: number.nonnegative(), lookAt, position: stageVectorSchema.optional(), fov: number.min(10).max(150).optional() }).strict(),
  z.object({ type: z.literal('trajectory.set'), targetId: id, method: z.enum(['freehand', 'points', 'line']), points: z.array(stageVectorSchema).min(2).max(10000), start: number.nonnegative(), duration: number.min(0.2).max(30), camera: z.object({ target: stageVectorSchema, fov: number.min(10).max(150) }).strict().optional() }).strict(),
  z.object({ type: z.literal('clip.add'), clip }).strict(),
  z.object({ type: z.literal('clip.update'), clipId: id, patch: clip.omit({ id: true }).partial() }).strict(),
  z.object({ type: z.literal('clip.split'), clipId: id, time: number.nonnegative(), clipStart: number.nonnegative() }).strict(),
  z.object({ type: z.literal('clip.delete'), clipId: id }).strict(),
  z.object({ type: z.literal('keyframe.add'), track, keyframe: z.union([objectFrame, cameraFrame, actionFrame]) }).strict(),
  z.object({ type: z.literal('keyframe.update'), track, keyframeId: id, patch: z.union([objectFrame.omit({ id: true }).partial(), cameraFrame.omit({ id: true }).partial(), actionFrame.omit({ id: true }).partial()]) }).strict(),
  z.object({ type: z.literal('keyframe.remove'), track, keyframeId: id }).strict(),
  z.object({ type: z.literal('draft.apply'), draft: stageSceneDraftSchema, include: z.array(z.enum(['objects', 'people', 'camera'])).min(1).optional() }).strict(),
  z.object({ type: z.literal('playback.update'), duration: number.min(0.5).max(30), loop: z.boolean().optional() }).strict(),
]);
export const stageKeyframeSchemas = { object: objectFrame, camera: cameraFrame, action: actionFrame, clip: actionFrame };
