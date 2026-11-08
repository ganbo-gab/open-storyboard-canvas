// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CANVAS_MOUSE_BINDINGS, TRADITIONAL_CANVAS_MOUSE_BINDINGS, canvasMouseBindingsSchema } from '@/features/settings/canvasMouseSettings';

import {
  normalizeGenerationNetworkSettings,
  agentDefaultSettingsSchema,
  normalizeAgentDefaults,
  resolveAgentDefaults,
  useSettingsStore,
  type CanvasLeftDragMode,
  type CanvasWheelMode,
} from './settingsStore';

const originalSettings = useSettingsStore.getState();
afterEach(() => useSettingsStore.setState(originalSettings, true));

describe('generation network settings', () => {
  it('preserves supported desktop routes and trims proxy URLs', () => {
    expect(normalizeGenerationNetworkSettings({
      route: 'custom-proxy',
      customProxyUrl: '  http://127.0.0.1:7890  ',
    })).toEqual({
      route: 'custom-proxy',
      customProxyUrl: 'http://127.0.0.1:7890',
    });
  });

  it('falls back to system routing for unknown persisted values', () => {
    expect(normalizeGenerationNetworkSettings({
      route: 'socks5',
      customProxyUrl: 123,
    })).toEqual({ route: 'system', customProxyUrl: '' });
  });
});

describe('canvas gesture settings', () => {
  it('defaults to the recommended nine gestures and automatic wheel detection', () => {
    expect(useSettingsStore.getInitialState()).toMatchObject({
      canvasMouseBindings: DEFAULT_CANVAS_MOUSE_BINDINGS, canvasLeftDragMode: 'pan', canvasWheelMode: 'auto',
    });
  });

  it.each(['select', 'pan'] as const)('keeps the legacy left-drag setter synchronized for %s', (mode) => {
    useSettingsStore.getState().setCanvasLeftDragMode(mode);
    expect(useSettingsStore.getState()).toMatchObject({ canvasLeftDragMode: mode,
      canvasMouseBindings: { leftDrag: mode === 'pan' ? 'panCanvas' : 'selectionBox' } });
  });

  it('accepts all nine settings and rejects an action assigned to the wrong gesture atomically', () => {
    const bindings = { ...DEFAULT_CANVAS_MOUSE_BINDINGS, leftDrag: 'none', middleDoubleClick: 'fitView' } as const;
    useSettingsStore.getState().setCanvasMouseBindings(bindings);
    expect(useSettingsStore.getState()).toMatchObject({ canvasMouseBindings: bindings, canvasLeftDragMode: 'select' });
    const invalid = { ...bindings, rightDrag: 'nodeMenu' };
    expect(canvasMouseBindingsSchema.safeParse(invalid).success).toBe(false);
    expect(() => useSettingsStore.getState().setCanvasMouseBindings(invalid as typeof bindings)).toThrow();
    expect(useSettingsStore.getState().canvasMouseBindings).toEqual(bindings);
  });

  it.each(['auto', 'zoom', 'pan'] as const)('sets wheel mode to %s', (mode) => {
    useSettingsStore.getState().setCanvasWheelMode(mode);
    expect(useSettingsStore.getState().canvasWheelMode).toBe(mode);
  });

  it.each([undefined, null, 'invalid', 42, {}, []])('repairs unknown persisted gesture values %j', async (value) => {
    const settings = useSettingsStore.getState();
    settings.setCanvasLeftDragMode(value as CanvasLeftDragMode);
    settings.setCanvasWheelMode(value as CanvasWheelMode);
    expect(useSettingsStore.getState()).toMatchObject({ canvasLeftDragMode: 'select', canvasWheelMode: 'auto' });
    const migrated = await useSettingsStore.persist.getOptions().migrate!({ canvasLeftDragMode: value, canvasWheelMode: value }, 25);
    expect(migrated).toMatchObject({ canvasMouseBindings: DEFAULT_CANVAS_MOUSE_BINDINGS, canvasLeftDragMode: 'pan', canvasWheelMode: 'auto' });
  });

  it.each(['default', 'traditional'] as const)('migrates v0.1.27 preset %s with its original six gestures', async (preset) => {
    const migrated = await useSettingsStore.persist.getOptions().migrate!({ canvasMouseBindingPreset: preset }, 21);
    expect(migrated).toMatchObject({ canvasMouseBindings: preset === 'traditional'
      ? TRADITIONAL_CANVAS_MOUSE_BINDINGS : { ...DEFAULT_CANVAS_MOUSE_BINDINGS, middleDrag: 'none' } });
    expect(migrated).not.toHaveProperty('canvasMouseBindingPreset');
  });

  it.each([{}, { grsai: 'configured-key' }])('migrates custom legacy slots for API keys %j without discarding preferences', async (apiKeys) => {
    const migrated = await useSettingsStore.persist.getOptions().migrate!({ apiKeys, canvasMouseBindingPreset: 'custom',
      canvasMouseBindings: { leftDrag: 'panCanvas', rightDrag: 'none', middleClick: 'nodeMenu', leftClick: 'unsupported' } }, 21);
    expect(migrated).toMatchObject({ canvasLeftDragMode: 'pan', canvasWheelMode: 'auto', canvasMouseBindings: {
      ...DEFAULT_CANVAS_MOUSE_BINDINGS, leftClick: 'selectNode', rightDrag: 'none', middleClick: 'nodeMenu', middleDrag: 'none',
    } });
    expect(migrated).not.toHaveProperty('canvasMouseBindingPreset');
  });

  it.each([
    ['select', 'auto'], ['pan', 'zoom'], ['pan', 'pan'],
  ] as const)('preserves v0.2.0 choices %s / %s and its right-drag panning', async (canvasLeftDragMode, canvasWheelMode) => {
    const migrated = await useSettingsStore.persist.getOptions().migrate!({ canvasLeftDragMode, canvasWheelMode }, 25);
    expect(migrated).toMatchObject({ canvasLeftDragMode, canvasWheelMode,
      canvasMouseBindings: { leftDrag: canvasLeftDragMode === 'pan' ? 'panCanvas' : 'selectionBox', rightDrag: 'panCanvas' } });
  });

  it('makes modern bindings authoritative over stale aliases and repairs same-version hydration per slot', () => {
    const merge = useSettingsStore.persist.getOptions().merge!;
    const bindings = { ...DEFAULT_CANVAS_MOUSE_BINDINGS, leftDrag: 'none', rightDoubleClick: 'fitView' } as const;
    expect(merge({ canvasMouseBindings: bindings, canvasMouseBindingPreset: 'traditional', canvasLeftDragMode: 'pan' }, originalSettings))
      .toMatchObject({ canvasMouseBindings: bindings, canvasLeftDragMode: 'select' });
    expect(merge({ canvasMouseBindings: { ...bindings, rightDrag: 'nodeMenu' }, canvasWheelMode: 'broken' }, originalSettings))
      .toMatchObject({ canvasMouseBindings: { ...bindings, rightDrag: 'selectionBox' }, canvasWheelMode: 'auto' });
  });

  it('keeps current gestures when same-version persisted data has no binding fields', () => {
    const bindings = { ...DEFAULT_CANVAS_MOUSE_BINDINGS, rightDoubleClick: 'fitView' } as const;
    const current = { ...originalSettings, canvasMouseBindings: bindings, canvasWheelMode: 'pan' } as const;
    expect(useSettingsStore.persist.getOptions().merge!({ canvasWheelMode: 'zoom' }, current))
      .toMatchObject({ canvasMouseBindings: bindings, canvasWheelMode: 'zoom' });
  });
});

