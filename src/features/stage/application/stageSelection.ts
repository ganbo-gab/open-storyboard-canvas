import { z } from 'zod';
import type { BlueprintItem } from '@/features/canvas/domain/canvasNodes';
import { stageItemSchema } from '../domain/stageSchemas';

const itemIds = z.array(z.string().trim().min(1).max(300)).max(100);
export const stageSelectionChangeSchema = z.object({
  itemIds,
  mode: z.enum(['replace', 'add', 'toggle', 'remove']),
  source: z.enum(['viewport', 'timeline', 'outliner']),
}).strict();
export const stageSelectionOperationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('update'), patch: stageItemSchema.omit({ id: true }).partial() }).strict(),
  z.object({ type: z.literal('remove') }).strict(),
]);
export type StageSelectionChange = z.infer<typeof stageSelectionChangeSchema>;
export type StageSelectionOperation = z.infer<typeof stageSelectionOperationSchema>;
export interface StageSelection { itemIds: string[]; primaryItemId: string | null }

/**
 * One transient selection shared by viewport, timeline and outliner. The caller owns
 * this value; it is neither another document store nor an undoable graph mutation.
 * Only the outliner may newly select hidden/locked objects. Missing old ids are pruned.
 */
export function resolveStageSelection(items: readonly BlueprintItem[], current: readonly string[], input: StageSelectionChange): StageSelection {
  const change = stageSelectionChangeSchema.parse(input);
  const byId = new Map(items.map((item) => [item.id, item]));
  const requested = [...new Set(change.itemIds)].filter((id) => {
    const item = byId.get(id);
    if (!item) throw new Error(`Stage object ${id} does not exist.`);
    return change.mode === 'remove' || change.source === 'outliner' || (item.hidden !== true && item.locked !== true);
  });
  let selected = [...new Set(current)].filter((id) => byId.has(id));
  if (change.mode === 'replace') selected = requested;
  if (change.mode === 'add') selected = [...new Set([...selected, ...requested])];
  if (change.mode === 'remove') selected = selected.filter((id) => !requested.includes(id));
  if (change.mode === 'toggle') {
    for (const id of requested) selected = selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id];
  }
  return { itemIds: selected, primaryItemId: selected[selected.length - 1] ?? null };
}

export function parseStageSelectionTargets(input: readonly string[]): string[] {
  return [...new Set(itemIds.min(1).parse(input))];
}
