import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeMocks = vi.hoisted(() => ({
  isTauri: vi.fn<() => boolean>(),
  getCurrentWindow: vi.fn(),
  changeLanguage: vi.fn(),
  toggleTheme: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: runtimeMocks.isTauri,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: runtimeMocks.getCurrentWindow,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: {
      language: 'zh',
      changeLanguage: runtimeMocks.changeLanguage,
    },
  }),
}));

vi.mock('@/stores/themeStore', () => ({
  useThemeStore: () => ({
    theme: 'dark',
    toggleTheme: runtimeMocks.toggleTheme,
  }),
}));

vi.mock('@/stores/projectStore', () => ({
  useProjectStore: <T,>(selector: (state: { currentProject: null }) => T): T =>
    selector({ currentProject: null }),
}));

import { TitleBar } from './TitleBar';

describe('TitleBar runtime capabilities', () => {
  beforeEach(() => {
    runtimeMocks.isTauri.mockReset();
    runtimeMocks.getCurrentWindow.mockReset();
  });

  it('renders in a browser without resolving a Tauri window or desktop controls', () => {
    runtimeMocks.isTauri.mockReturnValue(false);
    runtimeMocks.getCurrentWindow.mockImplementation(() => {
      throw new Error('getCurrentWindow must not run in a browser');
    });

    const html = renderToStaticMarkup(<TitleBar onSettingsClick={() => {}} />);

    expect(runtimeMocks.getCurrentWindow).not.toHaveBeenCalled();
    expect(html).not.toContain('titleBar.minimize');
    expect(html).not.toContain('titleBar.maximize');
    expect(html).not.toContain('titleBar.close');
  });

  it('keeps desktop controls available in Tauri', () => {
    runtimeMocks.isTauri.mockReturnValue(true);
    runtimeMocks.getCurrentWindow.mockReturnValue({
      minimize: vi.fn(),
      isMaximized: vi.fn(),
      unmaximize: vi.fn(),
      maximize: vi.fn(),
      close: vi.fn(),
      startDragging: vi.fn(),
    });

    const html = renderToStaticMarkup(<TitleBar onSettingsClick={() => {}} />);

    expect(runtimeMocks.getCurrentWindow).toHaveBeenCalledTimes(1);
    const mac = /(Mac|iPhone|iPad|iPod)/i.test(`${navigator.platform} ${navigator.userAgent}`);
    if (mac) { expect(html).toContain('w-[82px]'); expect(html).not.toContain('titleBar.close'); }
    else { expect(html).toContain('titleBar.minimize'); expect(html).toContain('titleBar.maximize'); expect(html).toContain('titleBar.close'); }
  });

});
