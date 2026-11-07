import { describe, expect, it } from 'vitest';
import { channelProfileSchema, validateProfile, type ChannelProfileV2 } from './profile';
import { render, renderPreview, renderRequest } from './template';
import { classifyAsyncStatus, extractError, extractOutputs, getPath, getPathValues } from './response';
import { classifyTransportError, normalizeChannelError } from './errors';
import type { JobInput } from '../runtime/types';

export function testProfile(): ChannelProfileV2 {
  return { version: 2, id: 'test', name: '测试', baseUrl: 'https://api.example.com', auth: { type: 'bearer' },
    operations: { 'image.generate': { method: 'POST', path: '/v1/images/generations', body: 'json', template: { model: '{{model}}', prompt: '{{prompt}}', n: '{{param.n}}', unset: '{{param.unset}}' }, response: { mode: 'sync', outputs: [{ path: 'data[*].url', as: 'url' }] }, errorPath: 'error.message' } },
    models: [{ id: 'image-model', operations: ['image.generate'], params: [{ key: 'n', label: '数量', type: 'number', default: 1 }, { key: 'unset', label: '未设置', type: 'text' }], refs: { image: 3 } }] };
}
export function testJob(): JobInput {
  return { jobId: 'j1', channelId: 'test', modelId: 'image-model', operation: 'image.generate', prompt: '猫', params: {}, refs: [], count: 1 };
}
it('renders a restored object enum with reordered fields as the same declared JSON value', async () => {
  const profile = testProfile();
  profile.auth = { type: 'none' };
  profile.models[0].params = [{ key: 'output', label: '时长与分辨率', type: 'enum', options: [{ label: '10 秒 · 768P', value: { duration: 10, resolution: '768P' } }] }];
  profile.operations['image.generate']!.template = { model: '{{model}}', prompt: '{{prompt}}', duration: '{{param.output.duration}}', resolution: '{{param.output.resolution}}' };
  const job = { ...testJob(), params: { output: { resolution: '768P', duration: 10 } } };
  const result = await renderRequest(profile, job, '', async () => 'unused');
  expect(result.request.body).toEqual({ mode: 'json', json: { model: 'image-model', prompt: '猫', duration: 10, resolution: '768P' } });
  expect(result.preview).toEqual(renderPreview(profile, job));
  await expect(renderRequest(profile, { ...job, params: { output: { resolution: '768P', duration: '10' } } }, '', async () => 'unused')).rejects.toThrow(/不符合声明/);
});
describe('strict profile validation', () => {
  it('accepts exact shapes and rejects unknown fields at every nested layer', () => {
    expect(channelProfileSchema.safeParse(testProfile()).success).toBe(true);
    for (const mutate of [
      (p: ChannelProfileV2) => { Object.assign(p, { extra: true }); }, (p: ChannelProfileV2) => { Object.assign(p.auth, { key: 'secret' }); },
      (p: ChannelProfileV2) => { Object.assign(p.models[0].params[0], { extra: true }); }, (p: ChannelProfileV2) => { const response = p.operations['image.generate']!.response; if (response.mode === 'sync') Object.assign(response.outputs[0], { extra: true }); },
      (p: ChannelProfileV2) => { Object.assign(p.models[0].refs!, { extra: 1 }); }, (p: ChannelProfileV2) => { Object.assign(p.operations['image.generate']!, { files: { field: 'image', cardinality: 'single', extra: true } }); },
    ]) { const profile = testProfile(); mutate(profile); expect(validateProfile(profile).some((error) => error.message.includes('未知字段'))).toBe(true); }
  });
  it('validates parameter references for every supporting model, including polling paths', () => {
    const p = testProfile(); p.models.push({ id: 'other', operations: ['image.generate'], params: [] });
    expect(validateProfile(p)).toContainEqual(expect.objectContaining({ message: '模型 other 未声明参数 n' }));
    p.models.pop(); p.operations['image.generate']!.template = { correlated: '{{param.n.width}}' };
    expect(validateProfile(p)).toEqual([]);
  });
  it('rejects secret headers and multipart without file descriptors', () => {
    const p = testProfile(); p.headers = { 'x-goog-api-key': 'secret' };
    expect(validateProfile(p)[0].path).toBe('headers.x-goog-api-key');
    delete p.headers; p.operations['image.generate']!.body = 'multipart';
    expect(validateProfile(p)[0].message).toContain('文件字段');
  });
  it('reports Chinese field errors', () => {
    expect(validateProfile({ version: 1 })).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'version', message: expect.stringContaining('配置值无效') })]));
  });
  it('permits poll response variables only in the final result request', () => {
    const p = testProfile(); const op = p.operations['image.generate']!;
    op.response = { mode: 'async', taskIdPath: 'id', poll: { method: 'GET', path: '/tasks/{{taskId}}', intervalSec: 1, timeoutMin: 1,
      success: ['done'], failure: [], resultRequest: { method: 'GET', path: '/files?file_id={{poll.file_id}}', template: { file: '{{poll.file_id}}' } }, outputs: [] } };
    expect(validateProfile(p)).toEqual([]);
    op.template = { invalid: '{{poll.file_id}}' };
    expect(validateProfile(p)).toContainEqual({ path: 'operations.image.generate.template', message: '未声明的模板变量 poll.file_id' });
    op.template = {};
    op.response.poll.path = '/tasks/{{poll.file_id}}';
    expect(validateProfile(p)).toContainEqual({ path: 'operations.image.generate.response.poll.path', message: '未声明的模板变量 poll.file_id' });
  });
});
describe('typed template rendering', () => {
  it('retains whole variable types and stringifies only embedded values', () => {
    expect(render({ n: '{{param.n}}', enabled: '{{param.enabled}}', nil: '{{param.nil}}', label: '{{param.n}}px', images: '{{images}}' }, { param: { n: 2, enabled: false, nil: null }, images: ['a', 'b'] })).toEqual({ n: 2, enabled: false, label: '2px', images: ['a', 'b'] });
  });
  it('omits optional fields/array entries instead of sending null or empty strings', () => {
    expect(render({ a: '{{param.x}}', b: 'size={{param.x}}', c: ['{{param.x}}', 1] }, { param: {} })).toEqual({ c: [1] });
    expect(() => render('{{model}}', {})).toThrow('model');
    expect(() => render('{{param.n}}', { param: {} }, ['param.n'])).toThrow('param.n');
  });
  it('sends template fields only and shares masked preview rendering', async () => {
    const profile = testProfile(); const job = testJob(); job.params.hidden = 'not declared';
    const result = await renderRequest(profile, job, 'secret', async () => 'unused');
    expect(result.request.body).toEqual({ mode: 'json', json: { model: 'image-model', prompt: '猫', n: 1 } });
    expect(result.preview).toEqual(renderPreview(profile, job));
    expect(result.preview.headers.Authorization).toBe('Bearer ***');
    expect(JSON.stringify(result.preview)).not.toContain('secret');
  });
  it('encodes query variable values and omits missing optional query fields', async () => {
    const profile = testProfile(); Object.assign(profile.operations['image.generate']!, { method: 'GET', path: '/generate?prompt={{prompt}}&size={{param.unset}}&n={{param.n}}', body: 'none' });
    const result = await renderRequest(profile, { ...testJob(), prompt: '猫 & dog#1?' }, 'secret', async () => 'unused');
    const url = new URL(result.request.url);
    expect([...url.searchParams]).toEqual([['prompt', '猫 & dog#1?'], ['n', '1']]);
    expect(url.hash).toBe('');
  });
  it('resolves requested reference encoding and replaces bytes in previews', async () => {
    const p = testProfile(); p.operations['image.generate']!.template = { images: '{{images}}' }; p.operations['image.generate']!.imageEncoding = 'base64';
    const job = testJob(); job.refs = [{ kind: 'image', assetId: 'a', path: '/tmp/a.png', mime: 'image/png', width: 100, height: 200 }];
    const seen: string[] = [];
    const result = await renderRequest(p, job, 'key', async (_, encoding) => { seen.push(encoding); return 'IMAGE-BYTES'; });
    expect(seen).toEqual(['base64']);
    expect(result.request.body).toEqual({ mode: 'json', json: { images: ['IMAGE-BYTES'] } });
    expect(result.preview.body).toEqual({ mode: 'json', json: { images: ['<image 1: 100×200 png>'] } });
  });
  it.each(['single', 'array', 'repeat'] as const)('renders exact %s multipart parts', async (cardinality) => {
    const p = testProfile(); Object.assign(p.operations['image.generate']!, { body: 'multipart', files: { field: 'image', cardinality }, template: { model: '{{model}}', prompt: '{{prompt}}', n: '{{param.n}}' } });
    const job = testJob(); job.refs = ['a', 'b'].map((id) => ({ kind: 'image', assetId: id, path: `/tmp/${id}.png`, mime: 'image/png' }));
    const result = await renderRequest(p, job, 'key', async () => { throw new Error('multipart must not resolve disk bytes'); });
    expect(result.request.body).toEqual({ mode: 'multipart', fields: [{ name: 'model', value: 'image-model' }, { name: 'prompt', value: '猫' }, { name: 'n', value: '1' }], files: (cardinality === 'single' ? ['a'] : ['a', 'b']).map((id) => ({ name: cardinality === 'array' ? 'image[]' : 'image', path: `/tmp/${id}.png`, mime: 'image/png', filename: `${id}.png` })) });
  });
  it('does not double-suffix image[] array fields', async () => {
    const p = testProfile(); Object.assign(p.operations['image.generate']!, { body: 'multipart', files: { field: 'image[]', cardinality: 'array' } });
    const job = testJob(); job.refs = [{ kind: 'image', assetId: 'a', path: '/a.png', mime: 'image/png' }];
    const result = await renderRequest(p, job, 'key', async () => 'unused');
    expect(result.request.body.mode === 'multipart' && result.request.body.files[0].name).toBe('image[]');
  });
});
describe('response paths and errors', () => {
  it('expands nested wildcards/numeric indices and explicitly decoded JSON', () => {
    const data = { data: [{ urls: ['a', 'b'] }, { urls: ['c'] }], resultJson: '{"resultUrls":["https://x/a"]}' };
    expect(getPathValues(data, 'data[*].urls[*]')).toEqual(['a', 'b', 'c']);
    expect(getPath(data, 'data[0].urls[1]')).toBe('b');
    expect(getPathValues(data, 'resultJson|json.resultUrls[*]')).toEqual(['https://x/a']);
    expect(getPathValues(data, 'resultJson|json.missing')).toEqual([]);
    expect(getPathValues({ resultJson: 'invalid' }, 'resultJson|json.a')).toEqual([]);
  });
  it('extracts media with explicit source types and errors verbatim', () => {
    expect(extractOutputs({ url: 'https://x/a', b64: 'data:image/webp;base64,AAAA' }, [{ path: 'url', as: 'url' }, { path: 'b64', as: 'data-url' }], 'image.generate')).toEqual([{ kind: 'image', source: { type: 'url', url: 'https://x/a' } }, { kind: 'image', source: { type: 'base64', data: 'AAAA', mime: 'image/webp' } }]);
    expect(extractError({ error: { message: '原文  spacing' } }, 'error.message')).toBe('原文  spacing');
  });
  it('classifies output-presence polling, failures before success, and progress', () => {
    const response = { mode: 'async' as const, taskIdPath: 'id', poll: { method: 'GET' as const, path: '/tasks/{{taskId}}', intervalSec: 1, timeoutMin: 1, success: [], failure: [], progressPath: 'progress', outputs: [{ path: 'url', as: 'url' as const }] } };
    expect(classifyAsyncStatus({ url: 'https://x/a', progress: 80 }, response, 'image.generate').state).toBe('done');
    expect(classifyAsyncStatus({ url: 'https://x/a', error: 'blocked' }, response, 'image.generate', 'error').state).toBe('failed');
    expect(classifyAsyncStatus({ progress: 80 }, response, 'image.generate')).toEqual({ state: 'pending', outputs: [], progress: 80 });
  });
  it.each([[401, 'auth'], [403, 'auth'], [402, 'balance'], [404, 'not_found'], [413, 'too_large'], [429, 'rate_limit'], [503, 'upstream']] as const)('maps HTTP %i to %s', (status, category) => {
    expect(normalizeChannelError(status, 'raw', 'https://x/path')).toMatchObject({ category, upstreamMessage: 'raw', status });
  });
  it('never retries moderation and distinguishes before-send evidence', () => {
    expect(normalizeChannelError(500, 'content_policy_violation')).toMatchObject({ category: 'moderation', retryable: false });
    expect(classifyTransportError({ code: 'ECONNREFUSED' })).toMatchObject({ beforeSend: true, error: { retryable: true } });
    expect(classifyTransportError(new Error('socket reset after send'))).toMatchObject({ beforeSend: false, error: { retryable: false } });
  });
});
