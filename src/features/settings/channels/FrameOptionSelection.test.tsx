// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { channelProfileSchema, type JsonValue, type ParamSpec } from '@/features/channels/domain/profile';
import { renderRequest } from '@/features/channels/domain/template';
import { ComposerParameterPanel } from '@/features/workbench/ui/ComposerParameterPanel';
import { FrameOptionSelection } from './FrameOptionSelection';
import { ParameterSchemaEditor } from './ParameterSchemaEditor';
import { applyPixelSizeCombinations, buildPixelSizeCombinations } from './pixelSizeCombinations';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(cleanup);

const pixels: ParamSpec = { key: 'size', label: '尺寸', type: 'enum', default: '1024x1536', options: [
  { label: 'Square', value: '1024x1024' }, { label: 'Portrait', value: '1024x1536' }, { label: 'Automatic', value: 'auto' },
] };

function renderSelection(initial: ParamSpec) {
  let saved = initial;
  function Surface() {
    const [param, setParam] = useState(initial);
    saved = param;
    return <FrameOptionSelection param={param} onChange={setParam} />;
  }
  render(<Surface />);
  return () => saved;
}

function openDetails(name: string): HTMLDetailsElement {
  const summary = screen.getByText(name, { selector: 'summary' });
  const details = summary.parentElement;
  if (!(details instanceof HTMLDetailsElement)) throw new Error('Expected an expandable section');
  fireEvent.click(summary);
  return details;
}

// This jsdom version does not exclude descendants of closed native details from role queries.
function visibleCheckbox(name: string, checked: boolean): HTMLElement {
  const matches = screen.getAllByRole('checkbox', { name, checked }).filter(element => !element.closest('details:not([open])'));
  if (matches.length !== 1) throw new Error(`Expected one visible checkbox: ${name}`);
  return matches[0];
}

async function requestBody(param: ParamSpec, values: Record<string, JsonValue> = {}) {
  const profile = channelProfileSchema.parse({ version: 2, id: 'frame-fixture', name: 'Frame fixture', baseUrl: 'https://fixture.invalid', auth: { type: 'none' },
    operations: { 'image.generate': { method: 'POST', path: '/image', body: 'json', template: { [param.key]: `{{param.${param.key}}}` }, response: { mode: 'sync', outputs: [] } } },
    models: [{ id: 'image', operations: ['image.generate'], params: [param] }] });
  const { request } = await renderRequest(profile, { jobId: 'fixture-job', channelId: profile.id, modelId: 'image', operation: 'image.generate', prompt: 'Frame test', params: values, refs: [], count: 1 }, '', async () => '');
  return request.body;
}

