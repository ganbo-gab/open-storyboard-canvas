import { z } from 'zod';

const toolbar = z.object({
  limit: z.number().int().min(0).max(12).catch(5),
  pinned: z.array(z.string().min(1)).max(64).catch([]),
  hidden: z.array(z.string().min(1)).max(64).catch([]),
});
export const workspacePreferencesSchema = z.object({
  nodeToolbar: toolbar.catch({ limit: 5, pinned: ['edit', 'multiAngle', 'preview', 'download', 'generationDetails'], hidden: [] }),
  canvasRail: toolbar.catch({ limit: 4, pinned: ['create', 'stage', 'assets', 'history'], hidden: [] }),
  resizePanels: z.boolean().catch(true),
  sidebarWidths: z.record(z.string(), z.number().min(120).max(960)).catch({}),
  panelSizes: z.record(z.string(), z.object({ width: z.number().min(240).max(2400), height: z.number().min(160).max(1800) })).catch({}),
});
export type WorkspacePreferences = z.infer<typeof workspacePreferencesSchema>;
export function normalizeWorkspacePreferences(value: unknown): WorkspacePreferences {
  const result = workspacePreferencesSchema.safeParse(value ?? {});
  return result.success ? result.data : workspacePreferencesSchema.parse({});
}

export function arrangeToolbarItems<T extends { id: string }>(items: readonly T[], config: WorkspacePreferences['nodeToolbar']): { visible: T[]; more: T[] } {
  const ordered = [...config.pinned.flatMap((id) => items.filter((item) => item.id === id)), ...items.filter((item) => !config.pinned.includes(item.id))];
  const unique = ordered.filter((item, index) => ordered.findIndex((other) => other.id === item.id) === index);
  const visible = unique.filter((item) => !config.hidden.includes(item.id)).slice(0, config.limit);
  return { visible, more: unique.filter((item) => !visible.includes(item)) };
}
