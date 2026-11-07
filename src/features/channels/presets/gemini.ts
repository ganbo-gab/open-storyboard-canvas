import type { ChannelProfileV2 } from '../domain/profile';

export const geminiNativeProfile: ChannelProfileV2 = {
  version: 2,
  id: 'gemini-native',
  name: 'Gemini 原生',
  baseUrl: 'https://generativelanguage.googleapis.com',
  auth: { type: 'header', name: 'x-goog-api-key' },
  docsUrl: 'https://ai.google.dev/gemini-api/docs/image-generation',
  notes: [
    '比例和分辨率仅发送到 generationConfig.imageConfig；2K 等选项原样发送。',
    '参考图通过显式 geminiParts 模板变量保留每张图像的 MIME 和内容。',
    'chat 接受原生 contents/systemInstruction；历史和工具内容不做文本压平。',
    '响应路径可读取 inlineData.data，但 OutputSpec 不能保留每张图片的动态 MIME 或过滤 thought parts。',
  ],
  operations: {
    chat: {
      method: 'POST', path: '/v1beta/models/{{model}}:{{chatPayload.action}}?alt={{chatPayload.alt}}', body: 'json',
      template: {
        contents: '{{chatPayload.contents}}', systemInstruction: '{{chatPayload.systemInstruction}}',
        generationConfig: '{{chatPayload.generationConfig}}', tools: '{{chatPayload.tools}}',
        toolConfig: '{{chatPayload.toolConfig}}', safetySettings: '{{chatPayload.safetySettings}}',
        cachedContent: '{{chatPayload.cachedContent}}',
      },
      response: { mode: 'sync', outputs: [] },
      errorPath: 'error.message',
    },
    'image.generate': {
      method: 'POST', path: '/v1beta/models/{{model}}:generateContent', body: 'json',
      template: {
        contents: [{ role: 'user', parts: '{{geminiParts}}' }],
        generationConfig: {
          responseModalities: ['IMAGE'],
          imageConfig: { aspectRatio: '{{param.aspectRatio}}', imageSize: '{{param.imageSize}}' },
        },
      },
      response: {
        mode: 'sync',
        outputs: [{ path: 'candidates[*].content.parts[*].inlineData.data', as: 'base64', kind: 'image' }],
      },
      errorPath: 'error.message',
    },
    'image.edit': {
      method: 'POST', path: '/v1beta/models/{{model}}:generateContent', body: 'json',
      template: {
        contents: [{ role: 'user', parts: '{{geminiParts}}' }],
        generationConfig: {
          responseModalities: ['IMAGE'],
          imageConfig: { aspectRatio: '{{param.aspectRatio}}', imageSize: '{{param.imageSize}}' },
        },
      },
      response: { mode: 'sync', outputs: [{ path: 'candidates[*].content.parts[*].inlineData.data', as: 'base64', kind: 'image' }] },
      errorPath: 'error.message',
    },
  },
  models: [
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', operations: ['chat'], params: [
      { key: 'stream', label: '流式输出', type: 'boolean', default: false },
    ] },
    {
      id: 'gemini-3.1-flash-image', label: 'Gemini 3.1 Flash Image', operations: ['image.generate', 'image.edit'], refs: { image: 14 },
      params: [
        {
          key: 'aspectRatio', label: '比例', type: 'enum', default: '1:1',
          options: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '21:9']
            .map((value) => ({ label: value, value })),
        },
        {
          key: 'imageSize', label: '分辨率', type: 'enum', default: '2K',
          options: ['1K', '2K', '4K'].map((value) => ({ label: value, value })),
        },
      ],
    },
  ],
};
