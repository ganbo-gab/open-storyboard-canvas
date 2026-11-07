import { afterEach, describe, expect, it } from 'vitest';
import type { ModelSpec } from '@/features/channels/domain/profile';
import { useChannelStore } from '@/features/channels/store/channelStore';
import { useCustomProvidersStore } from '@/stores/customProvidersStore';
import { describeReferenceLimits, getWorkbenchValidationContext, validateWorkbenchDraft } from './workbenchValidation';
import type { WorkbenchDraft } from '../domain/types';

const draft: WorkbenchDraft = { kind: 'video', model: 'declared-model', prompt: 'A crane', channelModeId: 'frames',
  config: { seconds: 5 }, referenceSlots: { first_frame: ['/first.png'] } };
const model: ModelSpec = { id: 'declared-model', operations: ['video.generate'], params: [
  { key: 'duration', label: 'Duration', type: 'number', min: 4, max: 10 },
  { key: 'count', label: 'Count', type: 'number', min: 1, max: 3 },
  { key: 'quality', label: 'Quality', type: 'enum', options: [{ label: 'HD', value: 'hd' }] },
], modes: [{ id: 'frames', label: 'Frames', operation: 'video.generate', slots: [
  { key: 'first_frame', label: 'First frame', kind: 'image', min: 1, max: 1 },
  { key: 'sound', label: 'Sound', kind: 'audio', max: 2 },
] }] };
afterEach(() => { useChannelStore.setState({ channels: [] }); useCustomProvidersStore.setState({ providers: [] }); });

