import { z } from 'zod';
import type { CanvasEdge, CanvasNode } from '../domain/canvasNodes';
import { isAiAudioNode, isAiTextNode, isAiVideoNode, isImageEditNode, isStoryboardGenNode } from '../domain/canvasNodes';
import { collectInputReferences, type GraphReferenceItem } from './graphReferenceResolver';

export interface ReferenceIdentity {
  kind: GraphReferenceItem['kind'];
  sourceNodeId: string;
  sourceItemId?: string;
  viaTagNodeId?: string;
}
export type ReferencePromptTarget = { kind: 'prompt' } | { kind: 'storyboardFrame'; frameId: string };
export interface NodeReferenceRemoval {
  nodeId: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  edgeIds: string[];
  removed: GraphReferenceItem[];
  prompt: string;
}
const slotsSchema = z.record(z.string(), z.array(z.string()));

/** Labels are positional; media identity must survive a disconnected edge and renumbering. */
export function referenceIdentityKey(reference: ReferenceIdentity): string {
  return JSON.stringify([reference.kind, reference.sourceNodeId, reference.sourceItemId ?? null, reference.viaTagNodeId ?? null]);
}

function remapPrompt(prompt: string, before: GraphReferenceItem[], after: GraphReferenceItem[]): string {
  const replacements = new Map<string, string>();
  const remaining = new Map(after.map(reference => [referenceIdentityKey(reference), reference.token]));
  const addReplacement = (token: string, next: string) => replacements.set(token,
    replacements.has(token) && replacements.get(token) !== next ? '' : next);
  for (const reference of before) {
    const next = remaining.get(referenceIdentityKey(reference)) ?? '';
    // A tag may have the same visible name as another reference. Never guess its target.
    addReplacement(reference.token, next);
  }
  const groups = new Map<string, GraphReferenceItem[]>();
  for (const reference of before) {
    if (reference.groupToken) groups.set(reference.groupToken, [...(groups.get(reference.groupToken) ?? []), reference]);
  }
  for (const [token, references] of groups) {
    addReplacement(token, references.flatMap(reference => {
      const next = remaining.get(referenceIdentityKey(reference));
      return next ? [next] : [];
    }).join('、'));
  }
  const tokens = [...replacements.keys()].sort((left, right) => right.length - left.length);
  if (!tokens.length) return prompt;
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = tokens.map(token => `${escape(token.slice(1))}${/\d$/.test(token) ? '(?![0-9])' : ''}`).join('|');
  // Legacy group mentions use their surviving members. Replacements run once, so old
  // @图2 -> @图1 cannot be deleted by old @图1's replacement.
  return prompt.replace(new RegExp(`[@＠]+(?:${pattern})`, 'g'), token => replacements.get(`@${token.replace(/^[@＠]+/, '')}`) ?? token);
}

function mediaSources(reference: GraphReferenceItem): string[] {
  return [reference.imageUrl, reference.previewImageUrl, reference.videoUrl, reference.audioUrl]
    .filter((source): source is string => typeof source === 'string' && source.length > 0);
}

/**
 * Cut consumer-side edges only. A tag/group/multi-frame edge is indivisible: callers confirm
 * when the plan removes several references, rather than modifying a shared source/group.
 * Kept URLs retain their slot assignments even if an alias with the same URL was removed.
 */
export function planNodeReferenceRemoval(input: {
  nodeId: string;
  reference: ReferenceIdentity;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  prompt: string;
  promptTarget?: ReferencePromptTarget;
}): NodeReferenceRemoval | null {
  const { nodeId, nodes, edges, prompt, promptTarget = { kind: 'prompt' } } = input;
  const target = nodes.find(node => node.id === nodeId);
  if (!target) return null;
  if (promptTarget.kind === 'storyboardFrame') {
    if (!isStoryboardGenNode(target) || !target.data.frames.some(frame => frame.id === promptTarget.frameId)) return null;
  } else if (!isImageEditNode(target) && !isAiVideoNode(target) && !isAiAudioNode(target) && !isAiTextNode(target)) return null;
  const before = collectInputReferences(nodeId, nodes, edges);
  const requested = referenceIdentityKey(input.reference);
  if (!before.some(reference => referenceIdentityKey(reference) === requested)) return null;
  const edgeIds = edges.filter(edge => edge.target === nodeId
    && collectInputReferences(nodeId, nodes, edges.filter(candidate => candidate.target !== nodeId || candidate.id === edge.id))
      .some(reference => referenceIdentityKey(reference) === requested))
    .map(edge => edge.id);
  if (!edgeIds.length) return null;
  const nextEdges = edges.filter(edge => !edgeIds.includes(edge.id));
  const after = collectInputReferences(nodeId, nodes, nextEdges);
  const remainingKeys = new Set(after.map(referenceIdentityKey));
  const removed = before.filter(reference => !remainingKeys.has(referenceIdentityKey(reference)));
  const nextPrompt = remapPrompt(prompt, before, after);
  const slots = slotsSchema.safeParse(target.data.referenceSlots);
  const retainedSources = new Set(after.flatMap(mediaSources));
  const removedSources = new Set(removed.flatMap(mediaSources).filter(source => !retainedSources.has(source)));
  const referenceSlots = slots.success ? Object.fromEntries(Object.entries(slots.data).map(([slot, sources]) => [slot, sources.filter(source => !removedSources.has(source))])) : undefined;
  const slotPatch = slots.success ? { referenceSlots } : {};
  const updated: CanvasNode = isStoryboardGenNode(target) && promptTarget.kind === 'storyboardFrame'
    ? { ...target, data: { ...target.data, ...slotPatch, frames: target.data.frames.map(frame => ({ ...frame,
      description: frame.id === promptTarget.frameId ? nextPrompt : remapPrompt(frame.description, before, after),
    })) } }
    : { ...target, data: { ...target.data, ...slotPatch, prompt: nextPrompt } };
  return {
    nodeId, edges: nextEdges, edgeIds, removed, prompt: nextPrompt,
    nodes: nodes.map(node => node.id === nodeId ? updated : node),
  };
}
