export interface DesktopWindowControls {
  isMaximized(): Promise<boolean>;
  maximize(): Promise<void>;
  unmaximize(): Promise<void>;
  isFullscreen(): Promise<boolean>;
  setFullscreen(value: boolean): Promise<void>;
}

/** macOS green enters a Space; Option-green and titlebar double-click zoom within the desktop. */
export async function changeWindowSize(window: DesktopWindowControls, mode: 'maximize' | 'fullscreen'): Promise<void> {
  if (mode === 'fullscreen') {
    await window.setFullscreen(!(await window.isFullscreen()));
    return;
  }
  if (await window.isFullscreen()) { await window.setFullscreen(false); return; }
  if (await window.isMaximized()) await window.unmaximize();
  else await window.maximize();
}
