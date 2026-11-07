import { resolveAsset, saveAsset, type AssetRecord } from './assetCatalog';
import { processMediaEdit, type MediaEditOperation, type MediaEditOptions, type EditedMedia } from '@/features/canvas/application/media';
import { persistAssetBlob } from './assetMediaStorage';
import { checkMediaEditAbort } from '@/features/canvas/application/media/types';
import { z } from 'zod';

export interface AssetEditOutput { source: string; kind: AssetRecord['kind']; width?: number; height?: number; durationSeconds?: number; sourceRange?: EditedMedia['sourceRange'] }
export interface AssetEditDetails { name: string; prompt?: string; operations: string[] }
interface AssetEditDependencies {
  resolve(id: string): Promise<AssetRecord | null>;
  save: typeof saveAsset;
}
const metadataFacts = z.object({ model: z.string().optional(), jobId: z.string().optional(), sourceModelId: z.string().optional() });

/** A new catalogue identity owns each result; the parent bytes and record are never replaced. */
export function createDerivedAssetSaver(deps: AssetEditDependencies) {
  return async (original: AssetRecord, output: AssetEditOutput, details: AssetEditDetails, options: { id?: string; signal?: AbortSignal; validateSource?(): void } = {}): Promise<AssetRecord> => {
    checkMediaEditAbort(options.signal);
    if (!details.name.trim() || !output.source.trim()) throw new Error('请填写名称并保留有效内容。');
    if (options.id === original.id) throw new Error('编辑结果必须使用新的素材编号，不能覆盖原素材。');
    if (options.validateSource) options.validateSource();
    else {
      const current = await deps.resolve(original.id);
      if (!current || current.source !== original.source || current.kind !== original.kind) throw new Error('原素材已变更或被移除，请重新打开编辑。');
    }
    checkMediaEditAbort(options.signal);
    options.validateSource?.();
    const facts = metadataFacts.parse(original.metadata);
    return deps.save({ id: options.id ?? crypto.randomUUID(), kind: output.kind, source: output.source, name: details.name.trim(),
      origin: original.origin, projectId: original.projectId, tags: original.tags, previewUrl: null,
      metadata: { ...facts, ...(details.prompt === undefined ? {} : { prompt: details.prompt, sourcePrompt: details.prompt }),
        ...(output.width && output.height ? { width: output.width, height: output.height, aspectRatio: `${output.width}:${output.height}`, resolution: `${output.width}×${output.height}` } : {}),
        ...(output.durationSeconds ? { durationSeconds: output.durationSeconds } : {}),
        editProvenance: { parentAssetId: original.id, parentProjectId: original.projectId, parentNodeId: original.nodeId,
          parentTaskId: original.taskId, parentName: original.name, parentMetadata: original.metadata,
          operations: details.operations, sourceRange: output.sourceRange, editedAt: Date.now() } },
    });
  };
}
export const saveDerivedAsset = createDerivedAssetSaver({ resolve: resolveAsset, save: saveAsset });

export async function editAssetMedia(original: AssetRecord, operation: MediaEditOperation, options: MediaEditOptions = {}, idPrefix = crypto.randomUUID()): Promise<AssetRecord[]> {
  const result = await processMediaEdit(original.source, operation, options);
  const assets: AssetRecord[] = [];
  for (const [index, output] of result.outputs.entries()) {
    checkMediaEditAbort(options.signal);
    const source = await persistAssetBlob(output.blob);
    assets.push(await saveDerivedAsset(original, { ...output, source }, { name: `${original.name} · 编辑${result.outputs.length > 1 ? ` ${index + 1}` : ''}`,
      prompt: typeof original.metadata.prompt === 'string' ? original.metadata.prompt : typeof original.metadata.sourcePrompt === 'string' ? original.metadata.sourcePrompt : undefined,
      operations: [operation.kind] }, { signal: options.signal, id: `${idPrefix}:${index}` }));
  }
  return assets;
}
