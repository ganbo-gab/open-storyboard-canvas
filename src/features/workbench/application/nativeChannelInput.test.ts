import { afterEach, expect, it } from 'vitest';
import { saveChannelRecord, useChannelStore } from '@/features/channels/store/channelStore';
import { assignWorkbenchReferenceToSlot, withWorkbenchChannelDefaults } from './nativeChannelInput';
import { getWorkbenchValidationContext, validateWorkbenchDraft } from './workbenchValidation';
import type { ModelSpec } from '@/features/channels/domain/profile';
import type { WorkbenchSubmitInput } from '../domain/types';
const model: ModelSpec = { id:'image', operations:['image.generate'],params:[],modes:[{id:'text',label:'文生图',operation:'image.generate',slots:[{key:'image',label:'参考图',kind:'image',max:16}]}]};
function install(m=model){saveChannelRecord({version:2,id:'slots',name:'Slots',baseUrl:'https://example.test',auth:{type:'none'},operations:{'image.generate':{method:'POST',path:'/images',body:'json',template:{prompt:'{{prompt}}'},response:{mode:'sync',outputs:[]}}},models:[m]});}
afterEach(()=>useChannelStore.setState({channels:[]}));
it('moves retained references into a single compatible slot on selection, without hiding or losing them',()=>{
 install();
 const next=withWorkbenchChannelDefaults({kind:'image',model:'custom:slots:image',prompt:'use @图1',references:[{id:'r',kind:'image',source:'/a.png'}]},true);
 expect(next.prompt).toBe('use @图1');expect(next.referenceSlots).toEqual({image:['/a.png']});expect(next.references).toEqual([]);
 expect(validateWorkbenchDraft(next,getWorkbenchValidationContext(next)).issues).not.toContainEqual(expect.objectContaining({code:'references.slotRequired'}));
 expect(withWorkbenchChannelDefaults(next).referenceSlots).toBe(next.referenceSlots);
});
it('keeps ambiguous first/last-frame references visible for manual assignment',()=>{
 const ambiguous={...model,modes:[{...model.modes![0],slots:[{key:'first',label:'First',kind:'image' as const,max:1},{key:'last',label:'Last',kind:'image' as const,max:1}]}]};install(ambiguous);
 const refs=[{id:'r',kind:'image' as const,source:'/a.png'}];
 const next=withWorkbenchChannelDefaults({kind:'image',model:'custom:slots:image',prompt:'test',references:refs,referenceSlots:{}},true);
 expect(next.references).toBe(refs);expect(validateWorkbenchDraft(next,getWorkbenchValidationContext(next)).issues).toContainEqual(expect.objectContaining({code:'references.slotRequired'}));
});

it('keeps duplicate media mentions distinct when moving into slots',()=>{
 install();const next=withWorkbenchChannelDefaults({kind:'image',model:'custom:slots:image',prompt:'@图1 then @图2',references:[{id:'a',kind:'image',source:'/same.png'},{id:'b',kind:'image',source:'/same.png'}]},true);
 expect(next.prompt).toBe('@图1 then @图2');expect(next.referenceSlots).toEqual({image:['/same.png','/same.png']});
});

it('assigns only the selected duplicate reference and preserves every existing mention across slot order', () => {
 const specs = [{ key: 'first', label: 'First', kind: 'image' as const, max: 2 }, { key: 'last', label: 'Last', kind: 'image' as const, max: 1 }];
 const input: WorkbenchSubmitInput = { kind: 'video', model: 'fixture', prompt: 'existing @图1, chosen @图2, other @图3, @视1',
  referenceSlots: { last: ['/end.png'] }, references: [
   { id: 'chosen', kind: 'image', source: '/same.png' }, { id: 'other', kind: 'image', source: '/same.png' }, { id: 'video', kind: 'video', source: '/clip.mp4' },
  ] };
 const first = assignWorkbenchReferenceToSlot(input, specs, 'chosen', 'first');
 expect(first.prompt).toBe('existing @图2, chosen @图1, other @图3, @视频1');
 expect(first.references?.map(ref => ref.id)).toEqual(['other', 'video']);
 const second = assignWorkbenchReferenceToSlot(first, specs, 'other', 'first');
 expect(second.prompt).toBe('existing @图3, chosen @图1, other @图2, @视频1');
 expect(second.referenceSlots).toEqual({ first: ['/same.png', '/same.png'], last: ['/end.png'] });
 expect(input.referenceSlots).toEqual({ last: ['/end.png'] });
 expect(input.references).toHaveLength(3);
});

it('does not consume references when a slot is full, incompatible or missing', () => {
 const specs = [{ key: 'first', label: 'First', kind: 'image' as const, max: 1 }, { key: 'sound', label: 'Sound', kind: 'audio' as const, max: 1 }];
 const input: WorkbenchSubmitInput = { kind: 'video', model: 'fixture', prompt: 'use @图2', referenceSlots: { first: ['/start.png'] }, references: [{ id: 'image', kind: 'image', source: '/image.png' }] };
 for (const [refId, slotKey] of [['image', 'first'], ['image', 'sound'], ['image', 'missing'], ['missing', 'sound']]) {
  expect(assignWorkbenchReferenceToSlot(input, specs, refId, slotKey)).toBe(input);
 }
});
