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
  metadata: Record<string, unknown>;
}
interface AssetState { saved: Record<string, AssetRecord>; overrides: Record<string, { name?: string; favorite?: boolean; deleted?: boolean }> }
const schema = z.object({ saved: z.record(z.string(), z.object({ id: z.string(), kind: z.enum(['image', 'video', 'audio', 'text']), source: z.string(), name: z.string(), origin: z.enum(['generated', 'uploaded', 'canvas']), createdAt: z.number(), favorite: z.boolean(), projectId: z.string().optional(), nodeId: z.string().optional(), taskId: z.string().optional(), previewUrl: z.string().nullable().optional(), metadata: z.record(z.string(), z.unknown()) })), overrides: z.record(z.string(), z.object({ name: z.string().optional(), favorite: z.boolean().optional(), deleted: z.boolean().optional() })) });
const document = createWorkspaceDocument<AssetState>('storyboard-copilot:asset-catalog:v1', () => ({ saved: {}, overrides: {} }), (value) => schema.parse(value));

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
export async function listAssets(query: { search?: string; kind?: AssetKind; favorite?: boolean; origin?: AssetRecord['origin'] } = {}): Promise<AssetRecord[]> {
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
      const metadata = { ...node?.data } as Record<string, unknown>;
      delete metadata.generationDebugContext;
      const generated = !!(metadata.sourcePrompt || metadata.generationJobId || metadata.generatedFileName);
      assets.push({ id: `project:${project.id}:${item.id}`, kind: item.kind, source: item.url, name: item.title,
        origin: generated ? 'generated' : node?.type === 'uploadNode' || metadata.sourceFileName ? 'uploaded' : 'canvas',
        createdAt: project.updatedAt, favorite: false, projectId: project.id, nodeId: item.nodeId,
        previewUrl: item.previewUrl, metadata: { ...metadata, projectName: project.name, aspectRatio: item.aspectRatio },
      });
    }
    for (const node of project.nodes) {
      if (node.type !== 'textAnnotationNode') continue;
      const data = node.data as Record<string, unknown>;
      if (typeof data.content !== 'string' || !data.content) continue;
      assets.push({ id: `project:${project.id}:${node.id}:text`, kind: 'text', source: data.content,
        name: typeof data.displayName === 'string' ? data.displayName : 'Text', origin: 'canvas',
        createdAt: project.updatedAt, favorite: false, projectId: project.id, nodeId: node.id, metadata: { ...data } });
    }
  }
  const search = query.search?.trim().toLocaleLowerCase();
  return assets.filter((asset) => !state.overrides[asset.id]?.deleted).map((asset) => ({ ...asset, ...state.overrides[asset.id] }))
    .filter((asset) => (!query.kind || asset.kind === query.kind) && (query.favorite === undefined || asset.favorite === query.favorite)
      && (!query.origin || asset.origin === query.origin)
      && (!search || `${asset.name} ${JSON.stringify(asset.metadata)}`.toLocaleLowerCase().includes(search)))
    .sort((a, b) => b.createdAt - a.createdAt);
}
export async function resolveAsset(id: string): Promise<AssetRecord | null> {
  return (await listAssets()).find((asset) => asset.id === id) ?? null;
}
export async function saveAsset(input: Omit<AssetRecord, 'id' | 'createdAt' | 'favorite'> & Partial<Pick<AssetRecord, 'id' | 'createdAt' | 'favorite'>>): Promise<AssetRecord> {
  if (!input.source.trim() || !input.name.trim()) throw new Error('Asset name and source are required');
  await document.initialize?.();
  let source = input.source;
  if (isTauri() && /^(data:|blob:)/.test(source)) {
    if (source.startsWith('blob:')) source = await getAssetPortableSource(await externalizeAssetMedia(source));
    if (input.kind === 'image') source = await persistImageSource(source);
    else if (input.kind === 'video') source = await persistVideoSource(source);
  }
  source = input.kind === 'text' ? source : await persistAssetMedia(source, input.origin === 'generated', input.kind);
  const metadata = await externalizeAssetMedia(input.metadata);
  const asset: AssetRecord = { ...input, source, metadata, id: input.id ?? crypto.randomUUID(), createdAt: input.createdAt ?? Date.now(), favorite: input.favorite ?? false };
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
  await document.initialize?.();
  const state = document.load();
  const saved = { ...state.saved };
  delete saved[id];
  await persistAssetState({ saved, overrides: { ...state.overrides, [id]: { ...state.overrides[id], deleted: true } } });
}
export const getAssetStorageStatus = () => document.status();
