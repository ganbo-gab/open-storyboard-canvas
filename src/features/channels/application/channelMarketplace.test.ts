import { expect, it } from 'vitest';
import { channelConnectionShape, channelModelListings } from './channelMarketplace';
import { copyModelConnection } from './modelConnection';
import { genericAudioProfile } from '../presets/audio';
import { channelProfileSchema, type ChannelProfileV2 } from '../domain/profile';
import type { ChannelRecord } from '../store/channelStore';
import { renderPreview } from '../domain/template';
const profile: ChannelProfileV2 = { version: 2, id: 'mixed', name: 'Mixed gateway', baseUrl: 'https://relay.example', auth: { type: 'none' },
  operations: { chat: { method: 'POST', path: '/chat', body: 'json', template: { model: '{{model}}', messages: '{{messages}}' }, response: { mode: 'sync', outputs: [] } } },
  models: [{ id: 'chat', operations: ['chat'], params: [], refs: { audio: 1 } }] };
const record: ChannelRecord = { profile, origin: 'native', migrationIssues: [], createdAt: 1, updatedAt: 1 };
it('filters actual output capability rather than reference input type and distinguishes mixed channels', () => {
  expect(channelModelListings([record], { query: '', capability: 'audio' })).toEqual([]);
  expect(channelConnectionShape(record)).toBe('single');
  const audio = copyModelConnection(genericAudioProfile, genericAudioProfile.models[0], 'speech', profile);
  const mixed = { ...record, profile: { ...profile, models: [...profile.models, audio] } };
  expect(channelConnectionShape(mixed)).toBe('mixed');
  expect(channelModelListings([mixed], { query: 'gateway', capability: 'audio' }).map((entry) => entry.model.id)).toEqual(['speech']);
  expect(channelModelListings([mixed], { query: 'speech', capability: 'chat' })).toEqual([]);
});
it('adds a new category without overwriting the existing channel contract or copying template credentials', () => {
  const audio = copyModelConnection(genericAudioProfile, genericAudioProfile.models[0], 'speech', profile);
  const merged = channelProfileSchema.parse({ ...profile, models: [...profile.models, audio] });
  expect(merged.operations.chat).toEqual(profile.operations.chat);
  expect(merged.auth).toEqual({ type: 'none' });
  const preview = renderPreview(merged, { jobId: 'check', channelId: 'mixed', modelId: 'speech', modeId: audio.modes![0].id, operation: 'audio.generate', prompt: 'Hello', params: { speed: 1 }, refs: [], count: 1 });
  expect(preview.url).toBe('https://relay.example/v1/audio/generations');
});

it('rejects copying a contract whose required transport headers would be lost', () => {
  expect(() => copyModelConnection({ ...genericAudioProfile, headers: { 'X-Async': 'enable' } }, genericAudioProfile.models[0], 'speech', profile)).toThrow('incompatible channel headers');
  expect(copyModelConnection({ ...genericAudioProfile, headers: { 'X-Async': 'enable' } }, genericAudioProfile.models[0], 'speech', { ...profile, headers: { 'x-async': 'enable' } }).id).toBe('speech');
});

it('keeps each individually selected template model valid as a single-model connection', async () => {
  const { builtInPresets } = await import('../presets');
  for (const preset of builtInPresets) for (const model of preset.models) {
    expect(channelProfileSchema.safeParse({ ...preset, models: [model] }).success, `${preset.id}/${model.id}`).toBe(true);
  }
});