describe('global Agent defaults', () => {
  it('hydrates legacy, partial and malformed persisted values with safe deterministic defaults', async () => {
    const migrate = useSettingsStore.persist.getOptions().migrate!;
    expect(await migrate({}, 23)).toMatchObject({ agentDefaults: { modelId: null, executionMode: 'manual' } });
    expect(normalizeAgentDefaults({ modelId: ' custom:provider:model ', executionMode: 'invalid' }))
      .toEqual({ modelId: 'custom:provider:model', executionMode: 'manual' });
    expect(normalizeAgentDefaults({ modelId: 42, executionMode: 'auto' })).toEqual({ modelId: null, executionMode: 'auto' });
    const merge = useSettingsStore.persist.getOptions().merge!;
    expect(merge({ agentDefaults: { modelId: [], executionMode: true } }, useSettingsStore.getInitialState()))
      .toMatchObject({ agentDefaults: { modelId: null, executionMode: 'manual' } });
    expect(await migrate({ apiKeys: { provider: 'configured' }, agentDefaults: { modelId: 'model', executionMode: 'auto' } }, 23))
      .toMatchObject({ agentDefaults: { modelId: 'model', executionMode: 'auto' } });
  });

  it('keeps per-conversation overrides while new conversations inherit the latest global choices', () => {
    useSettingsStore.getState().setAgentDefaults({ modelId: 'global-model', executionMode: 'auto' });
    expect(resolveAgentDefaults()).toEqual({ modelId: 'global-model', executionMode: 'auto' });
    expect(resolveAgentDefaults({ modelId: 'conversation-model', executionMode: 'manual' }))
      .toEqual({ modelId: 'conversation-model', executionMode: 'manual' });
    useSettingsStore.getState().setAgentDefaults({ modelId: 'new-default' });
    expect(resolveAgentDefaults({ modelId: 'conversation-model' })).toEqual({ modelId: 'conversation-model', executionMode: 'auto' });
    expect(resolveAgentDefaults({ modelId: null })).toEqual({ modelId: null, executionMode: 'auto' });
    expect(resolveAgentDefaults()).toEqual({ modelId: 'new-default', executionMode: 'auto' });
  });

  it('rejects malformed settings updates rather than widening approval modes or changing unrelated fields', () => {
    const before = useSettingsStore.getState().agentDefaults;
    expect(agentDefaultSettingsSchema.safeParse({ modelId: '', executionMode: 'auto' }).success).toBe(false);
    expect(agentDefaultSettingsSchema.safeParse({ modelId: null, executionMode: 'automatic' }).success).toBe(false);
    expect(agentDefaultSettingsSchema.safeParse({ modelId: null, executionMode: 'manual', bypassApproval: true }).success).toBe(false);
    expect(useSettingsStore.getState().agentDefaults).toEqual(before);
  });
});

it('drops retired audio settings from both migrations and same-version hydration', async () => {
  const legacy = { audioGenerationSettings: { apiBaseUrl: 'http://old.invalid', models: [{ id: 'local-doubao-tts', enabled: true }] }, promptPresets: [{ id: 'keep', name: 'Keep', prompt: 'Preserve other settings', createdAt: 1, updatedAt: 1 }] };
  const options = useSettingsStore.persist.getOptions();
  const migrated = await options.migrate!(legacy, 24);
  expect(migrated).not.toHaveProperty('audioGenerationSettings');
  expect(migrated).toMatchObject({ promptPresets: legacy.promptPresets });
  const restored = options.merge!(legacy, useSettingsStore.getInitialState());
  expect(restored).not.toHaveProperty('audioGenerationSettings');
  expect(restored).toMatchObject({ promptPresets: legacy.promptPresets });
  expect(useSettingsStore.getInitialState()).not.toHaveProperty('audioGenerationSettings');
});
