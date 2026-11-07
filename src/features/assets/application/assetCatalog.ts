import { isTauri } from '@tauri-apps/api/core';
import { persistImageSource, persistVideoSource } from '@/commands/image';
import { getProjectRecord, listProjectSummaries, type ProjectRecord } from '@/commands/projectState';
import { decodeProject, useProjectStore, type Project } from '@/stores/projectStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { buildCanvasAssetCatalog } from '@/features/canvas/application/canvasAssetCatalog';
import { createWorkspaceDocument } from '@/features/workbench/application/workspaceDocument';
import { externalizeAssetMedia, getAssetPortableSource, persistAssetMedia } from './assetMediaStorage';
export { getAssetDisplaySource, getAssetPortableSource } from './assetMediaStorage';
import { z } from 'zod';
import { importProjectMedia } from '@/features/workbench/application/importWorkbenchResult';
import { normalizeAssetMetadata } from './assetMetadata';

export type AssetKind = 'image' | 'video' | 'audio' | 'text';
export interface AssetRecord {
  id: string;
  kind: AssetKind;
  source: string;
  name: string;
  origin: 'generated' | 'uploaded' | 'canvas';
  createdAt: number;
  favorite: boolean;
  projectId?: string;
  nodeId?: string;
  taskId?: string;
  previewUrl?: string | null;
  tags?: string[];
  metadata: Record<string, unknown>;
}
interface AssetOverride { name?: string; favorite?: boolean; deleted?: boolean; tags?: string[] }
interface AssetState { saved: Record<string, AssetRecord>; overrides: Record<string, AssetOverride> }
const assetRecordSchema = z.object({ id: z.string(), kind: z.enum(['image', 'video', 'audio', 'text']), source: z.string(), name: z.string(), origin: z.enum(['generated', 'uploaded', 'canvas']), createdAt: z.number(), favorite: z.boolean(), projectId: z.string().optional(), nodeId: z.string().optional(), taskId: z.string().optional(), previewUrl: z.string().nullable().optional(), tags: z.array(z.string()).optional(), metadata: z.unknown().default({}).transform(normalizeAssetMetadata) });
const schema = z.object({ saved: z.record(z.string(), assetRecordSchema), overrides: z.record(z.string(), z.object({ name: z.string().optional(), favorite: z.boolean().optional(), deleted: z.boolean().optional(), tags: z.array(z.string()).optional() })) });
export function createAssetCatalogDocument(key = 'storyboard-copilot:asset-catalog:v1') {
  return createWorkspaceDocument<AssetState>(key, () => ({ saved: {}, overrides: {} }), (value) => schema.parse(value));
}
const document = createAssetCatalogDocument();

async function persistAssetState(state: AssetState): Promise<void> {
  document.save(state);
  await document.flush?.();
  const status = document.status();
  if (status.mode === 'memory') throw new Error(`资产索引仅保留在本次会话中，未持久保存：${status.reason}`);
}