describe('channel frame option editing', () => {
  it('switches the editor to independent frame axes and friendly default selectors while preserving the declared request size', async () => {
    let saved = pixels;
    function Surface() {
      const [params, setParams] = useState([pixels]);
      saved = params[0];
      return <ParameterSchemaEditor params={params} onChange={setParams} />;
    }
    render(<Surface />);
    const display = screen.getByRole('group', { name: '尺寸 ui.channels.sizeGuide.title' });
    fireEvent.click(within(display).getByRole('button', { name: /ui.channels.sizeGuide.ratio-resolution/ }));
    expect(within(screen.getByRole('group', { name: 'ui.channels.sizeGuide.ratio' })).getByRole('checkbox', { name: 'ui.channels.sizeGuide.ratio 2:3', checked: true })).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'ui.channels.sizeGuide.resolution' })).getByRole('checkbox', { name: 'ui.channels.sizeGuide.resolution 1536px', checked: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: '尺寸 ui.channels.sizeGuide.ratio' }).textContent).toContain('2:3');
    expect(screen.getByRole('button', { name: '尺寸 ui.channels.sizeGuide.resolution' }).textContent).toContain('1536px');
    expect(saved.options?.map(option => option.value)).toEqual(pixels.options?.map(option => option.value));
    expect(saved.default).toBe('1024x1536');
    expect(await requestBody(saved)).toEqual({ mode: 'json', json: { size: '1024x1536' } });
  });

  it('moves a canceled default to the first remaining option and lets the user check the original choice again', async () => {
    const current = renderSelection(pixels);
    fireEvent.click(visibleCheckbox('Portrait (1024x1536)', true));
    expect(current().default).toBe('1024x1024');
    expect(screen.getByRole('button', { name: '尺寸 ui.channels.frameOptions.default' }).textContent).toContain('Square');
    expect(visibleCheckbox('Portrait (1024x1536)', false)).toBeTruthy();
    expect(await requestBody(current())).toEqual({ mode: 'json', json: { size: '1024x1024' } });
    fireEvent.click(visibleCheckbox('Portrait (1024x1536)', false));
    expect(current().options?.map(option => option.value)).toEqual(['1024x1024', 'auto', '1024x1536']);
    expect(current().default).toBe('1024x1024');
    expect(visibleCheckbox('Portrait (1024x1536)', true)).toBeTruthy();
  });

  it('keeps visible pixel cards in place while unchecking and rechecking them', () => {
    renderSelection({ ...pixels, sizeDisplay: 'pixels' });
    const visibleCards = () => screen.getAllByRole('checkbox').filter(element => !element.closest('details:not([open])'));
    const names = () => visibleCards().map(element => element.getAttribute('aria-label') ?? '');
    const before = names();
    const first = visibleCards()[0];
    fireEvent.click(first);
    expect(names()).toEqual(before);
    expect(visibleCheckbox(before[0], false)).toBe(first);
    expect(visibleCards()[0]).toBe(first);
    expect(visibleCards()[0].getAttribute('aria-label')).toBe(before[0]);
    fireEvent.click(visibleCards()[0]);
    expect(names()).toEqual(before);
    expect(visibleCheckbox(before[0], true)).toBe(first);
    expect(visibleCards()[0]).toBe(first);
    const middle = visibleCards()[1];
    fireEvent.click(middle);
    expect(names()).toEqual(before);
    expect(visibleCheckbox(before[1], false)).toBe(middle);
    expect(visibleCards()[1]).toBe(middle);
    fireEvent.click(visibleCards()[1]);
    expect(names()).toEqual(before);
    expect(visibleCheckbox(before[1], true)).toBe(middle);
    expect(visibleCards()[1]).toBe(middle);
  });

  it('explicitly applies the product of independently selected ratios and resolutions, preserving auto and exact requests', async () => {
    const initial: ParamSpec = { ...pixels, default: '1024x1024', sizeDisplay: 'ratio-resolution', options: [pixels.options![0], pixels.options![2]] };
    const current = renderSelection(initial);
    fireEvent.click(screen.getByRole('checkbox', { name: 'ui.channels.sizeGuide.resolution 2K', checked: false }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'ui.channels.sizeGuide.ratio 16:9', checked: false }));
    expect(current().options).toEqual(initial.options);
    fireEvent.click(screen.getByRole('button', { name: 'ui.channels.combinations.apply' }));
    expect(current().options?.map(option => option.value)).toEqual(['1024x1024', '2048x2048', '1024x576', '2048x1152', 'auto']);
    expect(current().default).toBe('1024x1024');
    for (const size of ['1024x1024', '2048x2048', '1024x576', '2048x1152', 'auto']) {
      expect(await requestBody(current(), { size })).toEqual({ mode: 'json', json: { size } });
    }
  });

  it('requires an explicit actual API size for a new symbolic tier before applying it', async () => {
    const initial: ParamSpec = { ...pixels, default: '1024x1024', sizeDisplay: 'ratio-resolution', options: [pixels.options![0], pixels.options![2]] };
    const current = renderSelection(initial);
    openDetails('ui.channels.combinations.custom');
    fireEvent.change(screen.getByRole('textbox', { name: 'ui.channels.combinations.customTier' }), { target: { value: 'HD' } });
    fireEvent.click(screen.getByRole('button', { name: 'ui.channels.combinations.addTier' }));
    expect(screen.getByRole('alert').textContent).toBe('ui.channels.combinations.missing');
    const apply = screen.getByRole('button', { name: 'ui.channels.combinations.apply' });
    expect(apply.hasAttribute('disabled')).toBe(true);
    expect(current().options).toEqual(initial.options);
    fireEvent.change(screen.getByRole('textbox', { name: '1:1 HD ui.channels.frameOptions.wireValue' }), { target: { value: 'provider-square-hd' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'ui.channels.combinations.apply' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'ui.channels.combinations.apply' }));
    expect(current().options?.find(option => option.value === 'provider-square-hd')?.size).toEqual({ ratio: '1:1', resolution: 'HD' });
    expect(await requestBody(current(), { size: 'provider-square-hd' })).toEqual({ mode: 'json', json: { size: 'provider-square-hd' } });
  });

  it('blocks applying conflicting ratio and tier mappings that produce the same wire value', () => {
    const initial: ParamSpec = { ...pixels, default: '1024x1024', sizeDisplay: 'ratio-resolution', options: [pixels.options![0], pixels.options![2]] };
    const current = renderSelection(initial);
    openDetails('ui.channels.combinations.custom');
    fireEvent.change(screen.getByRole('textbox', { name: 'ui.channels.combinations.customRatio' }), { target: { value: '2:2' } });
    fireEvent.click(screen.getByRole('button', { name: 'ui.channels.combinations.addRatio' }));
    expect(screen.getByRole('alert').textContent).toBe('ui.channels.combinations.conflict');
    expect(screen.getByRole('button', { name: 'ui.channels.combinations.apply' }).hasAttribute('disabled')).toBe(true);
    expect(current().options).toEqual(initial.options);
  });

  it('lets the workbench change ratio while retaining the selected resolution, then independently choose another resolution', async () => {
    const initial: ParamSpec = { ...pixels, default: '1024x1024', sizeDisplay: 'ratio-resolution', options: [pixels.options![0], pixels.options![2]] };
    const combinations = buildPixelSizeCombinations(initial, ['1:1', '16:9'], ['1K', '2K']);
    const param = applyPixelSizeCombinations(initial, combinations.flatMap(choice => choice.option ? [choice.option] : []));
    let selected: Record<string, unknown> = {};
    function Surface() {
      const [values, setValues] = useState<Record<string, unknown>>({});
      selected = values;
      return <ComposerParameterPanel params={[param]} values={values} onChange={setValues} />;
    }
    render(<Surface />);
    expect(screen.getByRole('button', { name: '尺寸 ui.channels.sizeGuide.ratio' }).textContent).toContain('1:1');
    expect(screen.getByRole('button', { name: '尺寸 ui.channels.sizeGuide.resolution' }).textContent).toContain('1K');
    fireEvent.click(screen.getByRole('button', { name: '尺寸 ui.channels.sizeGuide.ratio' }));
    fireEvent.click(screen.getByRole('option', { name: '16:9' }));
    expect(selected.size).toBe('1024x576');
    expect(screen.getByRole('button', { name: '尺寸 ui.channels.sizeGuide.resolution' }).textContent).toContain('1K');
    fireEvent.click(screen.getByRole('button', { name: '尺寸 ui.channels.sizeGuide.resolution' }));
    fireEvent.click(screen.getByRole('option', { name: '2K' }));
    expect(selected.size).toBe('2048x1152');
    expect(await requestBody(param, { size: String(selected.size) })).toEqual({ mode: 'json', json: { size: '2048x1152' } });
    fireEvent.click(screen.getByRole('button', { name: '尺寸 ui.channels.sizeGuide.ratio' }));
    fireEvent.click(screen.getByRole('option', { name: '1:1' }));
    expect(selected.size).toBe('2048x2048');
    expect(screen.getByRole('button', { name: '尺寸 ui.channels.sizeGuide.resolution' }).textContent).toContain('2K');
    fireEvent.click(screen.getByRole('button', { name: '尺寸 ui.channels.sizeGuide.resolution' }));
    fireEvent.click(screen.getByRole('option', { name: '1K' }));
    expect(selected.size).toBe('1024x1024');
    expect(screen.getByRole('button', { name: '尺寸 ui.channels.sizeGuide.ratio' }).textContent).toContain('1:1');
  });

  it('preserves auto as an independent exact value and prevents unchecking the last enabled option', async () => {
    const current = renderSelection({ ...pixels, default: 'auto', sizeDisplay: 'pixels' });
    fireEvent.click(visibleCheckbox('Square (1024x1024)', true));
    fireEvent.click(visibleCheckbox('Portrait (1024x1536)', true));
    const automatic = visibleCheckbox('Automatic (auto)', true);
    expect(automatic.hasAttribute('disabled')).toBe(true);
    expect(current().options).toEqual([{ label: 'Automatic', value: 'auto' }]);
    expect(current().default).toBe('auto');
    expect(await requestBody(current())).toEqual({ mode: 'json', json: { size: 'auto' } });
  });

  it('keeps more candidates disabled until the user explicitly checks one', () => {
    const current = renderSelection(pixels);
    expect(screen.getByText('ui.channels.frameOptions.more', { selector: 'summary' }).parentElement?.hasAttribute('open')).toBe(false);
    expect(current().options?.map(option => option.value)).toEqual(pixels.options?.map(option => option.value));
    const more = openDetails('ui.channels.frameOptions.more');
    const candidate = within(more).getByRole('checkbox', { name: '2048x2048 (2048x2048)', checked: false });
    expect(current().options).toHaveLength(3);
    fireEvent.click(candidate);
    expect(current().options?.map(option => option.value)).toEqual(['1024x1024', '1024x1536', 'auto', '2048x2048']);
    expect(current().default).toBe('1024x1536');
    expect(within(more).getByRole('checkbox', { name: '2048x2048 (2048x2048)', checked: true })).toBeTruthy();
  });

  it('offers explicit landscape, portrait and ultrawide examples without enabling them on expansion', async () => {
    const current = renderSelection(pixels);
    const more = openDetails('ui.channels.frameOptions.more');
    for (const value of ['1024x768', '768x1024', '1280x1024', '1024x1280', '2048x1024', '1024x2048', '1792x768', '768x1792']) {
      expect(within(more).getByRole('checkbox', { name: `${value} (${value})`, checked: false })).toBeTruthy();
    }
    expect(current().options?.map(option => option.value)).toEqual(pixels.options?.map(option => option.value));
    fireEvent.click(within(more).getByRole('checkbox', { name: '1792x768 (1792x768)', checked: false }));
    expect(current().options?.map(option => option.value)).toEqual(['1024x1024', '1024x1536', 'auto', '1792x768']);
    fireEvent.click(screen.getByRole('button', { name: '尺寸 ui.channels.frameOptions.default' }));
    fireEvent.click(screen.getByRole('option', { name: '1792x768' }));
    expect(current().default).toBe('1792x768');
    expect(await requestBody(current())).toEqual({ mode: 'json', json: { size: '1792x768' } });
  });

  it.each([
    { key: 'aspect_ratio', label: '比例', first: '1:1', second: '16:9', candidate: '4:3' },
    { key: 'resolution', label: '分辨率', first: '720P', second: '1080P', candidate: '2160P' },
  ])('edits native $key options using checkboxes without changing their wire notation', async ({ key, label, first, second, candidate }) => {
    const current = renderSelection({ key, label, type: 'enum', default: first, options: [
      { label: 'Original', value: first }, { label: 'Alternative', value: second },
    ] });
    fireEvent.click(visibleCheckbox(`Original (${first})`, true));
    expect(current().default).toBe(second);
    const more = openDetails('ui.channels.frameOptions.more');
    fireEvent.click(within(more).getByRole('checkbox', { name: `${candidate} (${candidate})`, checked: false }));
    expect(current().options?.map(option => option.value)).toEqual([second, candidate]);
    expect(await requestBody(current())).toEqual({ mode: 'json', json: { [key]: second } });
  });

  it('does not replace custom labels or size metadata when the same wire value is added again', () => {
    const custom = { label: 'Cinema', value: 'provider-wide', size: { ratio: '2:1', resolution: 'Studio' } };
    const current = renderSelection({ ...pixels, options: [custom, { label: 'Automatic', value: 'auto' }], default: custom.value, sizeDisplay: 'pixels' });
    openDetails('ui.channels.frameOptions.custom');
    fireEvent.change(screen.getByRole('textbox', { name: '尺寸 ui.channels.frameOptions.wireValue' }), { target: { value: custom.value } });
    fireEvent.change(screen.getByRole('textbox', { name: '尺寸 ui.channels.frameOptions.label' }), { target: { value: 'Replace existing label' } });
    fireEvent.click(screen.getByRole('button', { name: 'ui.channels.frameOptions.add' }));
    expect(current().options).toEqual([custom, { label: 'Automatic', value: 'auto' }]);
    expect(current().options?.[0]).toBe(custom);
    expect(screen.getByRole('textbox', { name: '尺寸 ui.channels.frameOptions.wireValue' }).getAttribute('value')).toBe('');
  });

  it('retains metadata when a temporarily unchecked custom value is added back through the custom form', () => {
    const custom = { label: 'Cinema', value: 'provider-wide', size: { ratio: '2:1', resolution: 'Studio' } };
    const current = renderSelection({ ...pixels, options: [custom, { label: 'Automatic', value: 'auto' }], default: custom.value, sizeDisplay: 'pixels' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Cinema (provider-wide)', checked: true }));
    expect(current().default).toBe('auto');
    openDetails('ui.channels.frameOptions.custom');
    fireEvent.change(screen.getByRole('textbox', { name: '尺寸 ui.channels.frameOptions.wireValue' }), { target: { value: custom.value } });
    fireEvent.click(screen.getByRole('button', { name: 'ui.channels.frameOptions.add' }));
    expect(current().options?.find(option => option.value === custom.value)).toEqual(custom);
    expect(screen.getByRole('checkbox', { name: 'Cinema (provider-wide)', checked: true })).toBeTruthy();
  });

  it('parses asterisk dimensions for friendly groups while sending the original separator unchanged', async () => {
    let saved: ParamSpec = { key: 'size', label: '尺寸', type: 'enum', default: '1024*1536', options: [
      { label: 'Portrait', value: '1024*1536' }, { label: 'Automatic', value: 'auto' },
    ] };
    function Surface() {
      const [params, setParams] = useState([saved]);
      saved = params[0];
      return <ParameterSchemaEditor params={params} onChange={setParams} />;
    }
    render(<Surface />);
    fireEvent.click(within(screen.getByRole('group', { name: '尺寸 ui.channels.sizeGuide.title' })).getByRole('button', { name: /ui.channels.sizeGuide.ratio-resolution/ }));
    expect(screen.getByRole('checkbox', { name: 'ui.channels.sizeGuide.ratio 2:3', checked: true })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'ui.channels.sizeGuide.resolution 1536px', checked: true })).toBeTruthy();
    expect(saved.options?.[0].size).toEqual({ ratio: '2:3', resolution: '1536px' });
    expect(await requestBody(saved)).toEqual({ mode: 'json', json: { size: '1024*1536' } });
  });
});
