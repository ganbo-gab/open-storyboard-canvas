// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/stores/settingsStore';
import { normalizeWorkspacePreferences } from '@/features/settings/workspacePreferences';
import { SidebarResizeHandle, useSidebarWidth } from './SidebarResizeHandle';

function Split({ show = true }: { show?: boolean }) {
  const sidebar = useSidebarWidth('test-history', 252, 200, 480);
  return <div>{show && <aside ref={sidebar.ref} data-testid="sidebar"><SidebarResizeHandle {...sidebar} label="历史宽度" /></aside>}</div>;
}
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  useSettingsStore.setState({ workspacePreferences: normalizeWorkspacePreferences({}) });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { x: 0, y: 0, top: 0, bottom: 500, left: 0, right: Number.parseFloat(this.style.width) || 0, width: Number.parseFloat(this.style.width) || 0, height: 500, toJSON() {} };
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('restores saved width when a delayed page mounts, adjusts with keyboard and resets', () => {
  useSettingsStore.setState({ workspacePreferences: normalizeWorkspacePreferences({ sidebarWidths: { 'test-history': 320 } }) });
  const view = render(<Split show={false} />);
  view.rerender(<Split />);
  expect(screen.getByTestId('sidebar').style.width).toBe('320px');
  fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowRight' });
  expect(screen.getByTestId('sidebar').style.width).toBe('330px');
  expect(useSettingsStore.getState().workspacePreferences.sidebarWidths['test-history']).toBe(330);
  fireEvent.doubleClick(screen.getByRole('separator'));
  expect(useSettingsStore.getState().workspacePreferences.sidebarWidths['test-history']).toBe(252);
  act(() => { useSettingsStore.getState().setWorkspacePreferences({ resizePanels: false }); });
  expect(screen.queryByRole('separator')).toBeNull();
  expect(screen.getByTestId('sidebar').style.width).toBe('252px');
});
it('keeps the content reachable by clamping wide saved panels and resets across mounted pages', () => {
  useSettingsStore.setState({ workspacePreferences: normalizeWorkspacePreferences({ sidebarWidths: { 'test-history': 900 } }) });
  render(<Split />);
  expect(screen.getByTestId('sidebar').style.width).toBe('480px');
  act(() => { useSettingsStore.getState().setWorkspacePreferences({ sidebarWidths: {} }); });
  expect(screen.getByTestId('sidebar').style.width).toBe('252px');
});