/** Decode exactly the existing image-pool format, including legacy history pool. */
export function projectFromRecord(record: ProjectRecord): Project {
  const history = JSON.parse(record.historyJson) as Project['history'] & { imagePool?: string[] };
  const pool = record.imagePoolJson ? JSON.parse(record.imagePoolJson) : record.imagePool;
  return decodeProject({ id: record.id, name: record.name, createdAt: record.createdAt,
    updatedAt: record.updatedAt, nodeCount: record.nodeCount,
    nodes: JSON.parse(record.nodesJson), edges: JSON.parse(record.edgesJson),
    viewport: JSON.parse(record.viewportJson), history: { past: history.past ?? [], future: history.future ?? [] },
    imagePool: Array.isArray(pool) && pool.length ? pool : history.imagePool ?? [],
  });
}
export async function listAssets(query: Omit<AssetQuery, 'origin'> & { search?: string; origin?: AssetQuery['origin'] | 'uploaded' } = {}): Promise<AssetRecord[]> {
  await document.initialize?.();
  const state = document.load();
  const projects = await listProjectSummaries();
  const assets: AssetRecord[] = Object.values(state.saved);
  for (const summary of projects) {
    const current = useProjectStore.getState();
    let project: Project;
    if (current.currentProjectId === summary.id && current.currentProject) {
      project = { ...current.currentProject, nodes: useCanvasStore.getState().nodes };
    } else {
      const record = await getProjectRecord(summary.id);
      if (!record) continue;
      project = projectFromRecord(record);
    }
    for (const item of buildCanvasAssetCatalog(project.nodes)) {
      const node = project.nodes.find((candidate) => candidate.id === item.nodeId);
      const metadata = normalizeAssetMetadata(node?.data ?? {});
      const generated = !!(metadata.sourcePrompt || metadata.generationJobId || metadata.generatedFileName);
      const origin = metadata.assetOrigin === 'generated' || metadata.assetOrigin === 'uploaded' || metadata.assetOrigin === 'canvas' ? metadata.assetOrigin
        : generated ? 'generated' : node?.type === 'uploadNode' || metadata.sourceFileName ? 'uploaded' : 'canvas';
      assets.push({ id: `project:${project.id}:${item.id}`, kind: item.kind, source: item.url, name: item.title,
        origin,
        createdAt: project.updatedAt, favorite: false, projectId: project.id, nodeId: item.nodeId,
        ...(typeof metadata.workbenchTaskId === 'string' ? { taskId: metadata.workbenchTaskId } : {}),
        previewUrl: item.previewUrl, metadata: { ...metadata, projectName: project.name, aspectRatio: item.aspectRatio },
      });
    }
    for (const node of project.nodes) {
      if (node.type !== 'textAnnotationNode') continue;
      const data = node.data as Record<string, unknown>;
      if (typeof data.content !== 'string' || !data.content) continue;
      const metadata = normalizeAssetMetadata(data);
      const origin = metadata.assetOrigin === 'generated' || metadata.assetOrigin === 'uploaded' ? metadata.assetOrigin : 'canvas';
      assets.push({ id: `project:${project.id}:${node.id}:text`, kind: 'text', source: data.content,
        name: typeof data.displayName === 'string' ? data.displayName : 'Text', origin,
        createdAt: project.updatedAt, favorite: false, projectId: project.id, nodeId: node.id,
        ...(typeof metadata.workbenchTaskId === 'string' ? { taskId: metadata.workbenchTaskId } : {}), metadata });
    }
  }
  const visible = assets.filter((asset) => !state.overrides[asset.id]?.deleted).map((asset) => ({ ...asset, ...state.overrides[asset.id] }));
  return filterAssets(visible, { ...query, origin: query.origin === 'uploaded' ? 'upload' : query.origin, text: query.text ?? query.search })
    .sort((a, b) => b.createdAt - a.createdAt);
}
export async function resolveAsset(id: string): Promise<AssetRecord | null> {
  return (await listAssets()).find((asset) => asset.id === id) ?? null;
}
export async function saveAsset(input: Omit<AssetRecord, 'id' | 'createdAt' | 'favorite'> & Partial<Pick<AssetRecord, 'id' | 'createdAt' | 'favorite'>>): Promise<AssetRecord> {
  if (!input.source.trim() || !input.name.trim()) throw new Error('Asset name and source are required');
  await document.initialize?.();
  let source = input.source;
  if (input.kind !== 'text' && isTauri() && /^(data:|blob:)/.test(source)) {
    if (source.startsWith('blob:')) source = await getAssetPortableSource(await externalizeAssetMedia(source));
    if (input.kind === 'image') source = await persistImageSource(source);
    else if (input.kind === 'video') source = await persistVideoSource(source);
  }
  source = input.kind === 'text' ? source : await persistAssetMedia(source, input.origin === 'generated', input.kind);
  const metadata = await externalizeAssetMedia(normalizeAssetMetadata(input.metadata));
  const asset: AssetRecord = assetRecordSchema.parse({ ...input, source, metadata, id: input.id ?? crypto.randomUUID(), createdAt: input.createdAt ?? Date.now(), favorite: input.favorite ?? false });
  const state = document.load();
  await persistAssetState({ ...state, saved: { ...state.saved, [asset.id]: asset }, overrides: { ...state.overrides, [asset.id]: {} } });
  return asset;
}
export async function renameAsset(id: string, name: string): Promise<void> {
  if (!name.trim()) throw new Error('Asset name is required');
  if (!await resolveAsset(id)) throw new Error('Asset not found');
  const state = document.load();
  await persistAssetState({ ...state, overrides: { ...state.overrides, [id]: { ...state.overrides[id], name: name.trim() } } });
}
export async function favoriteAsset(id: string, favorite: boolean): Promise<void> {
  if (!await resolveAsset(id)) throw new Error('Asset not found');
  const state = document.load();
  await persistAssetState({ ...state, overrides: { ...state.overrides, [id]: { ...state.overrides[id], favorite } } });
}
/** Only hides/removes the library reference. Never deletes a file or canvas node. */
export async function deleteAssetReference(id: string): Promise<void> {
  await deleteAssetReferences([id]);
}
export const getAssetStorageStatus = () => document.status();

