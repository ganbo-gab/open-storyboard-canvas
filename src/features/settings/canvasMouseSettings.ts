import { z } from 'zod';

export const canvasMouseClickActionSchema = z.enum(['selectNode', 'nodeMenu', 'quickCreate', 'fitView', 'none']);
export const canvasMouseDragActionSchema = z.enum(['panCanvas', 'selectionBox', 'none']);
export const canvasMouseBindingPresetSchema = z.enum(['default', 'traditional', 'custom']);
export const canvasWheelModeSchema = z.enum(['auto', 'zoom', 'pan']);
export const canvasLeftDragModeSchema = z.enum(['select', 'pan']);

export const canvasMouseBindingsSchema = z.object({
  leftClick: canvasMouseClickActionSchema,
  leftDoubleClick: canvasMouseClickActionSchema,
  leftDrag: canvasMouseDragActionSchema,
  rightClick: canvasMouseClickActionSchema,
  rightDoubleClick: canvasMouseClickActionSchema,
  rightDrag: canvasMouseDragActionSchema,
  middleClick: canvasMouseClickActionSchema,
  middleDoubleClick: canvasMouseClickActionSchema,
  middleDrag: canvasMouseDragActionSchema,
}).strict();

export type CanvasMouseBindings = z.infer<typeof canvasMouseBindingsSchema>;
export type CanvasMouseBindingSlot = keyof CanvasMouseBindings;
export type CanvasMouseClickAction = z.infer<typeof canvasMouseClickActionSchema>;
export type CanvasMouseDragAction = z.infer<typeof canvasMouseDragActionSchema>;
export type CanvasMouseAction = CanvasMouseClickAction | CanvasMouseDragAction;
export type CanvasMouseBindingPreset = z.infer<typeof canvasMouseBindingPresetSchema>;
export type CanvasWheelMode = z.infer<typeof canvasWheelModeSchema>;
export type CanvasLeftDragMode = z.infer<typeof canvasLeftDragModeSchema>;

export const DEFAULT_CANVAS_MOUSE_BINDINGS: CanvasMouseBindings = {
  leftClick: 'selectNode', leftDoubleClick: 'quickCreate', leftDrag: 'panCanvas',
  rightClick: 'nodeMenu', rightDoubleClick: 'none', rightDrag: 'selectionBox',
  middleClick: 'none', middleDoubleClick: 'none', middleDrag: 'panCanvas',
};
export const TRADITIONAL_CANVAS_MOUSE_BINDINGS: CanvasMouseBindings = {
  ...DEFAULT_CANVAS_MOUSE_BINDINGS, leftDrag: 'selectionBox', rightDrag: 'none',
};
const LEGACY_DEFAULT_BINDINGS: CanvasMouseBindings = {
  ...DEFAULT_CANVAS_MOUSE_BINDINGS, middleDrag: 'none',
};
const legacyMouseActionSchema = z.enum(['none', 'selectNode', 'panCanvas', 'selectionBox', 'nodeMenu']);
export const legacyCanvasMouseBindingsSchema = z.object({
  leftClick: legacyMouseActionSchema.optional(), leftDrag: legacyMouseActionSchema.optional(),
  rightClick: legacyMouseActionSchema.optional(), rightDrag: legacyMouseActionSchema.optional(),
  middleClick: legacyMouseActionSchema.optional(), middleDrag: legacyMouseActionSchema.optional(),
}).strict();

export function hasModernCanvasMouseBindings(value: unknown): boolean {
  const parsed = bindingInputSchema.safeParse(value);
  return parsed.success && ['leftDoubleClick', 'rightDoubleClick', 'middleDoubleClick'].some((slot) => Object.hasOwn(parsed.data, slot));
}

const bindingInputSchema = z.object(Object.fromEntries(
  Object.keys(canvasMouseBindingsSchema.shape).map((key) => [key, z.unknown().optional()]),
));
const preferencesInputSchema = z.object({
  canvasMouseBindings: z.unknown().optional(),
  canvasMouseBindingPreset: z.unknown().optional(),
  canvasLeftDragMode: z.unknown().optional(),
  canvasWheelMode: z.unknown().optional(),
});

