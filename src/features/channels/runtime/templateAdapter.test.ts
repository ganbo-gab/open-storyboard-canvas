import { describe, expect, it, vi } from 'vitest';
import { TemplateAdapter } from './templateAdapter';
import type { ChannelProfileV2 } from '../domain/profile';
import type { JobInput } from './types';
import { geminiNativeProfile } from '../presets/gemini';

const job: JobInput = { jobId: 'j', channelId: 'c', modelId: 'm', operation: 'image.edit', prompt: '猫', params: {}, refs: [], count: 1 };
function profile(): ChannelProfileV2 {
  return { version: 2, id: 'c', name: '渠道', baseUrl: 'https://api.example.com', auth: { type: 'bearer' },
    operations: { 'image.edit': { method: 'POST', path: '/v1/images/edits', body: 'multipart', files: { field: 'image[]', cardinality: 'array' }, template: { model: '{{model}}', prompt: '{{prompt}}' }, response: { mode: 'sync', outputs: [{ path: 'data[*].url', as: 'url' }] }, errorPath: 'error.message' } },
    models: [{ id: 'm', operations: ['image.edit'], params: [] }] };
}
describe('TemplateAdapter submission safety', () => {
  it('reports a denied credential read as pre-submit failure, never unknown or retryable', async () => {
    const http = vi.fn().mockRejectedValue('{"state":"locked","code":"storage_locked"}');
    const adapter = new TemplateAdapter({ profile: profile(), apiKey: 'opaque-ref', http, resolveRef: async () => '' });
    expect(await adapter.submit(job)).toMatchObject({ state: 'failed', error: { category: 'credential', retryable: false } });
    expect(http).toHaveBeenCalledOnce();
  });
  it('keeps reference-download authorization failures recoverable without sending the paid submission', async () => {
    const http = vi.fn();
    const resolveRef = vi.fn().mockRejectedValue('{"state":"locked","code":"storage_locked"}');
    const config = profile();
    config.models[0].refs = { image: 1 };
    config.operations['image.edit']!.template = { model: '{{model}}', prompt: '{{prompt}}', image: '{{image}}' };
    const adapter = new TemplateAdapter({ profile: config, apiKey: 'opaque-ref', http, resolveRef });
    const result = await adapter.submit({ ...job, refs: [{ kind: 'image', assetId: 'reference', path: 'https://fixture.test/reference.png', mime: 'image/png' }] });
    expect(result).toMatchObject({ state: 'failed', error: { category: 'credential', retryable: false } });
    expect(resolveRef).toHaveBeenCalledOnce(); expect(http).not.toHaveBeenCalled();
  });
  it('#9 missing model blocks images/edits before HTTP', async () => {
    const http = vi.fn(); const adapter = new TemplateAdapter({ profile: profile(), apiKey: 'secret', http, resolveRef: async () => '' });
    expect(await adapter.submit({ ...job, modelId: '' })).toMatchObject({ state: 'failed', error: { category: 'validation', retryable: false } });
    expect(http).not.toHaveBeenCalled();
  });
  it('#5 Gemini sends native imageConfig fields and 2K verbatim through HTTP', async () => {
    const http = vi.fn().mockResolvedValue({ status: 200, headers: {}, bodyText: '{"candidates":[{"content":{"parts":[{"inlineData":{"data":"AAAA"}}]}}]}' });
    const adapter = new TemplateAdapter({ profile: geminiNativeProfile, apiKey: 'secret', http, resolveRef: async () => '' });
    const result = await adapter.submit({ ...job, channelId: geminiNativeProfile.id, modelId: 'gemini-3.1-flash-image', operation: 'image.generate', params: { aspectRatio: '16:9', imageSize: '2K' } });
    expect(result.state).toBe('done');
    expect(http).toHaveBeenCalledTimes(1);
    expect(http.mock.calls[0][0].body).toMatchObject({ mode: 'json', json: { generationConfig: { imageConfig: { aspectRatio: '16:9', imageSize: '2K' } } } });
    expect(JSON.stringify(http.mock.calls[0][0].body)).not.toContain('responseFormat');
  });
  it('#7 timeout after send becomes unknown and calls HTTP exactly once', async () => {
    const http = vi.fn().mockRejectedValue(Object.assign(new Error('request timeout after send'), { sent: true }));
    const adapter = new TemplateAdapter({ profile: profile(), apiKey: 'secret', http, resolveRef: async () => '' });
    expect(await adapter.submit(job)).toMatchObject({ state: 'unknown', error: { category: 'timeout', retryable: false } });
    expect(http).toHaveBeenCalledTimes(1);
  });
  it('DNS/connection refused before send fails retryably without retrying itself', async () => {
    const http = vi.fn().mockRejectedValue(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }));
    const adapter = new TemplateAdapter({ profile: profile(), apiKey: 'secret', http, resolveRef: async () => '' });
    expect(await adapter.submit(job)).toMatchObject({ state: 'failed', error: { category: 'network', retryable: true } });
    expect(http).toHaveBeenCalledTimes(1);
  });
  it('normalizes explicit HTTP failures and keeps the verbatim provider response', async () => {
    const body = '{"error":{"message":"invalid key 原文"}}';
    const http = vi.fn().mockResolvedValue({ status: 401, headers: {}, bodyText: body });
    const adapter = new TemplateAdapter({ profile: profile(), apiKey: 'secret', http, resolveRef: async () => '' });
    expect(await adapter.submit(job)).toMatchObject({ state: 'failed', error: { category: 'auth', status: 401, upstreamMessage: body } });
  });
  it('returns successful sync outputs from byte responses', async () => {
    const http = vi.fn().mockResolvedValue({ status: 200, headers: {}, bodyBytes: new TextEncoder().encode('{"data":[{"url":"https://assets.example/a.png"}]}') });
    const adapter = new TemplateAdapter({ profile: profile(), apiKey: 'secret', http, resolveRef: async () => '' });
    expect(await adapter.submit(job)).toEqual({ state: 'done', outputs: [{ kind: 'image', source: { type: 'url', url: 'https://assets.example/a.png' } }] });
  });
  it('returns unknown instead of encouraging resubmission when async ID is absent', async () => {
    const p = profile(); p.operations['image.edit']!.response = { mode: 'async', taskIdPath: 'id', poll: { method: 'GET', path: '/jobs/{{taskId}}', intervalSec: 1, timeoutMin: 1, statusPath: 'status', success: ['done'], failure: ['failed'], outputs: [] } };
    const http = vi.fn().mockResolvedValue({ status: 200, headers: {}, bodyText: '{}' });
    const adapter = new TemplateAdapter({ profile: p, apiKey: 'secret', http, resolveRef: async () => '' });
    expect(await adapter.submit(job)).toMatchObject({ state: 'unknown', error: { retryable: false } });
  });
});
describe('TemplateAdapter polling and auxiliary operations', () => {
  it('stops polling on vault rejection instead of treating it as transient network trouble', async () => {
    const p = profile(); p.operations['image.edit']!.response = { mode: 'async', taskIdPath: 'id', poll: { method: 'GET', path: '/jobs/{{taskId}}', intervalSec: 2, timeoutMin: 2, statusPath: 'status', success: ['done'], failure: ['failed'], outputs: [] } };
    const http = vi.fn().mockRejectedValue(new Error('{"state":"error","code":"storage_failed"}'));
    const adapter = new TemplateAdapter({ profile: p, apiKey: 'opaque-ref', http, resolveRef: async () => '' });
    expect(await adapter.poll(job, 'accepted-task')).toMatchObject({ state: 'failed', error: { category: 'credential', retryable: false } });
    expect(http).toHaveBeenCalledOnce();
  });
  it('submits once then follows submit status/result URLs and Key auth', async () => {
    const p = profile(); p.auth = { type: 'header', name: 'Authorization', prefix: 'Key ' };
    p.operations['image.edit']!.response = { mode: 'async', taskIdPath: 'id', poll: { method: 'GET', path: '{{submit.status_url}}', resultRequest: { method: 'GET', path: '{{submit.response_url}}' }, intervalSec: 1, timeoutMin: 1, statusPath: 'status', success: ['COMPLETED'], failure: ['FAILED'], outputs: [{ path: 'images[*].url', as: 'url' }] } };
    const http = vi.fn().mockResolvedValueOnce({ status: 200, headers: {}, bodyText: '{"id":"t1","status_url":"https://api.example.com/status/t1","response_url":"https://api.example.com/result/t1"}' }).mockResolvedValueOnce({ status: 200, headers: {}, bodyText: '{"status":"COMPLETED"}' }).mockResolvedValueOnce({ status: 200, headers: {}, bodyText: '{"images":[{"url":"https://asset/a.png"}]}' });
    const adapter = new TemplateAdapter({ profile: p, apiKey: 'secret', http, resolveRef: async () => '' });
    expect(await adapter.submit(job)).toEqual({ state: 'submitted', taskId: 't1' });
    expect(await adapter.poll(job, 't1')).toEqual({ state: 'done', outputs: [{ kind: 'image', source: { type: 'url', url: 'https://asset/a.png' } }] });
    expect(http.mock.calls.map(([request]) => [request.method, request.url, request.headers.Authorization])).toEqual([['POST', 'https://api.example.com/v1/images/edits', 'Key secret'], ['GET', 'https://api.example.com/status/t1', 'Key secret'], ['GET', 'https://api.example.com/result/t1', 'Key secret']]);
  });
  it('restores a poll-result file handle and retrieves it with GET only, without substituting the task ID', async () => {
    const p = profile();
    p.operations['image.edit']!.response = { mode: 'async', taskIdPath: 'task_id', poll: {
      method: 'GET', path: '/query?task_id={{taskId}}', intervalSec: 1, timeoutMin: 1, statusPath: 'status', success: ['Success'], failure: ['Fail'],
      resultRequest: { method: 'GET', path: '/v1/files/retrieve?file_id={{poll.file_id}}' }, outputs: [{ path: 'file.download_url', as: 'url', kind: 'video' }],
    } };
    const http = vi.fn().mockResolvedValueOnce({ status: 200, headers: {}, bodyText: '{"status":"Success","file_id":"176844028768320"}' })
      .mockResolvedValueOnce({ status: 200, headers: {}, bodyText: '{"file":{"download_url":"https://assets.example/real.mp4"}}' });
    const adapter = new TemplateAdapter({ profile: p, apiKey: 'secret', http, resolveRef: async () => '' });
    expect(await adapter.poll(job, 'different-task-id')).toMatchObject({ state: 'done', outputs: [{ kind: 'video', source: { url: 'https://assets.example/real.mp4' } }] });
    expect(http.mock.calls.map(([request]) => [request.method, request.url])).toEqual([
      ['GET', 'https://api.example.com/query?task_id=different-task-id'], ['GET', 'https://api.example.com/v1/files/retrieve?file_id=176844028768320'],
    ]);
  });
  it('blocks missing poll result handles before retrieving or issuing a second submit', async () => {
    const p = profile();
    p.operations['image.edit']!.response = { mode: 'async', taskIdPath: 'id', poll: {
      method: 'GET', path: '/query/{{taskId}}', intervalSec: 1, timeoutMin: 1, statusPath: 'status', success: ['Success'], failure: ['Fail'],
      resultRequest: { method: 'GET', path: '/retrieve?file_id={{poll.file_id}}' }, outputs: [],
    } };
    const http = vi.fn().mockResolvedValue({ status: 200, headers: {}, bodyText: '{"status":"Success"}' });
    const adapter = new TemplateAdapter({ profile: p, apiKey: 'secret', http, resolveRef: async () => '' });
    expect(await adapter.poll(job, 'task')).toMatchObject({ state: 'failed', error: { category: 'validation', message: '缺少必填值：poll.file_id' } });
    expect(http).toHaveBeenCalledTimes(1);
  });
  it('emits authenticated content URLs only after completion, including restored polling', async () => {
    const p = profile(); p.operations['image.edit']!.response = { mode: 'async', taskIdPath: 'id', poll: { method: 'GET', path: '/v1/videos/{{taskId}}', intervalSec: 1, timeoutMin: 1, statusPath: 'status', success: ['completed'], failure: ['failed'], outputs: [{ url: '/v1/videos/{{taskId}}/content', kind: 'video', auth: true }] } };
    const http = vi.fn().mockResolvedValueOnce({ status: 200, headers: {}, bodyText: '{"status":"running"}' }).mockResolvedValueOnce({ status: 200, headers: {}, bodyText: '{"status":"completed"}' });
    const adapter = new TemplateAdapter({ profile: p, apiKey: 'secret', http, resolveRef: async () => '' });
    expect(await adapter.poll(job, 'task/1')).toEqual({ state: 'pending' });
    expect(await adapter.poll(job, 'task/1')).toEqual({ state: 'done', outputs: [{ kind: 'video', source: { type: 'url', url: 'https://api.example.com/v1/videos/task%2F1/content', headers: { Authorization: 'Bearer secret' } } }] });
    expect(http.mock.calls.map(([request]) => request.url)).toEqual(['https://api.example.com/v1/videos/task%2F1', 'https://api.example.com/v1/videos/task%2F1']);
  });
  it('does not leak auth to an upstream-supplied cross-origin URL', async () => {
    const p = profile(); p.operations['image.edit']!.response = { mode: 'async', taskIdPath: 'id', poll: { method: 'GET', path: '{{submit.status_url}}', intervalSec: 1, timeoutMin: 1, statusPath: 'status', success: ['done'], failure: ['failed'], outputs: [] } };
    const http = vi.fn().mockResolvedValue({ status: 200, headers: {}, bodyText: '{"id":"t","status_url":"https://attacker.example/status"}' });
    const adapter = new TemplateAdapter({ profile: p, apiKey: 'secret', http, resolveRef: async () => '' });
    await adapter.submit(job);
    expect(await adapter.poll(job, 't')).toMatchObject({ state: 'failed', error: { category: 'validation' } });
    expect(http).toHaveBeenCalledTimes(1);
  });
  it('leaves network polling failures pending without resubmitting', async () => {
    const p = profile(); p.operations['image.edit']!.response = { mode: 'async', taskIdPath: 'id', poll: { method: 'GET', path: '/jobs/{{taskId}}', intervalSec: 1, timeoutMin: 1, statusPath: 'status', success: ['done'], failure: ['failed'], outputs: [] } };
    const http = vi.fn().mockRejectedValue(new Error('timeout'));
    const adapter = new TemplateAdapter({ profile: p, apiKey: 'secret', http, resolveRef: async () => '' });
    expect(await adapter.poll(job, 't')).toMatchObject({ state: 'pending' });
    expect(http).toHaveBeenCalledTimes(1);
  });
  it('renders chat messages and returns actual text, not media URLs', async () => {
    const p = profile(); p.operations.chat = { method: 'POST', path: '/v1/chat/completions', body: 'json', template: { model: '{{model}}', messages: '{{messages}}' }, response: { mode: 'sync', outputs: [] } }; p.models[0].operations.push('chat');
    const http = vi.fn().mockResolvedValue({ status: 200, headers: {}, bodyText: '{"choices":[{"message":{"content":"你好"}}]}' });
    const adapter = new TemplateAdapter({ profile: p, apiKey: 'secret', http, resolveRef: async () => '' });
    const messages = [{ role: 'user' as const, content: 'hello' }];
    expect(await adapter.submit({ ...job, operation: 'chat', messages })).toEqual({ state: 'done', outputs: [{ kind: 'text', text: '你好' }] });
    expect(http.mock.calls[0][0].body).toEqual({ mode: 'json', json: { model: 'm', messages } });
  });
  it('lists models without requiring a selected model or prompt', async () => {
    const p = profile(); p.operations['models.list'] = { method: 'GET', path: '/v1/models', body: 'none', response: { mode: 'sync', outputs: [] } };
    const http = vi.fn().mockResolvedValue({ status: 200, headers: {}, bodyText: '{"data":[{"id":"a"},{"id":"b"},{"id":"a"}]}' });
    const adapter = new TemplateAdapter({ profile: p, apiKey: 'secret', http, resolveRef: async () => '' });
    expect(await adapter.listModels()).toEqual({ ok: true, models: ['a', 'b'] });
  });
});
