import { listAssets, getAssetPortableSource, type AssetRecord } from '@/features/assets/application/assetCatalog';
import { useCharacterLibraryStore } from '@/features/characters';
import { buildCanvasAssetCatalog, type CanvasAssetCatalogItem } from '@/features/canvas/application/canvasAssetCatalog';
import { isBlueprintNode } from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { stageCommands } from '@/features/stage/application/stageCommands';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { createAgentCanvasMediaInput, prepareAgentMediaSource, validateAgentTurnMediaInputs } from './agentMediaResolver';
import type { AgentScope, AgentTurnMediaInput } from '../domain/agentModel';

interface AgentMentionBase {
  /** Namespaced stable identity. Insert token, not @label, to disambiguate identical labels. */
  id: string;
  label: string;
  token: string;
  /** Durable source, never an object URL. Resolve for presentation using getAssetDisplaySource. */
  thumbnail?: string;
  projectId?: string;
  context: string;
  imageUnavailable?: boolean;
}
type AgentMentionAssetImage = Pick<AssetRecord, 'id' | 'source' | 'nodeId'>;
export type AgentMentionCandidate = AgentMentionBase & (
  | { kind: 'node'; source: 'canvas'; nodeId: string; image?: CanvasAssetCatalogItem }
  | { kind: 'asset'; source: 'asset-library'; assetId: string; image?: AgentMentionAssetImage }
  | { kind: 'character'; source: 'character-library'; characterId: string; image?: AgentMentionAssetImage }
  | { kind: 'stage-object'; source: 'stage'; nodeId: string; objectId: string }
);
type AgentMentionInput = {
  [Kind in AgentMentionCandidate['kind']]: Omit<Extract<AgentMentionCandidate, { kind: Kind }>, 'token'>;
}[AgentMentionCandidate['kind']];
export interface AgentMentionResolution {
  media: AgentTurnMediaInput[];
  contextLines: string[];
}

/** Scoped canvas/stage candidates only read the active project; assets/characters are workspace-wide. */
export async function listAgentMentionCandidates(input: { scope: AgentScope; projectId?: string }): Promise<AgentMentionCandidate[]> {
  const currentProjectId = useProjectStore.getState().currentProjectId;
  if (input.scope !== 'home' && input.projectId && input.projectId !== currentProjectId) throw new Error('Mention project is no longer active');
  const projectId = input.projectId ?? currentProjectId ?? undefined;
  const [assets] = await Promise.all([listAssets(), useCharacterLibraryStore.getState().initialize()]);
  if (input.scope !== 'home' && useProjectStore.getState().currentProjectId !== currentProjectId) throw new Error('Mention project changed while loading candidates');
  const candidates: AgentMentionCandidate[] = [];
  const add = (candidate: AgentMentionInput) => {
    const label = candidate.label.replace(/[\[\]\r\n]/g, ' ');
    candidates.push({ ...candidate, token: `@[${label}](agent-mention:${encodeURIComponent(candidate.id)})` });
  };
  const durableThumbnail = (source: string | null | undefined) => source && !/^blob:/i.test(source) ? source : undefined;
  const assetImage = (asset: AssetRecord | undefined): AgentMentionAssetImage | undefined => asset?.kind === 'image' && durableThumbnail(asset.source)
    ? { id: asset.id, source: asset.source, nodeId: asset.nodeId } : undefined;
  if (input.scope !== 'home') {
    const nodes = useCanvasStore.getState().nodes;
    const imagesByNode = new Map<string, CanvasAssetCatalogItem>();
    for (const asset of buildCanvasAssetCatalog(nodes)) if (asset.kind === 'image' && !imagesByNode.has(asset.nodeId)) imagesByNode.set(asset.nodeId, asset);
    for (const node of nodes) {
      const label = resolveNodeDisplayName(node.type!, node.data);
      const rawImage = imagesByNode.get(node.id);
      const image = rawImage && durableThumbnail(rawImage.url) ? { ...rawImage, previewUrl: durableThumbnail(rawImage.previewUrl) } : undefined;
      const content = typeof node.data.content === 'string' ? node.data.content : typeof node.data.prompt === 'string' ? node.data.prompt : '';
      add({ id: `node:${projectId ?? 'active'}:${node.id}`, kind: 'node', source: 'canvas', label, projectId, nodeId: node.id, image, imageUnavailable: !!rawImage && !image,
        thumbnail: durableThumbnail(image?.url), context: `Node ${node.id} (${node.type}): ${label}${content ? `\n${content.slice(0, 8_000)}` : ''}` });
      if (input.scope === 'stage' && isBlueprintNode(node)) {
        for (const item of stageCommands.query(node.id).data.items) {
          add({ id: `stage:${projectId ?? 'active'}:${node.id}:${item.id}`, kind: 'stage-object', source: 'stage', label: item.label,
            projectId, nodeId: node.id, objectId: item.id, thumbnail: durableThumbnail(item.refImageUrl),
            context: `Stage ${node.id}, object ${item.id}: ${JSON.stringify({ label: item.label, category: item.category, presetId: item.presetId,
              position: item.pos3d ?? { x: item.x, y: 0, z: item.y }, rotation: item.rotation3d, scale: item.scale3d, action: item.action, note: item.note, relation: item.relation })}` });
        }
      }
    }
  }
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  for (const asset of assets) {
    add({ id: `asset:${asset.id}`, kind: 'asset', source: 'asset-library', label: asset.name, assetId: asset.id, projectId: asset.projectId,
      image: assetImage(asset), imageUnavailable: asset.kind === 'image' && !durableThumbnail(asset.source),
      thumbnail: durableThumbnail(asset.kind === 'image' ? asset.source : asset.previewUrl),
      context: `Asset ${asset.id} (${asset.kind}): ${asset.name}${asset.kind === 'text' ? `\n${asset.source.slice(0, 8_000)}` : ''}` });
  }
  for (const character of useCharacterLibraryStore.getState().characters) {
    const assetId = character.mainImage?.assetId;
    const image = assetId ? assetsById.get(assetId) : undefined;
    add({ id: `character:${character.id}`, kind: 'character', source: 'character-library', label: character.name, characterId: character.id,
      image: assetImage(image), imageUnavailable: image?.kind === 'image' && !durableThumbnail(image.source), thumbnail: durableThumbnail(image?.source),
      context: `Character ${character.id}: ${character.name}${assetId ? `; main image assetId=${assetId}` : ''}${character.tags.length ? `; tags=${character.tags.join(', ')}` : ''}${character.description ? `\n${character.description.slice(0, 8_000)}` : ''}` });
  }
  return candidates;
}

