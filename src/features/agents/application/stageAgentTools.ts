import { z } from 'zod';
import { stageCommands, stageCommandSchema, stageDraftInputSchema, stageCreateInputSchema, isDestructiveStageCommand } from '@/features/stage/application/stageCommands';
import { stageItemSchema } from '@/features/stage/domain/stageSchemas';
import { defineScopedAgentTool } from './scopedAgentToolDefinition';
import type { StageSnapshot } from '@/features/stage/domain/stage';
import { resolveAsset } from '@/features/assets/application/assetCatalog';
import { stageAgentCatalogs } from '@/features/stage/application/stageCatalogs';
import { compileStoryPlan } from '@/features/stage/application/storyCompiler';
import { stageDirectInputSchema } from '@/features/stage/application/storyPlan';

export function projectAgentStageSnapshot(snapshot: StageSnapshot) {
  const { data, nodeId, revision } = snapshot;
  const motion = data.motionProject;
  return {
    nodeId, revision, mode: data.mode, title: data.displayName, basePrompt: data.basePrompt,
    aspectRatio: data.aspectRatio, camera: data.camera, lighting: data.lighting, grid: data.grid,
    objects: data.items.slice(0, 100).map(({ refImageUrl: _source, refImageName: _name, ...item }) => item),
    durationSeconds: motion?.durationSeconds, loop: motion?.loop,
    cameraFrames: motion?.cameraTrack.slice(0, 100),
    objectFrames: Object.entries(motion?.objectTracks ?? {}).flatMap(([itemId, frames]) => frames.slice(0, 100).map((frame) => ({ itemId, ...frame }))),
    actionFrames: Object.entries(motion?.actionTracks ?? {}).flatMap(([itemId, frames]) => frames.slice(0, 100).map((frame) => ({ itemId, ...frame }))),
    clips: motion?.customClips.map(({ keyframes: _frames, ...clip }) => clip),
    clipFrames: motion?.customClips.flatMap((clip) => clip.keyframes.slice(0, 100).map((frame) => ({ clipId: clip.id, ...frame }))),
  };
}

const nodeId = z.string().trim().min(1);
// Media is selected through asset ids, never arbitrary image URLs in object patches.
const commandSchemas = stageCommandSchema.options.map((schema) => {
  if (schema.shape.type.value === 'object.add') return z.object({ type: z.literal('object.add'), item: stageItemSchema.omit({ refImageUrl: true, refImageName: true }) }).strict();
  if (schema.shape.type.value === 'object.update') return z.object({ type: z.literal('object.update'), itemId: nodeId, patch: stageItemSchema.omit({ id: true, refImageUrl: true, refImageName: true }).partial() }).strict();
  return schema;
});
const agentStageCommandSchema = z.union(commandSchemas as [typeof commandSchemas[number], typeof commandSchemas[number], ...typeof commandSchemas[number][]]);

