// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CameraControlOptions } from '../domain/canvasNodes';
import { CAMERA_PROFILES, LENS_PROFILES } from '../application/cameraPromptLibrary';
import { CameraControlPanel } from './CameraControlPanel';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const initial: CameraControlOptions = { enabled: true, camera: CAMERA_PROFILES[0].id, lens: LENS_PROFILES[0].id, focalLength: 50, aperture: 4 };
const key = 'storyboard-camera-presets';
function storage(): Storage {
  const values = new Map<string, string>();
  return { getItem: name => values.get(name) ?? null, setItem: (name, value) => { values.set(name, value); }, removeItem: name => { values.delete(name); },
    clear: () => values.clear(), key: index => [...values.keys()][index] ?? null, get length() { return values.size; } };
}
function fixture() {
  const applied = vi.fn<(value: CameraControlOptions, prompt: string) => void>();
  function Surface() {
    const [open, setOpen] = useState(false);
    return <div data-testid="transformed-node" style={{ transform: 'scale(.57)' }}>
      <button onClick={() => setOpen(true)}>Camera settings</button>
      <CameraControlPanel isOpen={open} onClose={() => setOpen(false)} cameraControl={initial} onApply={applied} />
    </div>;
  }
  const view = render(<Surface />);
  const trigger = screen.getByRole('button', { name: 'Camera settings' });
  trigger.focus();
  fireEvent.click(trigger);
  return { ...view, applied };
}
function settleClose() { act(() => vi.advanceTimersByTime(0)); }
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', storage());
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const rect = new DOMRect(100, 100, 100, 30), rects = Object.assign([rect], { item: (index: number) => index === 0 ? rect : null });
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue(rects);
  Element.prototype.scrollIntoView = vi.fn();
  document.body.tabIndex = -1;
});
afterEach(() => { cleanup(); document.body.removeAttribute('tabindex'); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('independent camera settings modal', () => {
  it('renders outside the transformed node and returns focus to its trigger when canceled', () => {
    const { applied } = fixture();
    const dialog = screen.getByRole('dialog', { name: 'cameraControl.title' });
    expect(screen.getByTestId('transformed-node').contains(dialog)).toBe(false);
    expect(dialog.closest('[data-ui-modal]')?.parentElement).toBe(document.body);
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(screen.getByText(/生成时追加为提示词/)).toBeTruthy();
    fireEvent.click(within(dialog).getAllByRole('button', { name: '下一项' })[0]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.cancel' })); settleClose();
    expect(applied).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Camera settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Camera settings' }));
    expect(screen.getByText(`${CAMERA_PROFILES[0].zhName} · ${LENS_PROFILES[0].zhName} · 50mm · f/4`)).toBeTruthy();
  });

  it('applies the edited settings once with an enabled photography prompt and supports explicit disabling', () => {
    const { applied } = fixture();
    const dialog = screen.getByRole('dialog', { name: 'cameraControl.title' });
    fireEvent.click(within(dialog).getAllByRole('button', { name: '下一项' })[2]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'cameraControl.apply' })); settleClose();
    expect(applied).toHaveBeenCalledExactlyOnceWith({ ...initial, focalLength: 65 }, expect.any(String));
    expect(applied.mock.calls[0][1].length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Camera settings' }));
    fireEvent.click(screen.getByRole('switch', { name: '启用摄像机控制' }));
    fireEvent.click(screen.getByRole('button', { name: 'cameraControl.apply' }));
    expect(applied).toHaveBeenLastCalledWith({ ...initial, enabled: false }, '');
  });

  it('opens save-as directly and lets Escape close only the highest nested dialog', () => {
    const { applied } = fixture();
    fireEvent.click(screen.getByRole('button', { name: 'cameraControl.preset.saveAs' }));
    expect(screen.getByRole('dialog', { name: 'cameraControl.preset.saveTitle' })).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'cameraControl.preset.myPresets' })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }); settleClose();
    expect(screen.queryByRole('dialog', { name: 'cameraControl.preset.saveTitle' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'cameraControl.preset.myPresets' })).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'cameraControl.title' })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }); settleClose();
    expect(screen.queryByRole('dialog', { name: 'cameraControl.preset.myPresets' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'cameraControl.title' })).toBeTruthy();
    expect(applied).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }); settleClose();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('saves the current draft as a local preset and loads a preset without applying to the node until confirmed', () => {
    const savedPreset = { id: 'saved', name: 'Local portrait', camera: CAMERA_PROFILES[1].id, lens: LENS_PROFILES[1].id, focalLength: 85, aperture: 1.4, createdAt: 1 };
    localStorage.setItem(key, JSON.stringify([savedPreset]));
    const { applied } = fixture();
    fireEvent.click(screen.getByRole('button', { name: 'cameraControl.preset.saveAs' }));
    const save = screen.getByRole('dialog', { name: 'cameraControl.preset.saveTitle' });
    fireEvent.change(within(save).getByRole('textbox'), { target: { value: 'My draft' } });
    fireEvent.click(within(save).getByRole('button', { name: 'common.save' })); settleClose();
    expect(JSON.parse(localStorage.getItem(key) ?? '[]')).toContainEqual(expect.objectContaining({ name: 'My draft', camera: initial.camera, focalLength: 50 }));
    const presets = screen.getByRole('dialog', { name: 'cameraControl.preset.myPresets' });
    const row = within(presets).getByText('Local portrait').closest('.group');
    if (!(row instanceof HTMLElement)) throw new Error('Expected saved preset card');
    fireEvent.click(within(row).getByRole('button', { name: 'cameraControl.preset.apply' })); settleClose();
    expect(applied).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'cameraControl.apply' }));
    expect(applied).toHaveBeenCalledWith({ enabled: true, camera: savedPreset.camera, lens: savedPreset.lens, focalLength: 85, aperture: 1.4 }, expect.any(String));
  });

  it('clears the pending card tooltip delay when its panel unmounts', () => {
    const { unmount } = fixture();
    const scheduled = vi.spyOn(window, 'setTimeout');
    const cleared = vi.spyOn(window, 'clearTimeout');
    fireEvent.pointerEnter(screen.getByText('相机'));
    const tooltipCall = scheduled.mock.calls.findIndex(([, delay]) => delay === 900);
    expect(tooltipCall).toBeGreaterThanOrEqual(0);
    const tooltipTimer = scheduled.mock.results[tooltipCall].value;
    unmount();
    expect(cleared).toHaveBeenCalledWith(tooltipTimer);
    act(() => vi.advanceTimersByTime(900));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('shows a damaged-storage error and keeps save-as open instead of overwriting the data', () => {
    const original = '{damaged data';
    localStorage.setItem(key, original);
    fixture();
    fireEvent.click(screen.getByRole('button', { name: 'cameraControl.preset.saveAs' }));
    const save = screen.getByRole('dialog', { name: 'cameraControl.preset.saveTitle' });
    fireEvent.change(within(save).getByRole('textbox'), { target: { value: 'My settings' } });
    fireEvent.click(within(save).getByRole('button', { name: 'common.save' }));
    expect(within(save).getByRole('alert').textContent).toContain('原始数据已保留');
    expect(localStorage.getItem(key)).toBe(original);
  });
});
