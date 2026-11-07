// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParamSpec } from '@/features/channels/domain/profile';
import { PopoverSurface } from '@/components/ui/Menu';
import { parameterSummary } from '@/features/channels/ui/parameterPresentation';
import { ComposerParameterPanel } from './ComposerParameterPanel';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView'); });

function Editor({ params, initial = {}, changed, popover = false, closed = () => {} }: {
  params: ParamSpec[]; initial?: Record<string, unknown>; changed(values: Record<string, unknown>): void; popover?: boolean; closed?(): void;
}) {
  const [values, setValues] = useState(initial);
  const [open, setOpen] = useState(true);
  const panel = <ComposerParameterPanel params={params} values={values} onChange={(next) => { setValues(next); changed(next); }} />;
  return <><output data-testid="summary">{parameterSummary(params, values).join(' · ')}</output>{!popover ? panel : open
    ? <PopoverSurface label="Generation parameters" anchor={{ x: 60, y: 60 }} onClose={() => { setOpen(false); closed(); }}>{panel}</PopoverSurface>
    : null}</>;
}

const dimensions: ParamSpec = { key: 'size', label: '尺寸', type: 'enum', default: { width: 1280, height: 720 }, options: [
  { label: '宽屏 · 1280 × 720', value: { width: 1280, height: 720 } },
  { label: '竖屏 · 720 × 1280', value: { width: 720, height: 1280 } },
] };
const durations = [2, 3, 4, 6, 8, 10, 12, 15, 18, 20, 24, 28, 30, 36, 40, 45, 50, 60];
const duration: ParamSpec = { key: 'duration', label: '时长', type: 'enum', default: 8,
  options: durations.map((value) => ({ label: `${value} 秒`, value })) };

describe('composer parameter interactions', () => {
  it('recognizes a restored object enum regardless of JSON field order and commits the complete declared value', () => {
    const changed = vi.fn();
    render(<Editor params={[dimensions]} initial={{ size: { height: 720, width: 1280 }, retained: true }} changed={changed} />);
    expect(screen.getByRole('button', { name: '宽屏 · 1280 × 720' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('summary').textContent).toBe('宽屏 · 1280 × 720');
    fireEvent.click(screen.getByRole('button', { name: '竖屏 · 720 × 1280' }));
    expect(changed).toHaveBeenCalledExactlyOnceWith({ size: { width: 720, height: 1280 }, retained: true });
    expect(screen.getByTestId('summary').textContent).toBe('竖屏 · 720 × 1280');
    fireEvent.click(screen.getByRole('button', { name: 'ui.workbench.default' }));
    expect(changed).toHaveBeenLastCalledWith({ retained: true });
    expect(screen.getByRole('button', { name: '宽屏 · 1280 × 720' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('maps every one of 18 slider stops to the declared duration and keeps precise selection synchronized', () => {
    const changed = vi.fn();
    render(<Editor params={[duration]} initial={{ duration: 2, retained: 'keep' }} changed={changed} />);
    const slider = screen.getByRole('slider', { name: '时长' });
    const precise = screen.getByRole('button', { name: '时长 ui.workbench.preciseValue' });
    for (let index = 0; index < durations.length; index += 1) {
      // Move to a different stop first, so the first and last values also trigger real changes.
      fireEvent.change(slider, { target: { value: String((index + 1) % durations.length) } });
      fireEvent.change(slider, { target: { value: String(index) } });
      expect(changed).toHaveBeenLastCalledWith({ duration: durations[index], retained: 'keep' });
      expect(precise.textContent).toContain(`${durations[index]} 秒`);
      expect(screen.getByTestId('summary').textContent).toBe(`${durations[index]} 秒`);
    }
    fireEvent.click(precise);
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: '28 秒' }));
    expect(changed).toHaveBeenLastCalledWith({ duration: 28, retained: 'keep' });
    expect(slider.getAttribute('value')).toBe(String(durations.indexOf(28)));
  });

  it('shows labels and preserves full object values when many choices use a select', () => {
    const changed = vi.fn();
    const sizes: ParamSpec = { key: 'size', label: '画面规格', type: 'enum', options: Array.from({ length: 9 }, (_, index) => ({
      label: `规格 ${index + 1}`, value: { width: 640 + index * 64, height: 480, format: 'png' },
    })) };
    render(<Editor params={[sizes]} initial={{ size: { format: 'png', height: 480, width: 1152 } }} changed={changed} />);
    const trigger = screen.getByRole('button', { name: '画面规格' });
    expect(trigger.textContent).toBe('规格 9');
    fireEvent.click(trigger);
    expect(within(screen.getByRole('listbox')).getByRole('option', { name: '规格 9' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: '规格 3' }));
    expect(changed).toHaveBeenCalledExactlyOnceWith({ size: { width: 768, height: 480, format: 'png' } });
    expect(trigger.textContent).toBe('规格 3');
  });

  it('keeps numeric-string enum wire values as strings after a slider choice', () => {
    const changed = vi.fn();
    const stringDuration: ParamSpec = { ...duration, default: '8', options: durations.map((value) => ({ label: `${value} 秒`, value: String(value) })) };
    render(<Editor params={[stringDuration]} changed={changed} />);
    fireEvent.change(screen.getByRole('slider', { name: '时长' }), { target: { value: '8' } });
    expect(changed).toHaveBeenCalledExactlyOnceWith({ duration: '18' });
    expect(screen.getByRole('button', { name: '时长 ui.workbench.preciseValue' }).textContent).toContain('18 秒');
  });

  it('keeps a nested precise select inside its parent popover and dismisses only the top surface with Escape', () => {
    const changed = vi.fn(); const closed = vi.fn();
    render(<Editor params={[duration]} popover changed={changed} closed={closed} />);
    const precise = screen.getByRole('button', { name: '时长 ui.workbench.preciseValue' });
    fireEvent.click(precise);
    expect(closed).not.toHaveBeenCalled();
    const option = within(screen.getByRole('listbox')).getByRole('option', { name: '18 秒' });
    fireEvent.pointerDown(option); fireEvent.click(option);
    expect(changed).toHaveBeenCalledExactlyOnceWith({ duration: 18 });
    expect(closed).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Generation parameters' })).toBeTruthy();
    fireEvent.click(precise);
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(closed).not.toHaveBeenCalled();
    fireEvent.keyDown(precise, { key: 'Escape' });
    expect(closed).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
