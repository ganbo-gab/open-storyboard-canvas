import type { AsyncResponse, ChannelProfileV2, ParamSpec } from '../domain/profile';

const response: AsyncResponse = {
  mode: 'async', taskIdPath: 'request_id',
  poll: {
    method: 'GET', path: '{{submit.status_url}}', intervalSec: 2, timeoutMin: 20,
    statusPath: 'status', success: ['COMPLETED'], failure: ['FAILED', 'ERROR', 'CANCELLED'],
    resultRequest: { method: 'GET', path: '{{submit.response_url}}' },
    outputs: [
      { path: 'images[*].url', as: 'url', kind: 'image' },
      { path: 'images[*].image.url', as: 'url', kind: 'image' },
      { path: 'response.images[*].url', as: 'url', kind: 'image' },
      { path: 'response.images[*].image.url', as: 'url', kind: 'image' },
    ],
  },
};

const params: ParamSpec[] = [
  {
    key: 'aspect_ratio', label: '比例', type: 'enum', default: '1:1',
    options: ['21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16']
      .map((value) => ({ label: value, value })),
  },
  {
    key: 'resolution', label: '分辨率', type: 'enum', default: '1K',
    options: ['0.5K', '1K', '2K', '4K'].map((value) => ({ label: value, value })),
  },
  { key: 'enable_web_search', label: '联网搜索', type: 'boolean', default: false },
  {
    key: 'thinking_level', label: 'Thinking level', type: 'enum',
    options: ['minimal', 'high'].map((value) => ({ label: value, value })),
  },
];

// Wire contract: src-tauri/src/ai/providers/fal/mod.rs. Model IDs are real queue paths.
export const falProfile: ChannelProfileV2 = {
  version: 2,
  id: 'fal',
  name: 'fal Queue',
  baseUrl: 'https://queue.fal.run',
  auth: { type: 'header', name: 'Authorization', prefix: 'Key ' },
  headers: { 'X-Fal-No-Retry': '1' },
  docsUrl: 'https://docs.fal.ai/model-apis/model-endpoints/queue',
  notes: [
    '先查询提交响应的 status_url，COMPLETED 后单独读取 response_url；不将状态响应误当作生成结果。',
    '提交响应必须提供 status_url 和 response_url；旧 Rust 在 URL 缺失或 404/405 时尝试备用路径，此静态模板不推断备用端点。',
    'thinking_level 未设置即省略；不向上游发送旧界面的 off。',
    '旧 Rust 适配器未声明参考图数量上限；此预设不额外截断，上游实际限制仍须核对供应商文档。',
  ],
  operations: {
    'image.generate': {
      method: 'POST', path: '/{{model}}', body: 'json',
      template: {
        prompt: '{{prompt}}', num_images: 1, aspect_ratio: '{{param.aspect_ratio}}',
        output_format: 'png', safety_tolerance: 6, resolution: '{{param.resolution}}',
        limit_generations: true, enable_web_search: '{{param.enable_web_search}}',
        thinking_level: '{{param.thinking_level}}',
      },
      response,
    },
    'image.edit': {
      method: 'POST', path: '/{{model}}/edit', body: 'json', imageEncoding: 'data-url',
      template: {
        prompt: '{{prompt}}', num_images: 1, aspect_ratio: '{{param.aspect_ratio}}',
        output_format: 'png', safety_tolerance: 6, resolution: '{{param.resolution}}',
        limit_generations: true, enable_web_search: '{{param.enable_web_search}}',
        thinking_level: '{{param.thinking_level}}', image_urls: '{{images}}',
      },
      response,
    },
  },
  models: [
    {
      id: 'fal-ai/nano-banana-2', label: 'Nano Banana 2（fal）',
      operations: ['image.generate', 'image.edit'], params,
      refs: { image: Number.MAX_SAFE_INTEGER }, mention: 'natural',
    },
    {
      id: 'fal-ai/nano-banana-pro', label: 'Nano Banana Pro（fal）',
      operations: ['image.generate', 'image.edit'], params,
      refs: { image: Number.MAX_SAFE_INTEGER }, mention: 'natural',
    },
  ],
};
