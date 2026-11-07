// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

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
  it('defaults to marquee selection and automatic wheel detection', () => {
    expect(useSettingsStore.getInitialState()).toMatchObject({
      canvasLeftDragMode: 'select',
      canvasWheelMode: 'auto',
    });
  });

  it.each(['select', 'pan'] as const)('sets left-drag mode to %s', (mode) => {
    useSettingsStore.getState().setCanvasLeftDragMode(mode);
    expect(useSettingsStore.getState().canvasLeftDragMode).toBe(mode);
  });

  it.each(['auto', 'zoom', 'pan'] as const)('sets wheel mode to %s', (mode) => {
    useSettingsStore.getState().setCanvasWheelMode(mode);
    expect(useSettingsStore.getState().canvasWheelMode).toBe(mode);
  });

  it.each([undefined, null, 'invalid', 42, {}, []])('normalizes unknown gesture values %j', async (value) => {
    const settings = useSettingsStore.getState();
    settings.setCanvasLeftDragMode(value as CanvasLeftDragMode);
    settings.setCanvasWheelMode(value as CanvasWheelMode);
    expect(useSettingsStore.getState()).toMatchObject({ canvasLeftDragMode: 'select', canvasWheelMode: 'auto' });

    const migrate = useSettingsStore.persist.getOptions().migrate!;
    const migrated = await migrate({ canvasLeftDragMode: value, canvasWheelMode: value }, 21);
    expect(migrated).toMatchObject({ canvasLeftDragMode: 'select', canvasWheelMode: 'auto' });
  });

  it.each([{}, { grsai: 'configured-key' }])('drops retired controls without mapping them for API keys %j', async (apiKeys) => {
    const legacyPrefix = 'canvasMouse';
    const legacyFields = {
      [`${legacyPrefix}BindingPreset`]: 'custom',
      [`${legacyPrefix}Bindings`]: { leftDrag: 'panCanvas' },
    };
    const migrate = useSettingsStore.persist.getOptions().migrate!;
    const migrated = await migrate({ apiKeys, ...legacyFields }, 21);
    expect(migrated).toMatchObject({ canvasLeftDragMode: 'select', canvasWheelMode: 'auto' });
    expect(Object.keys(migrated as object).some((key) => /^canvasMouse/.test(key))).toBe(false);
  });

  it.each([
    ['select', 'auto'],
    ['pan', 'zoom'],
    ['pan', 'pan'],
  ] as const)('preserves persisted gesture choices %s / %s', async (canvasLeftDragMode, canvasWheelMode) => {
    const migrate = useSettingsStore.persist.getOptions().migrate!;
    const migrated = await migrate({ canvasLeftDragMode, canvasWheelMode }, 21);
    expect(migrated).toMatchObject({ canvasLeftDragMode, canvasWheelMode });
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
