import { z } from 'zod';
import { buildChatModelCatalog } from '@/features/canvas/application/chatModelCatalog';
import { buildCanvasAssetCatalog } from '@/features/canvas/application/canvasAssetCatalog';
import { getAssetPortableSource, resolveAsset } from '@/features/assets/application/assetCatalog';
import { imageUrlToDataUrl } from '@/features/canvas/application/imageData';
import { submitCustomChatCompletion } from '@/features/channels/runtime/channelChat';
import { stageSceneCatalog, stageAgentCatalogs } from './stageCatalogs';
import { channelProviderId, projectChannelProviders, useChannelStore } from '@/features/channels/store/channelStore';
import { resolveNativeChannelModel } from '@/features/channels/application/channelService';
import { useCanvasStore } from '@/stores/canvasStore';
import type { StageDraftRequest, StageSceneDraft } from '../domain/stage';
import { stageDraftInputSchema, stageSceneDraftSchema } from '../domain/stageSchemas';

/** Model I/O is deliberately outside graph transactions; no canvas mutation occurs here. */
export async function draftStageScene(request: StageDraftRequest, signal?: AbortSignal): Promise<StageSceneDraft> {
  signal?.throwIfAborted();
  const input = stageDraftInputSchema.parse(request);
  const catalog = buildChatModelCatalog(projectChannelProviders(useChannelStore.getState().channels));
  if (!input.modelId) throw new Error('Select a chat model explicitly before drafting a stage.');
  const resolved = resolveNativeChannelModel(input.modelId);
  const model = resolved ? catalog.find((entry) => entry.modelId === resolved.model.id && entry.providerId === channelProviderId(resolved.profile.id, 'chat')) : undefined;
  if (!model?.usable) throw new Error('Configure a usable chat model in Settings before drafting a stage.');
  if (input.images?.length && !model.supportsMultimodal) throw new Error('This model does not support reference images; select a vision model.');
  const assets = buildCanvasAssetCatalog(useCanvasStore.getState().nodes);
  const sources = await Promise.all((input.images ?? []).map(async (id) => {
    signal?.throwIfAborted();
    const canvasAsset = assets.find((entry) => entry.id === id && entry.kind === 'image');
    const libraryAsset = canvasAsset ? null : await resolveAsset(id);
    signal?.throwIfAborted();
    const source = canvasAsset?.url ?? (libraryAsset?.kind === 'image' ? libraryAsset.source : null);
    if (!source) throw new Error(`Reference image asset ${id} does not exist.`);
    const portableSource = await getAssetPortableSource(source);
    signal?.throwIfAborted();
    const dataUrl = await imageUrlToDataUrl(portableSource);
    signal?.throwIfAborted();
    return dataUrl;
  }));
  signal?.throwIfAborted();
  const result = await submitCustomChatCompletion(model.id, {
    messages: [
      { role: 'system', content: `Draft a scene for an existing Three.js storyboard stage. Return only a JSON object conforming exactly to this schema: ${JSON.stringify(z.toJSONSchema(stageSceneDraftSchema))}. Coordinates are world meters, Y up; rotations are radians. Use only existing renderable preset IDs and their registered heights: ${JSON.stringify(stageSceneCatalog())}. Actions, if supplied, must be real catalog ids: ${JSON.stringify(stageAgentCatalogs().actions)}. Never invent geometry, assets, dimensions or unsupported preset IDs. For reference images, include estimation with uncertainty notes, cameraHeightM where inferable, horizonNormalized (0=top, 1=bottom) where visible, and scaleReference identifying which known object/preset height anchors metric scale. Estimate horizon/vanishing directions first, then camera height, pitch and vertical FOV (camera.fov, degrees) from perspective; use human/door/car registered heights for metric distances rather than treating pixels as meters. Place object feet on the ground plane unless visibly raised. Explain occlusion, unknown lens/crop, missing horizon, alternative depth/scale interpretations and low confidence in estimation.uncertainty; omit unobservable numeric estimates rather than invent confidence. Keep camera.position.y consistent with estimated camera height and camera.target consistent with horizon/pitch. Cross-check projected known heights and relative sizes. Single-view staging is only a scale-anchored approximation, never exact image reconstruction. If unsupported, return empty objects and explain limits in description and uncertainty. Do not execute changes.` },
      { role: 'user', content: [{ type: 'text', text: input.prompt || 'Draft staging from these reference images.' }, ...sources.map((url) => ({ type: 'image_url', image_url: { url } }))] },
    ],
  });
  signal?.throwIfAborted();
  const text = result.text.trim();
  const json = text.startsWith('```') ? text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '') : text;
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error('The scene model did not return valid JSON. Nothing was applied.'); }
  const parsed = stageSceneDraftSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid scene draft; nothing was applied: ${parsed.error.message}`);
  if (input.images?.length && !parsed.data.estimation) throw new Error('Invalid image scene draft; include camera/metric-scale uncertainty notes. Nothing was applied.');
  const presets = new Map(stageSceneCatalog().map((entry) => [entry.presetId, entry]));
  const actionIds = new Set(stageAgentCatalogs().actions.map((entry) => entry.id));
  for (const object of parsed.data.objects) {
    if (presets.get(object.presetId)?.category !== object.category) throw new Error(`Invalid scene draft category for ${object.presetId}. Nothing was applied.`);
    if (object.action && !actionIds.has(object.action)) throw new Error(`Invalid scene draft action ${object.action}. Nothing was applied.`);
  }
  if (parsed.data.estimation?.cameraHeightM !== undefined && parsed.data.camera && Math.abs(parsed.data.camera.position.y - parsed.data.estimation.cameraHeightM) > 0.05) throw new Error('Invalid scene draft: camera height contradicts its estimation. Nothing was applied.');
  return parsed.data;
}
