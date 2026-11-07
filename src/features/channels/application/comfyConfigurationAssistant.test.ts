import { expect, it, vi } from 'vitest';
vi.mock('../runtime/channelChat', () => ({ submitCustomChatCompletion: vi.fn() }));
import { comfyStructureForAssistant, parseComfyConfigurationSuggestion } from './comfyConfigurationAssistant';
const workflow = {
  '1': { class_type: 'CLIPTextEncode', inputs: { text: 'PRIVATE PROMPT', api_key: 'PRIVATE KEY' } },
  '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: '/private/path' } },
};
it('shares structural links but no prompt, paths, credentials or arbitrary array contents', () => {
  const text = JSON.stringify(comfyStructureForAssistant({ ...workflow, '3': { class_type: 'Custom', inputs: { secrets: ['PRIVATE ARRAY', 0] } } }));
  expect(text).not.toContain('PRIVATE'); expect(text).not.toContain('/private/path'); expect(text).toContain('["1",0]');
});
it('accepts real writable inputs and rejects fabricated nodes, links and output nodes', () => {
  const suggestion = { bindings: { prompt: { nodeId: '1', input: 'text' } }, outputNodeIds: ['2'], explanation: 'Use the text encoder.' };
  expect(parseComfyConfigurationSuggestion(JSON.stringify(suggestion), workflow)).toEqual(suggestion);
  expect(() => parseComfyConfigurationSuggestion(JSON.stringify({ ...suggestion, bindings: { prompt: { nodeId: '404', input: 'text' } } }), workflow)).toThrow();
  expect(() => parseComfyConfigurationSuggestion(JSON.stringify({ ...suggestion, bindings: { prompt: { nodeId: '2', input: 'images' } } }), workflow)).toThrow();
  expect(() => parseComfyConfigurationSuggestion(JSON.stringify({ ...suggestion, outputNodeIds: ['1'] }), workflow)).toThrow();
  expect(() => parseComfyConfigurationSuggestion(JSON.stringify({ ...suggestion, bindings: { prompt: { nodeId: '1', input: 'api_key' } } }), workflow)).toThrow();
});
