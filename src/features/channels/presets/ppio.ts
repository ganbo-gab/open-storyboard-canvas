import type { ChannelProfileV2 } from '../domain/profile';

// Wire contract: src-tauri/src/ai/providers/ppio/models/gemini_3_1_flash.rs.
export const ppioProfile: ChannelProfileV2 = {
  version: 2,
  id: 'ppio',
  name: 'PPIO',
  baseUrl: 'https://api.ppio.com',
  auth: { type: 'bearer' },
  notes: [
    '参考图以原始 base64 数组发送，不包含 data: MIME 前缀；模型名不加入请求体。',
    '旧 Rust 适配器未声明参考图数量上限；此预设不额外截断，上游实际限制仍须核对供应商文档。',
  ],
  operations: {
    'image.generate': {
      method: 'POST', path: '/v3/gemini-3.1-flash-image-text-to-image', body: 'json',
      template: {
        prompt: '{{prompt}}', size: '{{param.size}}',
        aspect_ratio: '{{param.aspect_ratio}}', output_format: 'image/png',
      },
      response: { mode: 'sync', outputs: [{ path: 'image_urls[*]', as: 'url', kind: 'image' }] },
    },
    'image.edit': {
      method: 'POST', path: '/v3/gemini-3.1-flash-image-edit', body: 'json', imageEncoding: 'base64',
      template: {
        prompt: '{{prompt}}', size: '{{param.size}}', aspect_ratio: '{{param.aspect_ratio}}',
        image_base64s: '{{images}}', output_format: 'image/png',
      },
      response: { mode: 'sync', outputs: [{ path: 'image_urls[*]', as: 'url', kind: 'image' }] },
    },
  },
  models: [
    {
      id: 'gemini-3.1-flash', label: 'Nano Banana 2（PPIO）', operations: ['image.generate', 'image.edit'],
      params: [
        {
          key: 'aspect_ratio', label: '比例', type: 'enum', default: '1:1',
          options: ['1:1', '1:4', '1:8', '9:16', '16:9', '2:1', '3:4', '4:3', '4:1', '8:1', '2:3', '3:2', '5:4', '4:5', '21:9']
            .map((value) => ({ label: value, value })),
        },
        {
          key: 'size', label: '分辨率', type: 'enum', default: '2K',
          options: ['0.5K', '1K', '2K', '4K'].map((value) => ({ label: value, value })),
        },
      ],
      refs: { image: Number.MAX_SAFE_INTEGER },
      mention: 'natural',
    },
  ],
};
