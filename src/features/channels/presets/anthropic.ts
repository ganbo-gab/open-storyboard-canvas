import type { ChannelProfileV2 } from '../domain/profile';

export const anthropicProfile: ChannelProfileV2 = {
  version: 2,
  id: 'anthropic-messages',
  name: 'Anthropic Messages',
  baseUrl: 'https://api.anthropic.com',
  auth: { type: 'header', name: 'x-api-key' },
  headers: { 'anthropic-version': '2023-06-01' },
  docsUrl: 'https://docs.anthropic.com/en/api/messages',
  notes: [
    '调用方提供原生 messages/system 和工具内容块；预设不把历史或图像压平成文本。',
  ],
  operations: {
    chat: {
      method: 'POST', path: '/v1/messages', body: 'json',
      template: {
        model: '{{model}}', messages: '{{messages}}',
        max_tokens: '{{param.max_tokens}}', temperature: '{{param.temperature}}',
        system: '{{chatPayload.system}}', tools: '{{chatPayload.tools}}', tool_choice: '{{chatPayload.tool_choice}}',
        thinking: '{{chatPayload.thinking}}', stop_sequences: '{{chatPayload.stop_sequences}}',
        metadata: '{{chatPayload.metadata}}', stream: '{{param.stream}}', top_p: '{{param.top_p}}',
      },
      response: { mode: 'sync', outputs: [] },
      errorPath: 'error.message',
    },
  },
  models: [
    {
      id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', operations: ['chat'],
      params: [
        { key: 'max_tokens', label: '最大输出 token', type: 'number', min: 1, step: 1, default: 4096, required: true },
        { key: 'temperature', label: 'Temperature', type: 'number', min: 0, max: 1, step: 0.1 },
        { key: 'top_p', label: 'Top P', type: 'number', min: 0, max: 1 },
        { key: 'stream', label: '流式输出', type: 'boolean', default: false },
      ],
    },
  ],
};
