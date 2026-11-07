// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { configureSizeDisplay, pixelSizeChoices } from './sizeParameterPresentation';
import { PixelSizeControl } from './PixelSizeControl';
import { channelProfileSchema, type ParamSpec } from '../domain/profile';
import { renderRequest } from '../domain/template';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });
const original: ParamSpec = { key: 'size', label: 'Size', type: 'enum', default: '1024x1024', options: [
  { label: 'Square', value: '1024x1024' }, { label: 'Large square', value: '2048x2048' },
  { label: 'Portrait', value: '1024x1536' }, { label: 'Automatic', value: 'auto' },
] };
describe('declared frame control presentation', () => {
  it('does not invent dimensions or alter the template API values when changing display', async () => {
    const param = configureSizeDisplay(original, 'ratio-resolution');
    expect(param.options?.map(option => option.value)).toEqual(original.options?.map(option => option.value));
    expect(pixelSizeChoices(param).map(choice => [choice.ratio, choice.resolution])).toEqual([['1:1', '1K'], ['1:1', '2K'], ['2:3', '1536px']]);
    const profile = channelProfileSchema.parse({ version: 2, id: 'test', name: 'Test', baseUrl: 'https://fixture.invalid', auth: { type: 'none' },
      operations: { 'image.generate': { method: 'POST', path: '/images', body: 'json', template: { size: '{{param.size}}' }, response: { mode: 'sync', outputs: [] } } },
      models: [{ id: 'image', operations: ['image.generate'], params: [param] }] });
    const result = await renderRequest(profile, { jobId: 'job', channelId: 'test', modelId: 'image', operation: 'image.generate', prompt: 'Image', count: 1, refs: [], params: { size: '1024x1536' } }, '', async () => '');
    expect(result.request.body).toEqual({ mode: 'json', json: { size: '1024x1536' } });
  });
  it('offers only valid ratio/resolution pairs and preserves auto', () => {
    const param = configureSizeDisplay(original, 'ratio-resolution'); let wireValue: unknown;
    function Surface() { const [value, setValue] = useState<unknown>(param.default); wireValue = value; return <PixelSizeControl param={param} value={value} onChange={setValue} />; }
    render(<Surface />);
    fireEvent.click(screen.getByRole('button', { name: 'Size ui.channels.sizeGuide.resolution' }));
    fireEvent.click(screen.getByRole('option', { name: '2K' }));
    expect(wireValue).toBe('2048x2048');
    fireEvent.click(screen.getByRole('button', { name: 'Size ui.channels.sizeGuide.ratio' }));
    fireEvent.click(screen.getByRole('option', { name: '2:3' }));
    expect(wireValue).toBe('1024x1536');
    fireEvent.click(screen.getByRole('button', { name: 'Size ui.channels.sizeGuide.resolution' }));
    fireEvent.click(screen.getByRole('option', { name: '2K' }));
    expect(wireValue).toBe('2048x2048');
    expect(screen.getByRole('button', { name: 'Size ui.channels.sizeGuide.ratio' }).textContent).toContain('1:1');
    fireEvent.click(screen.getByRole('button', { name: 'Automatic' })); expect(wireValue).toBe('auto');
  });
  it('leaves provider symbolic tiers unchanged unless a mapping is explicitly declared', () => {
    expect(pixelSizeChoices({ key: 'resolution', label: 'Resolution', type: 'enum', options: [{ label: '1K', value: '1K' }] })).toEqual([]);
    const custom = configureSizeDisplay({ ...original, options: [{ label: 'Custom', value: 'provider-square', size: { ratio: '1:1', resolution: 'HD' } }] }, 'ratio-resolution');
    expect(pixelSizeChoices(custom)[0]).toMatchObject({ ratio: '1:1', resolution: 'HD' });
    expect(custom.options?.[0].value).toBe('provider-square');
  });
});