export interface AssetQuery {
  kind?: AssetKind;
  origin?: 'upload' | 'generated' | 'canvas';
  ratio?: string;
  model?: string;
  resolution?: string;
  width?: number;
  height?: number;
  text?: string;
  favorite?: boolean;
  from?: number;
  to?: number;
}
/** Pure, stable filtering; time endpoints are inclusive millisecond timestamps. */
export function filterAssets(assets: readonly AssetRecord[], query: AssetQuery = {}): AssetRecord[] {
  const text = query.text?.trim().toLocaleLowerCase();
  return assets.filter((asset) => {
    const metadata = normalizeAssetMetadata(asset.metadata);
    return (!query.kind || asset.kind === query.kind)
      && (!query.origin || asset.origin === (query.origin === 'upload' ? 'uploaded' : query.origin))
      && (!query.ratio || metadata.aspectRatio === query.ratio)
      && (!query.model || metadata.model === query.model)
      && (!query.resolution || metadata.resolution === query.resolution
        || (metadata.width !== undefined && metadata.height !== undefined && `${metadata.width}x${metadata.height}` === query.resolution))
      && (query.width === undefined || metadata.width === query.width)
      && (query.height === undefined || metadata.height === query.height)
      && (query.favorite === undefined || asset.favorite === query.favorite)
      && (query.from === undefined || asset.createdAt >= query.from)
      && (query.to === undefined || asset.createdAt <= query.to)
      && (!text || `${asset.name} ${asset.kind === 'text' ? asset.source : ''} ${(asset.tags ?? []).join(' ')} ${JSON.stringify(metadata)}`.toLocaleLowerCase().includes(text));
  });
}
export interface AssetDateGroup {
  key: string;
  date: number;
  period: 'today' | 'yesterday' | 'earlier';
  assets: AssetRecord[];
}
/** Local-calendar dates, not elapsed 24-hour buckets (including daylight-saving transitions). */
export function groupAssetsByDate(assets: readonly AssetRecord[], now: number | Date = Date.now()): AssetDateGroup[] {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const groups = new Map<string, AssetDateGroup>();
  for (const asset of [...assets].sort((a, b) => b.createdAt - a.createdAt)) {
    const date = new Date(asset.createdAt); date.setHours(0, 0, 0, 0);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const group: AssetDateGroup = groups.get(key) ?? { key, date: date.getTime(), period: date.getTime() === today.getTime() ? 'today'
      : date.getTime() === yesterday.getTime() ? 'yesterday' : 'earlier', assets: [] };
    group.assets.push(asset); groups.set(key, group);
  }
  return [...groups.values()];
}
/** Add tags in one persisted overlay transaction; originals and project metadata stay untouched. */
export async function tagAssets(ids: readonly string[], tags: readonly string[]): Promise<void> {
  const assets = await listAssets();
  const selected = ids.map((id) => {
    const asset = assets.find((item) => item.id === id);
    if (!asset) throw new Error('Asset not found');
    return asset;
  });
  const normalized = tags.map((tag) => tag.trim()).filter(Boolean);
  const state = document.load();
  const overrides = { ...state.overrides };
  for (const asset of selected) overrides[asset.id] = { ...overrides[asset.id], tags: [...new Set([...(asset.tags ?? []), ...normalized])] };
  await persistAssetState({ ...state, overrides });
}
/** References only: never removes project nodes, user files, or durable media bytes. */
export async function deleteAssetReferences(ids: readonly string[]): Promise<void> {
  await document.initialize?.();
  const state = document.load();
  const saved = { ...state.saved }; const overrides = { ...state.overrides };
  for (const id of ids) { delete saved[id]; overrides[id] = { ...overrides[id], deleted: true }; }
  await persistAssetState({ saved, overrides });
}
export interface AssetDownloadSource { id: string; name: string; kind: AssetKind; source: string }
/** Resolve original sources, never previews or temporary display blob URLs. Does not write files. */
export async function downloadSourcesFor(ids: readonly string[]): Promise<AssetDownloadSource[]> {
  const assets = await listAssets();
  return await Promise.all([...new Set(ids)].map(async (id) => {
    const asset = assets.find((item) => item.id === id);
    if (!asset) throw new Error('Asset not found');
    return { id, name: asset.name, kind: asset.kind, source: asset.kind === 'text' ? asset.source : await getAssetPortableSource(asset.source) };
  }));
}
/** Share workbench's serialized, persistence-awaited importer without opening a project or generating. */
export async function importAssetToProject(assetId: string, projectId: string, position?: { x: number; y: number }): Promise<string> {
  const asset = await resolveAsset(assetId);
  if (!asset) throw new Error('Asset not found');
  const metadata = asset.metadata;
  const config = z.record(z.string(), z.unknown()).safeParse(metadata.config);
  return await importProjectMedia({ kind: asset.kind, source: asset.source }, {
    name: asset.name,
    prompt: typeof metadata.prompt === 'string' ? metadata.prompt : typeof metadata.sourcePrompt === 'string' ? metadata.sourcePrompt : undefined,
    model: typeof metadata.model === 'string' ? metadata.model : typeof metadata.sourceModelId === 'string' ? metadata.sourceModelId : undefined,
    jobId: typeof metadata.jobId === 'string' ? metadata.jobId : undefined,
    aspectRatio: typeof metadata.aspectRatio === 'string' ? metadata.aspectRatio : undefined,
    seconds: typeof metadata.durationSeconds === 'number' ? metadata.durationSeconds : config.success && typeof config.data.seconds === 'number' ? config.data.seconds : undefined,
    workbenchTaskId: asset.taskId,
    assetMetadata: metadata,
    assetId: asset.id,
    origin: asset.origin,
  }, projectId, position);
}
