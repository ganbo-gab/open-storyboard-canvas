// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelProfileV2, ParamSpec } from '@/features/channels/domain/profile';
import { BatchModelParametersDialog } from './BatchModelParametersDialog';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const frame: ParamSpec = { key: 'size', label: '尺寸', type: 'enum', default: '1024x1024', options: [
  { label: 'Square', value: '1024x1024' }, { label: 'Portrait', value: '1024x1536' },
] };
function fixture(): ChannelProfileV2 {
  return { version: 2, id: 'batch-ui', name: 'Batch UI', baseUrl: 'https://fixture.invalid', auth: { type: 'none' },
    operations: { 'image.generate': { method: 'POST', path: '/images', body: 'json', template: { model: '{{model}}', size: '{{param.size}}' }, response: { mode: 'sync', outputs: [] } } },
    models: [
      { id: 'source', label: 'Source', operations: ['image.generate'], params: [frame] },
      { id: 'target', label: 'Target', operations: ['image.generate'], params: [{ ...frame, default: '1024x1536' }, { key: 'seed', label: 'Seed', type: 'number', default: 5 }] },
      { id: 'symbol', label: 'Symbol', operations: ['image.generate'], params: [{ key: 'size', label: '尺寸', type: 'enum', default: '2K', options: [{ label: '2K', value: '2K' }] }] },
    ] };
}
const targetName = 'ui.channels.batch.target Target · 默认';

describe('reviewed batch model parameter dialog', () => {
  it('lets the user select and clear a target without changing the draft, and cancellation only closes', () => {
    const profile = fixture(), before = structuredClone(profile), onApply = vi.fn(), onClose = vi.fn();
    render(<BatchModelParametersDialog profile={profile} initialModelId="source" onApply={onApply} onClose={onClose} />);
    const review = screen.getByRole('button', { name: 'ui.channels.batch.review' });
    expect(review.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: targetName }));
    expect(screen.getByRole('button', { name: 'ui.channels.batch.review' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: targetName }));
    expect(screen.getByRole('button', { name: 'ui.channels.batch.review' }).hasAttribute('disabled')).toBe(true);
    expect(onApply).not.toHaveBeenCalled();
    expect(profile).toEqual(before);
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('reviews changes without writing and applies exactly one cloned profile after confirmation', () => {
    const profile = fixture(), before = structuredClone(profile), onApply = vi.fn();
    render(<BatchModelParametersDialog profile={profile} initialModelId="source" onApply={onApply} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('checkbox', { name: targetName }));
    fireEvent.click(screen.getByRole('button', { name: 'ui.channels.batch.review' }));
    expect(screen.getByText('ui.channels.batch.reviewSummary')).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
    expect(profile).toEqual(before);
    fireEvent.click(screen.getByText('尺寸', { selector: 'summary' }));
    expect(screen.getByText('ui.channels.batch.before')).toBeTruthy();
    expect(screen.getByText('ui.channels.batch.after')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'ui.channels.batch.apply' }));
    expect(onApply).toHaveBeenCalledOnce();
    const updated = onApply.mock.calls[0][0] as ChannelProfileV2;
    expect(updated).not.toBe(profile);
    expect(updated.models[1].params[0].default).toBe('1024x1536');
    expect(updated.models[1].params[1]).toEqual(before.models[1].params[1]);
    expect(profile).toEqual(before);
  });

  it('disables incompatible targets and only selects compatible destinations', () => {
    render(<BatchModelParametersDialog profile={fixture()} initialModelId="source" onApply={vi.fn()} onClose={() => {}} />);
    expect(screen.getByRole('checkbox', { name: 'ui.channels.batch.target Symbol · 默认' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('参数 size 的像素尺寸与符号分辨率格式不同')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'ui.channels.batch.selectCompatible' }));
    expect(screen.getByRole('checkbox', { name: targetName, checked: true })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'ui.channels.batch.target Symbol · 默认', checked: false })).toBeTruthy();
  });

  it('copies source defaults only when the copy-defaults switch is enabled', () => {
    const onApply = vi.fn();
    render(<BatchModelParametersDialog profile={fixture()} initialModelId="source" onApply={onApply} onClose={() => {}} />);
    const copy = screen.getByRole('checkbox', { name: /ui.channels.batch.copyDefaults/ });
    expect(screen.getByRole('checkbox', { name: /ui.channels.batch.copyDefaults/, checked: false })).toBe(copy);
    fireEvent.click(copy);
    fireEvent.click(screen.getByRole('checkbox', { name: targetName }));
    fireEvent.click(screen.getByRole('button', { name: 'ui.channels.batch.review' }));
    fireEvent.click(screen.getByRole('button', { name: 'ui.channels.batch.apply' }));
    const updated = onApply.mock.calls[0][0] as ChannelProfileV2;
    expect(updated.models[1].params[0].default).toBe('1024x1024');
  });

  it('blocks a stale review and requires returning to selection and reviewing the current profile again', () => {
    const profile = fixture(), onApply = vi.fn(), onClose = vi.fn();
    const view = render(<BatchModelParametersDialog profile={profile} initialModelId="source" onApply={onApply} onClose={onClose} />);
    fireEvent.click(screen.getByRole('checkbox', { name: targetName }));
    fireEvent.click(screen.getByRole('button', { name: 'ui.channels.batch.review' }));
    const updated = structuredClone(profile);
    updated.models[0].params[0].label = 'Updated size';
    updated.models[0].params[0].options = [{ label: 'Square only', value: '1024x1024' }];
    view.rerender(<BatchModelParametersDialog profile={updated} initialModelId="source" onApply={onApply} onClose={onClose} />);
    expect(screen.getByRole('alert').textContent).toBe('ui.channels.batch.stale');
    expect(screen.getByRole('button', { name: 'ui.channels.batch.apply' }).hasAttribute('disabled')).toBe(true);
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'ui.channels.batch.back' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'ui.channels.batch.parameter Updated size', checked: true })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'ui.channels.batch.review' }));
    fireEvent.click(screen.getByRole('button', { name: 'ui.channels.batch.apply' }));
    expect(onApply).toHaveBeenCalledOnce();
    const applied = onApply.mock.calls[0][0] as ChannelProfileV2;
    expect(applied.models[1].params[0]).toMatchObject({ label: 'Updated size', options: [{ value: '1024x1024' }], default: '1024x1024' });
  });
});