export const stageAgentTools = [
  defineScopedAgentTool({
    name: 'stage_query', scope: 'stage', risk: 'read', description: 'Read actual stage ids/revision, objects, camera and tracks plus real scene/pose/action/camera catalogs and anatomical pose channels. Null nodeId means the active stage.',
    schema: z.object({ nodeId: nodeId.nullable() }).strict(),
    async execute(input) { return { ...projectAgentStageSnapshot(stageCommands.query(input.nodeId ?? undefined)), catalogs: stageAgentCatalogs() }; },
  }),
  defineScopedAgentTool({
    name: 'stage_create', scope: 'stage', risk: 'edit', description: 'Create a real stage node using the shared application command boundary.',
    schema: stageCreateInputSchema,
    async execute(input) { return projectAgentStageSnapshot(stageCommands.create(input)); },
  }),
  defineScopedAgentTool({
    name: 'stage_open', scope: 'stage', risk: 'edit', description: 'Open an existing stage in director or previs workspace.',
    schema: z.object({ nodeId, workspace: z.enum(['director', 'previs']).nullable() }).strict(),
    async execute(input) { return stageCommands.open(input.nodeId, input.workspace ?? undefined); },
  }),
  defineScopedAgentTool({
    name: 'stage_command', scope: 'stage', description: 'Execute one command or an atomic batch of 1–100 commands. person.pose writes a static pose (no time) or timed frame; person.action and camera.preset replace only their explicit interval. Query real ids/catalogs first. Nullable fields such as trackTargetId and actionId use null to explicitly clear; when strict mode requires these fields during an unrelated update, preserve their queried current values. Times are absolute seconds; clips require clipStart. Replacement/removal requires destructive approval.',
    schema: z.object({ nodeId, command: z.union([agentStageCommandSchema, z.array(agentStageCommandSchema).min(1).max(100)]) }).strict(),
    risk: (input) => (Array.isArray(input.command) ? input.command : [input.command]).some((command) => isDestructiveStageCommand(stageCommandSchema.parse(command))) ? 'destructive' : 'edit',
    async execute(input, context) {
      const commands = (Array.isArray(input.command) ? input.command : [input.command]).map((command) => stageCommandSchema.parse(command));
      const result = stageCommands.execute(input.nodeId, commands, context.expectedRevision);
      return { ...projectAgentStageSnapshot(result), createdIds: result.createdIds };
    },
  }),
  defineScopedAgentTool({
    name: 'stage_direct', scope: 'stage', description: 'Compile a strict story plan using real cast/set/pose/action catalogs, metric blocking and framed shots. Always dryRun first and inspect warnings. dryRun is read-only; execution applies the identical compiled plan as one atomic undo transaction. Capture returned key times and inspect asset_view afterwards.',
    schema: stageDirectInputSchema,
    risk: (input) => input.dryRun ? 'read' : compileStoryPlan(input.plan, stageCommands.query(input.nodeId)).commands.some(isDestructiveStageCommand) ? 'destructive' : 'edit',
    async execute(input, context) {
      if (input.expectedRevision !== undefined && context.expectedRevision !== undefined && input.expectedRevision !== context.expectedRevision) throw new Error('Stage revision conflict. Refresh and preview the plan again.');
      const result = stageCommands.direct(input.nodeId, input.plan, { dryRun: input.dryRun, expectedRevision: input.expectedRevision ?? context.expectedRevision });
      if (result.dryRun) return result;
      return { ...projectAgentStageSnapshot(result), createdIds: result.createdIds, warnings: result.warnings, captureTimes: result.captureTimes, dryRun: false };
    },
  }),
  defineScopedAgentTool({
    name: 'stage_draft_scene', scope: 'stage', risk: 'paid', description: 'Call the selected real chat/vision model to draft a scene from text and up to three existing image asset ids. May charge money; always confirm. Returns a validated draft, not adopted objects. Use stage_command draft.apply to adopt.',
    schema: stageDraftInputSchema.safeExtend({ modelId: nodeId }),
    async execute(input, context) { return stageCommands.draftScene(input, context.signal); },
  }),
  defineScopedAgentTool({
    name: 'stage_capture', scope: 'stage', risk: 'edit', description: 'Capture real mounted stage image assets. Optional view=four captures front/right/back/left at the same sampled time; omitted/current captures the mounted camera. timeSeconds requires the exact-time capture bridge; fails when unavailable. Use asset_view before claiming visual inspection.',
    schema: z.object({ nodeId, timeSeconds: z.number().finite().min(0).max(120).optional(), view: z.enum(['current', 'four']).optional() }).strict(),
    async execute(input, context) {
      if (input.view === 'four') {
        const capture = await stageCommands.captureFourViews(input.nodeId, input.timeSeconds, context.signal);
        const images = await Promise.all(capture.images.map(async (image) => {
          const asset = await resolveAsset(image.assetId) ?? await resolveAsset(`project:${context.projectId}:${image.assetId}`);
          if (!asset || asset.kind !== 'image') throw new Error('捕获已完成，但图片资产登记尚不可用。');
          return { ...image, assetId: asset.id };
        }));
        context.signal?.throwIfAborted();
        return { ...capture, images };
      }
      const capture = await stageCommands.capture(input.nodeId, input.timeSeconds, context.signal);
      const assetId = await resolveAsset(capture.assetId)
        ? capture.assetId
        : `project:${context.projectId}:${capture.assetId}`;
      const asset = await resolveAsset(assetId);
      if (!asset || asset.kind !== 'image') throw new Error('捕获已完成，但图片资产登记尚不可用。');
      return { ...capture, assetId: asset.id };
    },
  }),
  defineScopedAgentTool({
    name: 'stage_record', scope: 'stage', risk: 'edit', description: 'Record real stage playback via the existing director MediaRecorder export path, optionally materializing a video node.',
    schema: z.object({ nodeId, resolution: z.enum(['720p', '1080p']), fps: z.union([z.literal(24), z.literal(30)]), addToCanvas: z.boolean() }).strict(),
    async execute({ nodeId: id, ...input }) { return stageCommands.record(id, input); },
  }),
];
