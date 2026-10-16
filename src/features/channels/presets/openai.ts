import type { ChannelProfileV2 } from '../domain/profile';

/** OpenAI's JSON generation and explicit repeated image[] multipart edit contract. */
export const openAIStandardProfile: ChannelProfileV2 = {
  version: 2,
  id: 'openai-standard',
  name: 'OpenAI 标准',
  baseUrl: 'https://api.openai.com',
  auth: { type: 'bearer' },
  docsUrl: 'https://platform.openai.com/docs/api-reference',
  operations: {
    chat: {
      method: 'POST',
      path: '/v1/chat/completions',
      body: 'json',
      template: {
        model: '{{model}}',
        messages: '{{messages}}',
        temperature: '{{param.temperature}}',
        max_tokens: '{{param.max_tokens}}',
      },
      response: { mode: 'sync', outputs: [] },
      errorPath: 'error.message',
    },
    'image.generate': {
      method: 'POST',
      path: '/v1/images/generations',
      body: 'json',
      template: {
        model: '{{model}}',
        prompt: '{{prompt}}',
        n: '{{param.n}}',
        size: '{{param.size}}',
        quality: '{{param.quality}}',
      },
      response: {
        mode: 'sync',
        outputs: [
          { path: 'data[*].b64_json', as: 'base64', kind: 'image' },
          { path: 'data[*].url', as: 'url', kind: 'image' },
        ],
      },
      errorPath: 'error.message',
    },
    'image.edit': {
      method: 'POST',
      path: '/v1/images/edits',
      body: 'multipart',
      files: { field: 'image[]', cardinality: 'repeat' },
      template: {
        model: '{{model}}',
        prompt: '{{prompt}}',
        n: '{{param.n}}',
        size: '{{param.size}}',
        quality: '{{param.quality}}',
      },
      response: {
        mode: 'sync',
        outputs: [
          { path: 'data[*].b64_json', as: 'base64', kind: 'image' },
          { path: 'data[*].url', as: 'url', kind: 'image' },
        ],
      },
      errorPath: 'error.message',
    },
    'models.list': {
      method: 'GET',
      path: '/v1/models',
      body: 'none',
      response: { mode: 'sync', outputs: [] },
      errorPath: 'error.message',
    },
  },
  models: [
    {
      id: 'gpt-4o-mini',
      label: 'GPT-4o mini',
      operations: ['chat'],
      params: [
        { key: 'temperature', label: 'Temperature', type: 'number', min: 0, max: 2, step: 0.1 },
        { key: 'max_tokens', label: '最大输出 token', type: 'number', min: 1, step: 1 },
      ],
    },
    {
      id: 'gpt-image-1',
      label: 'GPT Image 1',
      operations: ['image.generate', 'image.edit'],
      params: [
        { key: 'n', label: '数量', type: 'number', min: 1, max: 10, step: 1, default: 1 },
        {
          key: 'size', label: '尺寸', type: 'enum', default: '1024x1024',
          options: ['1024x1024', '1536x1024', '1024x1536', 'auto'].map((value) => ({ label: value, value })),
        },
        {
          key: 'quality', label: '质量', type: 'enum',
          options: ['auto', 'low', 'medium', 'high'].map((value) => ({ label: value, value })),
        },
      ],
      refs: { image: 16 },
      mention: 'natural',
    },
  ],
};

/** Relay video dialect: explicit JSON /v1/videos, not a guessed universal video API. */
export const openAICompatibleProfile: ChannelProfileV2 = {
  ...openAIStandardProfile,
  id: 'openai-compatible',
  name: 'OpenAI 兼容中转',
  baseUrl: 'https://relay.example.invalid',
  notes: [
    '请替换 baseUrl 并核对模型名；new-api / one-api 的具体视频字段以中转站文档为准。',
    '视频预设采用 model/prompt/seconds/size JSON 方言，完成后鉴权下载 /v1/videos/{taskId}/content；不推断 CC API 的 input/parameters 方言。',
  ],
  operations: {
    ...openAIStandardProfile.operations,
    'video.generate': {
      method: 'POST',
      path: '/v1/videos',
      body: 'json',
      template: {
        model: '{{model}}', prompt: '{{prompt}}',
        seconds: '{{param.seconds}}', size: '{{param.size}}',
      },
      response: {
        mode: 'async', taskIdPath: 'id',
        poll: {
          method: 'GET', path: '/v1/videos/{{taskId}}', intervalSec: 5, timeoutMin: 20,
          statusPath: 'status', success: ['completed'], failure: ['failed', 'cancelled'],
          progressPath: 'progress', outputs: [{ url: '/v1/videos/{{taskId}}/content', kind: 'video', auth: true }],
        },
      },
      errorPath: 'error.message',
    },
  },
  models: [
    ...openAIStandardProfile.models,
    {
      id: 'sora-2', label: 'Sora 2（核对中转站模型名）', operations: ['video.generate'],
      params: [
        {
          key: 'seconds', label: '时长（秒）', type: 'enum', default: '4',
          options: ['4', '8', '12'].map((value) => ({ label: value, value })),
        },
        {
          key: 'size', label: '尺寸', type: 'enum', default: '1280x720',
          options: ['1280x720', '720x1280'].map((value) => ({ label: value, value })),
        },
      ],
    },
  ],
};
