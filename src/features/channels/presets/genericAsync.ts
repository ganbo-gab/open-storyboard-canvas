import type { ChannelProfileV2 } from '../domain/profile';

/** Deliberately non-routable example; replace all upstream-specific fields before use. */
export const genericAsyncProfile: ChannelProfileV2 = {
  version: 2,
  id: 'generic-async',
  name: '异步任务通用（需按文档配置）',
  baseUrl: 'https://api.example.invalid',
  auth: { type: 'bearer' },
  notes: [
    '这是接入骨架，不是供应商协议：必须按文档填写 baseUrl、提交/查询路径、模型、taskIdPath、状态和输出路径后再提交。',
    '示例假设 POST /tasks 返回 id，GET /tasks/{id} 返回 status 和 output.url；这些字段不是对任意中转站的推断。',
  ],
  operations: {
    'video.generate': {
      method: 'POST', path: '/tasks', body: 'json',
      template: { model: '{{model}}', prompt: '{{prompt}}' },
      response: {
        mode: 'async', taskIdPath: 'id',
        poll: {
          method: 'GET', path: '/tasks/{{taskId}}', intervalSec: 5, timeoutMin: 20,
          statusPath: 'status', success: ['completed'], failure: ['failed', 'cancelled'],
          outputs: [{ path: 'output.url', as: 'url', kind: 'video' }],
        },
      },
      errorPath: 'error.message',
    },
  },
  models: [{ id: 'replace-with-upstream-model', operations: ['video.generate'], params: [] }],
};
