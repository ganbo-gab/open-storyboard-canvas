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
    'messages 仅接受 user/assistant 角色；顶层 system 提示词、工具调用和 Anthropic 图像内容块转换不由此预设推断。',
  ],
  operations: {
    chat: {
      method: 'POST', path: '/v1/messages', body: 'json',
      template: {
        model: '{{model}}', messages: '{{messages}}',
        max_tokens: '{{param.max_tokens}}', temperature: '{{param.temperature}}',
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
      ],
    },
  ],
};
