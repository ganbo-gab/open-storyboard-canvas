import type { ChannelProfileV2, ModelSpec, ParamSpec } from '../domain/profile';

const params: ParamSpec[] = [
  {
    key: 'aspect_ratio', label: '比例', type: 'enum', default: '1:1',
    options: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '21:9']
      .map((value) => ({ label: value, value })),
  },
  {
    key: 'image_size', label: '分辨率', type: 'enum', default: '1K',
    options: ['1K', '2K', '4K'].map((value) => ({ label: value, value })),
  },
];

// Wire contract: src-tauri/src/ai/providers/grsai/mod.rs, wrapped {code,data} variant.
export const grsaiProfile: ChannelProfileV2 = {
  version: 2,
  id: 'grsai',
  name: 'GRSAI',
  baseUrl: 'https://grsai.dakka.com.cn',
  auth: { type: 'bearer' },
  notes: [
    '使用 {code:0,data:{id,status,results}} 包装响应；裸响应须按供应商文档调整 taskIdPath/statusPath/outputs。',
    '成功以 results URL 出现为准，不虚构 completed/succeeded 状态。',
    'v2 不支持同一提交既同步返回 results 又异步返回 id，或 HTTP 200 中非零 code 的独立错误断言；这些旧 Rust 行为仍需原 provider。',
    '旧 Rust 适配器未声明参考图数量上限；此预设不额外截断，上游实际限制仍须核对供应商文档。',
  ],
  operations: {
    'image.generate': {
      method: 'POST', path: '/v1/draw/nano-banana', body: 'json',
      template: {
        model: '{{model}}', prompt: '{{prompt}}', aspectRatio: '{{param.aspect_ratio}}',
        imageSize: '{{param.image_size}}', webHook: '-1', shutProgress: true,
      },
      response: {
        mode: 'async', taskIdPath: 'data.id',
        poll: {
          method: 'POST', path: '/v1/draw/result', template: { id: '{{taskId}}' },
          intervalSec: 2, timeoutMin: 20,
          statusPath: 'data.status', success: [], failure: ['failed'],
          outputs: [{ path: 'data.results[*].url', as: 'url', kind: 'image' }],
        },
      },
      errorPath: 'msg',
    },
    'image.edit': {
      method: 'POST', path: '/v1/draw/nano-banana', body: 'json', imageEncoding: 'base64',
      template: {
        model: '{{model}}', prompt: '{{prompt}}', aspectRatio: '{{param.aspect_ratio}}',
        imageSize: '{{param.image_size}}', urls: '{{images}}', webHook: '-1', shutProgress: true,
      },
      response: {
        mode: 'async', taskIdPath: 'data.id',
        poll: {
          method: 'POST', path: '/v1/draw/result', template: { id: '{{taskId}}' },
          intervalSec: 2, timeoutMin: 20,
          statusPath: 'data.status', success: [], failure: ['failed'],
          outputs: [{ path: 'data.results[*].url', as: 'url', kind: 'image' }],
        },
      },
      errorPath: 'msg',
    },
  },
  models: ['nano-banana-2', 'nano-banana-pro', 'nano-banana-pro-vt', 'nano-banana-pro-cl', 'nano-banana-pro-vip', 'nano-banana-pro-4k-vip']
    .map<ModelSpec>((id) => ({
      id, operations: ['image.generate', 'image.edit'],
      params: params.map((param) => param.key !== 'image_size' ? param : {
        ...param,
        ...(id === 'nano-banana-pro-vip' ? { options: param.options!.filter((option) => option.value !== '4K') } : {}),
        ...(id === 'nano-banana-pro-4k-vip' ? { options: param.options!.filter((option) => option.value === '4K'), default: '4K' } : {}),
      }),
      refs: { image: Number.MAX_SAFE_INTEGER },
      mention: 'natural',
    })),
};
