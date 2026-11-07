import { afterEach, expect, it } from 'vitest';
import { saveChannelRecord, useChannelStore } from '@/features/channels/store/channelStore';
import { appendWorkbenchReferences } from './appendReferences';
import type { WorkbenchDraft } from '../domain/types';
afterEach(() => useChannelStore.setState({ channels: [] }));
it('fills declared slots for result reuse and rejects a full mode atomically', () => {
  saveChannelRecord({ version: 2, id: 'frames', name: 'Frames', baseUrl: 'http://127.0.0.1:15641', auth: { type: 'none' },
    operations: { 'image.generate': { method: 'POST', path: '/images', body: 'json', template: { prompt: '{{prompt}}' }, response: { mode: 'sync', outputs: [] } } },
    models: [{ id: 'image', operations: ['image.generate'], params: [], modes: [{ id: 'pair', label: 'First/last', operation: 'image.generate', slots: [
      { key: 'first', kind: 'image', label: 'First', max: 1 }, { key: 'last', kind: 'image', label: 'Last', max: 1 },
    ] }] }] });
  const draft: WorkbenchDraft = { kind: 'image', model: 'custom:frames:image', channelModeId: 'pair', prompt: 'Use @图1', referenceSlots: { first: ['/first.png'] } };
  expect(appendWorkbenchReferences(draft, [{ id: 'r', kind: 'image', source: '/last.png' }])).toEqual({ referenceSlots: { first: ['/first.png'], last: ['/last.png'] }, prompt: 'Use @图1' });
  expect(() => appendWorkbenchReferences(draft, [{ id: 'r', kind: 'image', source: '/last.png' }, { id: 'excess', kind: 'image', source: '/extra.png' }])).toThrow('workbench.referenceSlotFull');
  expect(draft.referenceSlots).toEqual({ first: ['/first.png'] });
});
