import { expect, it } from 'vitest';
import { applyModelCapabilityPreset, findModelCapabilityPreset, initializeModelCapabilities } from './modelCapabilityPresets';
import type { ModelSpec } from '../domain/profile';
const chat = (id: string): ModelSpec => ({ id, operations: ['chat'], params: [] });
it('recognizes current DeepSeek vision while retaining text-only Pro and old unknown names', () => {
  expect(initializeModelCapabilities(chat('deepseek-v4.1-flash')).capabilities).toMatchObject({ contextWindow: 1_000_000, supportsMultimodal: true });
  expect(initializeModelCapabilities(chat('deepseek-flash')).capabilities?.supportsMultimodal).toBe(true);
  expect(initializeModelCapabilities(chat('deepseek-v4-pro')).capabilities?.supportsMultimodal).toBe(false);
  expect(findModelCapabilityPreset('deepseek-v4.1-flash-custom')).toBeUndefined();
  expect(findModelCapabilityPreset('deepseek-chat')).toBeUndefined();
});
it('never overrides user limits or false capability values and does not copy template capabilities', () => {
  const model = { ...chat('deepseek-flash'), capabilities: { contextWindow: 32_000, supportsMultimodal: false } };
  expect(applyModelCapabilityPreset(model).capabilities).toMatchObject({ contextWindow: 32_000, supportsMultimodal: false, supportsTools: true });
  expect(initializeModelCapabilities(model).capabilities).toMatchObject({ contextWindow: 1_000_000, supportsMultimodal: true });
  expect(initializeModelCapabilities({ ...model, id: 'unlisted-model' }).capabilities).toBeUndefined();
});
it('matches only a chat model and never edits protocol, id, parameters or existing channel data', () => {
  const media: ModelSpec = { id: 'deepseek-flash', operations: ['image.generate'], params: [] };
  expect(applyModelCapabilityPreset(media)).toBe(media);
  const source = chat('GPT-6.1-SOL');
  expect(applyModelCapabilityPreset(source)).toMatchObject({ id: source.id, operations: source.operations, params: source.params });
  expect(source.capabilities).toBeUndefined();
});
