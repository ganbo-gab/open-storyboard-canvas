// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { CatalogEntry } from '../application/modelCatalog';
import { useSettingsStore } from '@/stores/settingsStore';
import { ModelConfigPicker } from './ModelConfigPicker';

const fixtures = vi.hoisted(() => ({ catalog: [] as CatalogEntry[] }));
vi.mock('../application/modelCatalog', () => ({ useImageModelCatalog: () => fixtures.catalog, formatRatio: (ratio: string) => ratio }));
beforeEach(() => {
  fixtures.catalog = [{ id: 'custom:available:image', providerId: 'available', providerLabel: 'Available provider', modelId: 'image', modelLabel: 'Available image',
    kind: 'custom', usable: true, supportedRatios: ['auto', '16:9'] }];
  useSettingsStore.setState({ lastModelConfigByPanel: {} });
});
afterEach(cleanup);

it('does not overwrite or display another provider for an unavailable saved selection', () => {
  const selected = { entryId: 'custom:removed:image', ratio: '9:16', extraParams: { size: '576x1024' } };
  useSettingsStore.setState({ lastModelConfigByPanel: { lighting: selected } });
  render(<ModelConfigPicker panelKey="lighting" />);
  expect(useSettingsStore.getState().lastModelConfigByPanel?.lighting).toEqual(selected);
  expect(screen.queryByText('Available provider')).toBeNull();
  expect(screen.queryByText('Available image')).toBeNull();
});

it('initializes a default only when the panel has no saved selection', async () => {
  render(<ModelConfigPicker panelKey="lighting" />);
  await waitFor(() => expect(useSettingsStore.getState().lastModelConfigByPanel?.lighting).toEqual({ entryId: 'custom:available:image', ratio: 'auto' }));
  expect(screen.getByText('Available provider')).toBeTruthy();
});
