import { describe, expect, it } from 'vitest';

import { normalizeGenerationNetworkSettings } from './settingsStore';

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
