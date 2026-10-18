import { z } from 'zod';
import { buildChatModelCatalog } from '@/features/canvas/application/chatModelCatalog';
import { buildCanvasAssetCatalog } from '@/features/canvas/application/canvasAssetCatalog';
import { getAssetPortableSource, resolveAsset } from '@/features/assets/application/assetCatalog';
import { imageUrlToDataUrl } from '@/features/canvas/application/imageData';
import { submitCustomChatCompletion } from '@/features/canvas/infrastructure/customProviderGateway';
import { BLUEPRINT_PRESET_LABELS } from '@/features/canvas/domain/blueprintPresetCatalog';
import { useCustomProvidersStore } from '@/stores/customProvidersStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useCanvasStore } from '@/stores/canvasStore';
import type { StageDraftRequest, StageSceneDraft } from '../domain/stage';
import { stageDraftInputSchema, stageSceneDraftSchema } from '../domain/stageSchemas';

/** Model I/O is deliberately outside graph transactions; no canvas mutation occurs here. */
export async function draftStageScene(request: StageDraftRequest, signal?: AbortSignal): Promise<StageSceneDraft> {
  signal?.throwIfAborted();
  const input = stageDraftInputSchema.parse(request);
  const catalog = buildChatModelCatalog(useCustomProvidersStore.getState().providers, useSettingsStore.getState().agnesApiKey);
  if (!input.modelId) throw new Error('Select a chat model explicitly before drafting a stage.');
  const model = catalog.find((entry) => entry.id === input.modelId);
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
      { role: 'system', content: `Draft a scene for an existing Three.js storyboard stage. Return only a JSON object conforming exactly to this schema: ${JSON.stringify(z.toJSONSchema(stageSceneDraftSchema))}. Coordinates are world meters, Y up; rotations are radians. Use only the existing renderable preset IDs, whose labels are ${JSON.stringify(BLUEPRINT_PRESET_LABELS)}. Do not invent geometry, assets or unsupported preset IDs. Approximate staging is a draft, never claim image reconstruction is exact. If the request cannot be represented by these presets, return an empty objects array and explain the limitation in description. Do not execute changes.` },
      { role: 'user', content: [{ type: 'text', text: input.prompt || 'Draft staging from these reference images.' }, ...sources.map((url) => ({ type: 'image_url', image_url: { url } }))] },
    ], temperature: 0, max_tokens: 6000,
  });
  signal?.throwIfAborted();
  const text = result.text.trim();
  const json = text.startsWith('```') ? text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '') : text;
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error('The scene model did not return valid JSON. Nothing was applied.'); }
  const parsed = stageSceneDraftSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid scene draft; nothing was applied: ${parsed.error.message}`);
  return parsed.data;
}
