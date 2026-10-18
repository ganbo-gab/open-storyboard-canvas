// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import {
  normalizeGenerationNetworkSettings,
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
