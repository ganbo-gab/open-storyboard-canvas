import { z } from 'zod';
import { stageCommands, stageCommandSchema, stageDraftInputSchema, stageCreateInputSchema, stageCommandEffects } from '@/features/stage/application/stageCommands';
import { stageItemSchema } from '@/features/stage/domain/stageSchemas';
import { defineScopedAgentTool } from './scopedAgentToolDefinition';
import type { StageSnapshot } from '@/features/stage/domain/stage';
import { resolveAsset } from '@/features/assets/application/assetCatalog';

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
    name: 'stage_query', scope: 'stage', risk: 'read', description: 'Read the actual stage scene, objects, camera, paths, clips and keyframes; null nodeId means the active stage.',
    schema: z.object({ nodeId: nodeId.nullable() }).strict(),
    async execute(input) { return projectAgentStageSnapshot(stageCommands.query(input.nodeId ?? undefined)); },
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
    name: 'stage_command', scope: 'stage', description: 'Execute one precise scene-object, camera, trajectory, clip, keyframe or draft-adoption command. Keyframe times are absolute seconds; clips require clipStart. Query real ids first. Removal is destructive and always confirmed.',
    schema: z.object({ nodeId, command: agentStageCommandSchema }).strict(),
    risk: (input) => stageCommandEffects[input.command.type].destructive ? 'destructive' : 'edit',
    async execute(input, context) {
      const result = stageCommands.execute(input.nodeId, input.command, context.expectedRevision);
      return { ...projectAgentStageSnapshot(result), createdIds: result.createdIds };
    },
  }),
  defineScopedAgentTool({
    name: 'stage_draft_scene', scope: 'stage', risk: 'paid', description: 'Call the selected real chat/vision model to draft a scene from text and up to three existing image asset ids. May charge money; always confirm. Returns a validated draft, not adopted objects. Use stage_command draft.apply to adopt.',
    schema: stageDraftInputSchema.safeExtend({ modelId: nodeId }),
    async execute(input, context) { return stageCommands.draftScene(input, context.signal); },
  }),
  defineScopedAgentTool({
    name: 'stage_capture', scope: 'stage', risk: 'edit', description: 'Capture the actual mounted stage camera render to a registered image asset. Fails explicitly when no live viewport is registered. Use asset_view to visually inspect the returned asset id.',
    schema: z.object({ nodeId }).strict(),
    async execute(input, context) {
      const capture = await stageCommands.capture(input.nodeId);
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
