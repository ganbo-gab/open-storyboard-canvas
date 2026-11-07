// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => {
  const state = { maximized: false, fullscreen: false };
  const resize = { callback: () => {} };
  return { state, resize, translate: (key: string) => key, i18n: { language: 'zh', changeLanguage: vi.fn() },
    window: {
      isMaximized: vi.fn(async () => state.maximized), isFullscreen: vi.fn(async () => state.fullscreen),
      maximize: vi.fn(async () => { state.maximized = true; resize.callback(); }),
      unmaximize: vi.fn(async () => { state.maximized = false; resize.callback(); }),
      setFullscreen: vi.fn(async (value: boolean) => { state.fullscreen = value; resize.callback(); }),
      minimize: vi.fn(async () => {}), close: vi.fn(async () => {}), startDragging: vi.fn(async () => {}),
      onResized: vi.fn(async (callback: () => void) => { resize.callback = callback; return () => { resize.callback = () => {}; }; }),
    },
  };
});
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => native.window }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: native.translate, i18n: native.i18n }) }));
vi.mock('@/stores/themeStore', () => ({ useThemeStore: () => ({ theme: 'dark', toggleTheme: vi.fn() }) }));
vi.mock('@/stores/projectStore', () => ({ useProjectStore: <T,>(selector: (state: { currentProjectId: null; currentProject: null; renameProject: () => void }) => T) => selector({ currentProjectId: null, currentProject: null, renameProject: () => {} }) }));

import { TitleBar } from './TitleBar';

beforeEach(() => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' });
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Windows test' });
  native.state.maximized = false; native.state.fullscreen = false;
  vi.clearAllMocks();
});
afterEach(cleanup);
async function mount() { await act(async () => { render(<TitleBar onSettingsClick={() => {}} />); }); }

describe('Windows titlebar simulated native events', () => {
  it('toggles maximize/restore and synchronizes external resized state', async () => {
    await mount();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'titleBar.maximize' })));
    expect(native.window.maximize).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'titleBar.restore' })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'titleBar.restore' })));
    expect(native.window.unmaximize).toHaveBeenCalledOnce();
    await act(async () => { native.state.maximized = true; native.resize.callback(); });
    expect(screen.getByRole('button', { name: 'titleBar.restore' })).toBeTruthy();
  });

  it('toggles F11 fullscreen, ignores repeat, and labels fullscreen exit as restore', async () => {
    await mount();
    await act(async () => fireEvent.keyDown(window, { key: 'F11' }));
    expect(native.window.setFullscreen).toHaveBeenCalledExactlyOnceWith(true);
    expect(screen.getByRole('button', { name: 'titleBar.restore' })).toBeTruthy();
    await act(async () => fireEvent.keyDown(window, { key: 'F11', repeat: true }));
    expect(native.window.setFullscreen).toHaveBeenCalledOnce();
    await act(async () => fireEvent.keyDown(window, { key: 'F11' }));
    expect(native.window.setFullscreen).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('button', { name: 'titleBar.maximize' })).toBeTruthy();
  });

  it('drags only empty titlebar space and double-clicks once without dragging the second click', async () => {
    await mount();
    const title = screen.getByText('app.title');
    await act(async () => fireEvent.mouseDown(title, { button: 0, detail: 1 }));
    expect(native.window.startDragging).toHaveBeenCalledOnce();
    await act(async () => { fireEvent.mouseDown(title, { button: 0, detail: 2 }); fireEvent.doubleClick(title); });
    expect(native.window.startDragging).toHaveBeenCalledOnce();
    expect(native.window.maximize).toHaveBeenCalledOnce();
    const surface = title.parentElement;
    if (!surface) throw new Error('missing drag surface');
    for (const tag of ['button', 'input', 'textarea', 'select', 'a']) {
      const control = document.createElement(tag); surface.appendChild(control);
      await act(async () => { fireEvent.mouseDown(control, { button: 0, detail: 1 }); fireEvent.doubleClick(control); });
      control.remove();
    }
    expect(native.window.startDragging).toHaveBeenCalledOnce();
    expect(native.window.maximize).toHaveBeenCalledOnce();
    expect(native.window.unmaximize).not.toHaveBeenCalled();
  });

  it('rejects a late initial state read after a newer resized event', async () => {
    const old = Promise.withResolvers<boolean>();
    native.window.isMaximized.mockReturnValueOnce(old.promise);
    await mount();
    await act(async () => { native.state.maximized = true; native.resize.callback(); });
    expect(screen.getByRole('button', { name: 'titleBar.restore' })).toBeTruthy();
    await act(async () => { old.resolve(false); });
    expect(screen.getByRole('button', { name: 'titleBar.restore' })).toBeTruthy();
  });

  it('removes native event and F11 handling on unmount', async () => {
    await mount(); cleanup();
    await act(async () => fireEvent.keyDown(window, { key: 'F11' }));
    expect(native.window.setFullscreen).not.toHaveBeenCalled();
  });

  it('serializes rapid resize intents and releases the guard after a failed action', async () => {
    await mount();
    const pending = Promise.withResolvers<void>();
    native.window.maximize.mockImplementationOnce(() => pending.promise);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'titleBar.maximize' }));
      fireEvent.click(screen.getByRole('button', { name: 'titleBar.maximize' }));
    });
    expect(native.window.maximize).toHaveBeenCalledOnce();
    await act(async () => { pending.reject(new Error('native failure')); });
    expect(screen.getByRole('alert').textContent).toBe('titleBar.resizeFailed');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'titleBar.maximize' })));
    expect(native.window.maximize).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'titleBar.restore' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