/** Stable tokens survive duplicate labels. Plain @labels resolve only when unambiguous. */
export async function resolveAgentMentions(text: string, candidates: readonly AgentMentionCandidate[]): Promise<AgentMentionResolution> {
  const mentionedIds = new Set<string>();
  for (const match of text.matchAll(/@\[[^\]\r\n]*\]\(agent-mention:([^\s)]+)\)|@\{([^{}\r\n]+)\}/g)) {
    try { mentionedIds.add(match[1] ? decodeURIComponent(match[1]) : match[2]); }
    catch { /* Malformed text is not a stable reference. */ }
  }
  const labelCounts = new Map<string, number>();
  for (const candidate of candidates) labelCounts.set(candidate.label, (labelCounts.get(candidate.label) ?? 0) + 1);
  const media: AgentTurnMediaInput[] = [];
  const contextLines: string[] = [];
  const mediaKeys = new Set<string>();
  const resolvedIds = new Set<string>();
  for (const candidate of candidates) {
    const escaped = candidate.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const plain = labelCounts.get(candidate.label) === 1 && new RegExp(`(?:^|[\\s(（])@${escaped}(?=$|[\\s,，.。!！?？;；)）])`, 'u').test(text);
    if ((!mentionedIds.has(candidate.id) && !plain) || resolvedIds.has(candidate.id)) continue;
    resolvedIds.add(candidate.id);
    contextLines.push(candidate.context);
    if (candidate.imageUnavailable) throw new Error('Mentioned image has no durable source; import it before sending');
    const image = candidate.kind === 'stage-object' ? undefined : candidate.image;
    if (!image) continue;
    const source = 'url' in image ? image.url : image.source;
    if (/^blob:/i.test(source)) throw new Error('Mentioned image has no durable source; import it before sending');
    // The same image may be referenced as a node, library asset and character.
    if (mediaKeys.has(source)) continue;
    mediaKeys.add(source);
    const prepared = await prepareAgentMediaSource(await getAssetPortableSource(source));
    if (candidate.kind === 'node' && 'url' in image) {
      media.push(createAgentCanvasMediaInput({ ...image, url: prepared, previewUrl: null }));
    } else {
      media.push({ assetId: image.id, title: candidate.label, origin: 'upload', source: prepared,
        ...('nodeId' in image && image.nodeId ? { nodeId: image.nodeId } : {}) });
    }
  }
  return { media: validateAgentTurnMediaInputs(media), contextLines };
}