/** Persistence repairs individual invalid slots without discarding the user's other choices. */
export function normalizeCanvasMouseBindings(value: unknown, fallback: CanvasMouseBindings = DEFAULT_CANVAS_MOUSE_BINDINGS): CanvasMouseBindings {
  const parsed = bindingInputSchema.safeParse(value);
  const raw = parsed.success ? parsed.data : {};
  return canvasMouseBindingsSchema.parse(Object.fromEntries(
    Object.entries(canvasMouseBindingsSchema.shape).map(([slot, schema]) => {
      const result = schema.safeParse(raw[slot]);
      return [slot, result.success ? result.data : fallback[slot as CanvasMouseBindingSlot]];
    }),
  ));
}

/** canvasLeftDragMode remains a compatibility mirror; bindings are the runtime authority. */
export function canvasLeftDragModeForBindings(bindings: CanvasMouseBindings): CanvasLeftDragMode {
  return bindings.leftDrag === 'panCanvas' ? 'pan' : 'select';
}

/** Converts v0.1.27's six slots and v0.2.0's two controls before retiring their aliases. */
export function normalizeCanvasMousePreferences(value: unknown): {
  canvasMouseBindings: CanvasMouseBindings; canvasLeftDragMode: CanvasLeftDragMode; canvasWheelMode: CanvasWheelMode;
} {
  const parsed = preferencesInputSchema.safeParse(value);
  const raw = parsed.success ? parsed.data : {};
  const inputBindings = bindingInputSchema.safeParse(raw.canvasMouseBindings);
  const slots = inputBindings.success ? inputBindings.data : {};
  const modern = hasModernCanvasMouseBindings(raw.canvasMouseBindings);
  const preset = canvasMouseBindingPresetSchema.safeParse(raw.canvasMouseBindingPreset);
  const leftDrag = canvasLeftDragModeSchema.safeParse(raw.canvasLeftDragMode);
  let canvasMouseBindings: CanvasMouseBindings;
  if (modern) {
    canvasMouseBindings = normalizeCanvasMouseBindings(raw.canvasMouseBindings);
  } else if (preset.success || Object.keys(slots).length > 0) {
    const fallback = preset.success && preset.data === 'traditional' ? TRADITIONAL_CANVAS_MOUSE_BINDINGS : LEGACY_DEFAULT_BINDINGS;
    canvasMouseBindings = preset.success && preset.data !== 'custom' ? { ...fallback }
      : normalizeCanvasMouseBindings(raw.canvasMouseBindings, fallback);
  } else if (leftDrag.success) {
    // Existing v0.2.0 users keep right-drag panning until they choose the recommended preset.
    canvasMouseBindings = { ...DEFAULT_CANVAS_MOUSE_BINDINGS, leftDrag: leftDrag.data === 'pan' ? 'panCanvas' : 'selectionBox', rightDrag: 'panCanvas' };
  } else {
    canvasMouseBindings = { ...DEFAULT_CANVAS_MOUSE_BINDINGS };
  }
  const wheel = canvasWheelModeSchema.safeParse(raw.canvasWheelMode);
  return { canvasMouseBindings, canvasLeftDragMode: canvasLeftDragModeForBindings(canvasMouseBindings), canvasWheelMode: wheel.success ? wheel.data : 'auto' };
}

export function canvasMousePreset(bindings: CanvasMouseBindings): CanvasMouseBindingPreset {
  const matches = (preset: CanvasMouseBindings) => Object.keys(canvasMouseBindingsSchema.shape)
    .every((slot) => bindings[slot as CanvasMouseBindingSlot] === preset[slot as CanvasMouseBindingSlot]);
  return matches(DEFAULT_CANVAS_MOUSE_BINDINGS) ? 'default' : matches(TRADITIONAL_CANVAS_MOUSE_BINDINGS) ? 'traditional' : 'custom';
}
