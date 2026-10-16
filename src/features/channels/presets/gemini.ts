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
    '当前模板语言不能逐图构造含动态 mimeType 的 inlineData parts，因此不声明 image.edit 或参考图支持。',
    'chat 为单轮 prompt；标准 messages 到 Gemini contents 的角色/parts 转换不能由此模板表达。',
    '响应路径可读取 inlineData.data，但 OutputSpec 不能保留每张图片的动态 MIME 或过滤 thought parts。',
  ],
  operations: {
    chat: {
      method: 'POST', path: '/v1beta/models/{{model}}:generateContent', body: 'json',
      template: { contents: [{ role: 'user', parts: [{ text: '{{prompt}}' }] }] },
      response: { mode: 'sync', outputs: [] },
      errorPath: 'error.message',
    },
    'image.generate': {
      method: 'POST', path: '/v1beta/models/{{model}}:generateContent', body: 'json',
      template: {
        contents: [{ role: 'user', parts: [{ text: '{{prompt}}' }] }],
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
  },
  models: [
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', operations: ['chat'], params: [] },
    {
      id: 'gemini-3.1-flash-image', label: 'Gemini 3.1 Flash Image', operations: ['image.generate'],
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
