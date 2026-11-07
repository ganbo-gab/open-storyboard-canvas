import { describe, expect, it, vi } from 'vitest';
import { TemplateAdapter } from './templateAdapter';
import type { ChannelProfileV2 } from '../domain/profile';
import type { JobInput } from './types';

function profile(): ChannelProfileV2 {
  return { version: 2, id: 'legacy-draw', name: 'Legacy Draw', baseUrl: 'https://grsai.dakka.com.cn', auth: { type: 'bearer' },
    models: [{ id: 'gpt-image-2', operations: ['image.edit'], params: [] }], operations: {
      'image.edit': { method: 'POST', path: '/v1/draw/completions', body: 'json', template: { prompt: '{{prompt}}' },
        response: { mode: 'async', taskIdPath: 'data.id', poll: { method: 'POST', path: '/v1/draw/result', template: { id: '{{taskId}}' },
          intervalSec: 2, timeoutMin: 2, statusPath: 'data.status', success: ['succeeded'], failure: ['failed'], outputs: [{ path: 'data.results[0].url', as: 'url' }] } }, errorPath: 'data.error' },
    } };
}
const job: JobInput = { jobId: 'local-original', channelId: 'legacy-draw', modelId: 'gpt-image-2', operation: 'image.edit', prompt: '', params: {}, refs: [], count: 1 };
const url = 'https://fixtures.example/original.png';
function fixture(payload: unknown, config = profile()) {
  const http = vi.fn().mockResolvedValue({ status: 200, headers: {}, bodyText: JSON.stringify(payload) });
  return { http, adapter: new TemplateAdapter({ profile: config, apiKey: 'fixture-key', http, resolveRef: async () => '' }) };
}

describe('saved GRSAI Draw polling compatibility', () => {
  it.each([
    { code: 0, data: { status: 'success', results: [{ url }] } },
    { code: 0, data: { status: 'running', results: [{ url }] } },
    { code: 0, data: { results: [{ url }] } },
    { status: 'completed', results: [{ url }] },
  ])('recovers a completed original response despite the old succeeded-only gate (%j)', async (payload) => {
    const { adapter, http } = fixture(payload);
    expect(await adapter.poll(job, 'original-accepted')).toEqual({ state: 'done', outputs: [{ kind: 'image', source: { type: 'url', url } }] });
    expect(http).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ method: 'POST', url: 'https://grsai.dakka.com.cn/v1/draw/result',
      body: { mode: 'json', json: { id: 'original-accepted' } } }));
  });
  it('accepts the wrapped response for a migrated bare-path contract without modifying its saved profile', async () => {
    const config = profile(); const response = config.operations['image.edit']!.response;
    if (response.mode !== 'async') throw new Error('fixture');
    response.poll.statusPath = 'status'; response.poll.outputs = [{ path: 'results[0].url', as: 'url' }];
    const before = structuredClone(config);
    expect(await fixture({ code: 0, data: { results: [{ url }] } }, config).adapter.poll(job, 'original')).toMatchObject({ state: 'done' });
    expect(config).toEqual(before);
  });
  it('stops an HTTP 200 business error with a recoverable query diagnostic', async () => {
    const { adapter, http } = fixture({ code: -22, msg: 'fixture task unavailable', data: null });
    expect(await adapter.poll(job, 'original')).toMatchObject({ state: 'failed', error: { category: 'upstream', retryable: true,
      message: expect.stringContaining('code -22'), upstreamMessage: 'fixture task unavailable' } });
    expect(http).toHaveBeenCalledOnce();
  });
  it.each([{ code: 0 }, { code: 0, data: null }, { msg: 'missing task payload' }])('does not hide a malformed response as ordinary pending (%j)', async (payload) => {
    expect(await fixture(payload).adapter.poll(job, 'original')).toMatchObject({ state: 'failed', error: { retryable: true } });
  });
  it('keeps an explicit failed task terminal even if it contains a leftover URL', async () => {
    expect(await fixture({ code: 0, data: { status: 'failed', error: 'fixture rejected', results: [{ url }] } }).adapter.poll(job, 'original'))
      .toMatchObject({ state: 'failed', error: { retryable: false, upstreamMessage: 'fixture rejected' } });
  });
  it('retains a running task and its reported progress without inventing a result', async () => {
    expect(await fixture({ code: 0, data: { id: 'original', status: 'running', progress: 51 } }).adapter.poll(job, 'original'))
      .toEqual({ state: 'pending', progress: 51 });
  });
  it('keeps explicitly empty task outputs pending while the original task is running', async () => {
    expect(await fixture({ code: 0, data: { id: 'original', status: 'running', results: null, progress: null } }).adapter.poll(job, 'original'))
      .toEqual({ state: 'pending' });
  });
  it('preserves explicit status semantics on another provider with the same endpoint path', async () => {
    const config = profile(); config.baseUrl = 'https://another.example';
    expect(await fixture({ data: { status: 'running', results: [{ url }] } }, config).adapter.poll(job, 'original')).toEqual({ state: 'pending' });
  });
  it('keeps generic missing-status responses pending while recording the mismatched field', async () => {
    const config = profile(); config.baseUrl = 'https://another.example';
    expect(await fixture({ task: 'original' }, config).adapter.poll(job, 'original')).toMatchObject({ state: 'pending',
      diagnostic: { category: 'validation', message: expect.stringContaining('data.status') } });
  });
});