describe('declaration-derived workbench hints', () => {
  it('reports slot overflow, required minimums and kind mismatch without changing the draft', () => {
    const input = { ...draft, referenceSlots: { first_frame: ['/one.png', '/two.png'], sound: ['/clip.mp4'], typo: ['/x.png'] } };
    const original = structuredClone(input);
    const validation = validateWorkbenchDraft(input, { nativeModel: model });
    expect(validation.blocking).toBe(true);
    expect(validation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'slot', code: 'slot.maxExceeded', slotKey: 'first_frame', params: { slot: 'First frame', max: 1, count: 2 } }),
      expect.objectContaining({ code: 'slot.kindMismatch', slotKey: 'sound' }),
      expect.objectContaining({ code: 'slot.unknown', slotKey: 'typo' }),
    ]));
    expect(input).toEqual(original);
    expect(validateWorkbenchDraft({ ...draft, referenceSlots: {} }, { nativeModel: model }).issues).toContainEqual(expect.objectContaining({ code: 'slot.minNotMet' }));
  });
  it('checks duration, count and enum declarations, with mode overrides taking precedence', () => {
    const validation = validateWorkbenchDraft({ ...draft, config: { seconds: 11, extraParams: { count: 4, quality: 'sd' } } }, { nativeModel: model });
    expect(validation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'duration', code: 'param.outOfRange', paramKey: 'duration' }),
      expect.objectContaining({ field: 'count', code: 'param.outOfRange', paramKey: 'count' }),
      expect.objectContaining({ field: 'param', code: 'param.invalid', paramKey: 'quality' }),
    ]));
    const overridden = { ...model, modes: [{ ...model.modes![0], params: [{ key: 'duration', label: 'Duration', type: 'number' as const, min: 4, max: 20 }] }] };
    expect(validateWorkbenchDraft({ ...draft, config: { seconds: 11 } }, { nativeModel: overridden }).blocking).toBe(false);
  });
  it('validates every required declaration and does not replace an explicit null with a default', () => {
    const declared: ModelSpec = { ...model, params: [
      { key: 'prompt', label: 'Template prompt', type: 'text', required: true },
      { key: 'quality', label: 'Quality', type: 'enum', required: true, default: 'hd', options: [{ label: 'HD', value: 'hd' }] },
    ] };
    const validation = validateWorkbenchDraft({ ...draft, config: { extraParams: { quality: null } } }, { nativeModel: declared });
    expect(validation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'param.required', paramKey: 'prompt' }),
      expect.objectContaining({ code: 'param.required', paramKey: 'quality' }),
    ]));
    const wrongKind = validateWorkbenchDraft({ ...draft, references: [{ id: 'incorrect-label', kind: 'image', source: '/clip.mp4' }],
      referenceSlots: { first_frame: ['/clip.mp4'] } }, { nativeModel: model });
    expect(wrongKind.issues).toContainEqual(expect.objectContaining({ code: 'slot.kindMismatch', slotKey: 'first_frame' }));
  });
  it('does not invent reference, duration, count or prompt limits for unknown models', () => {
    const input: WorkbenchDraft = { kind: 'video', model: 'unknown', prompt: '猫'.repeat(20_000), config: { seconds: 900, extraParams: { count: 300 } },
      references: Array.from({ length: 40 }, (_, index) => ({ id: String(index), kind: 'image', source: `/${index}.png` })) };
    expect(validateWorkbenchDraft(input, {}).issues).toEqual([]);
    expect(describeReferenceLimits(input, {})).toEqual({});
    expect(describeReferenceLimits(input)).toEqual({});
  });
  it('reports only declared prompt lengths and reference limits, including zero', () => {
    expect(validateWorkbenchDraft({ ...draft, prompt: '猫🐈猫' }, { promptMaxLength: 2 }).issues).toContainEqual({ field: 'prompt', code: 'prompt.tooLong', params: { max: 2, count: 3 } });
    expect(describeReferenceLimits(draft, { nativeModel: model })).toEqual({ image: 1, video: 0, audio: 2 });
    expect(describeReferenceLimits(draft, { nativeModel: { ...model, modes: undefined, refs: { image: 0 } } })).toEqual({ image: 0 });
  });
  it('reads legacy catalog declarations but not fallback picker options or reference maxima', () => {
    useCustomProvidersStore.setState({ providers: [{ id: 'legacy', label: 'Legacy', models: ['video'], mediaType: 'video', apiStyle: 'comfyui',
      apiKey: '', baseUrl: '', supportsWebSearch: false, extraParams: { supportedDurations: ['5', '8'], videoInputSchema: { images: { max: 2 } } } }] });
    const input = { ...draft, model: 'custom:legacy:video', config: { seconds: 9 }, references: [{ id: 'one', kind: 'image' as const, source: '/one.png' }] };
    const context = getWorkbenchValidationContext(input);
    expect(describeReferenceLimits(input, context)).toEqual({ image: 2 });
    expect(validateWorkbenchDraft(input, context).issues).toContainEqual(expect.objectContaining({ field: 'duration', code: 'duration.unsupported' }));
    useCustomProvidersStore.setState({ providers: [{ id: 'legacy', label: 'Legacy', models: ['video'], mediaType: 'video', apiStyle: 'comfyui', apiKey: '', baseUrl: '', supportsWebSearch: false }] });
    expect(describeReferenceLimits(input)).toEqual({});
    expect(validateWorkbenchDraft(input, getWorkbenchValidationContext(input)).blocking).toBe(false);
  });
  it('resolves native declarations directly from channel state and exposes real Dreamina catalog limits', () => {
    useChannelStore.setState({ channels: [{ origin: 'native', migrationIssues: [], createdAt: 1, updatedAt: 1, profile: {
      version: 2, id: 'profile', name: 'Profile', baseUrl: 'https://example.test', auth: { type: 'none' }, operations: {}, models: [model],
    } }] });
    expect(getWorkbenchValidationContext({ ...draft, model: 'custom:profile:declared-model' }).nativeModel).toEqual(model);
    expect(describeReferenceLimits({ ...draft, kind: 'image', model: 'dreamina:3.0' })).toEqual({ image: 0 });
    expect(describeReferenceLimits({ ...draft, model: 'dreamina:frames-video:seedance2.0' })).toEqual({ image: 2, video: 0, audio: 0 });
  });
});

it('requires a channel for an old audio draft without changing its saved model or input', () => {
  const draft: WorkbenchDraft = { kind: 'audio', model: 'voxcpm-online', prompt: 'Old voice input', references: [{ id: 'old', kind: 'audio', source: '/saved.wav' }] };
  const before = structuredClone(draft);
  expect(validateWorkbenchDraft(draft, {}).issues).toContainEqual({ field: 'param', code: 'model.unavailable', params: {} });
  expect(draft).toEqual(before);
});
