import { describe, expect, it } from 'vitest';
import { applyComfyUIAuth, comfyUIHistoryUrl, comfyUIViewUrl, comfyUIWebSocketUrl, resolveComfyUIProviderAuth, resolveComfyUIUrls } from './url';

describe('ComfyUI endpoint resolution', () => {
  it.each([
    ['http://host:8188/prompt', 'http://host:8188', false, '/prompt'],
    ['workstation:8188', 'http://workstation:8188', true, null],
    ['https://xxx.trycloudflare.com/', 'https://xxx.trycloudflare.com', false, null],
    ['https://a.b/comfy/', 'https://a.b/comfy', false, null],
    ['https://a.b/comfy/api/prompt/', 'https://a.b/comfy', false, '/api/prompt'],
    ['http://host:8188/history/old-id', 'http://host:8188', false, '/history/old-id'],
    [' workstation：8188/comfy/api/prompt/?old=1#fragment ', 'http://workstation:8188/comfy', true, '/api/prompt'],
    ['//workstation:8188/comfy/view?filename=old.png', 'http://workstation:8188/comfy', true, '/view'],
  ])('resolves %s without protocol guessing', (input, base, defaultedScheme, strippedPath) => {
    const urls = resolveComfyUIUrls(input);
    expect(urls).toEqual({ base, prompt: `${base}/prompt`, history: `${base}/history`, view: `${base}/view`,
      ws: `${base.replace(/^http/, 'ws')}/ws`, objectInfo: `${base}/object_info`, systemStats: `${base}/system_stats`, upload: `${base}/upload/image`, defaultedScheme, strippedPath });
    expect(comfyUIHistoryUrl(urls, 'a/b')).toBe(`${base}/history/a%2Fb`);
    expect(new URL(comfyUIViewUrl(urls, { filename: 'a b.png' })).searchParams.get('filename')).toBe('a b.png');
    expect(new URL(comfyUIWebSocketUrl(urls, 'client id')).searchParams.get('clientId')).toBe('client id');
  });

  it('rejects unsupported explicit schemes and embedded credentials', () => {
    expect(() => resolveComfyUIUrls('ftp://host')).toThrow('http');
    expect(() => resolveComfyUIUrls('https://user:secret@host')).toThrow('用户名');
  });

  it('keeps auth modes independent of an empty key', () => {
    const url = 'https://tunnel.example/prompt';
    expect(applyComfyUIAuth(url, { mode: 'none' })).toEqual({ url, headers: {} });
    expect(applyComfyUIAuth(url, { mode: 'bearer', value: '' }).headers).toEqual({});
    expect(applyComfyUIAuth(url, { mode: 'bearer', value: '   ' }).headers).toEqual({});
    expect(applyComfyUIAuth(url, { mode: 'header', name: 'Authorization', value: '' }).headers).toEqual({});
    expect(applyComfyUIAuth(url, { mode: 'header', name: 'X-Tunnel', value: '' }).headers).toEqual({ 'X-Tunnel': '' });
    expect(applyComfyUIAuth(url, { mode: 'query', name: 'token', value: '' }).url).toBe(`${url}?token=`);
    expect(() => applyComfyUIAuth(url, { mode: 'header', name: 'Bad\nName', value: 'x' })).toThrow();
  });

  it('does not turn an empty key into a prefix-only credential', () => {
    expect(resolveComfyUIProviderAuth({ apiKey: ' ', extraParams: { auth: { mode: 'bearer', prefix: 'Token' } } }))
      .toEqual({ config: { mode: 'bearer' }, prefix: 'Token', value: '' });
    expect(resolveComfyUIProviderAuth({ apiKey: ' key ', extraParams: { auth: { mode: 'header', name: 'X-Key', prefix: 'Token' } } }).value)
      .toBe('Token key');
  });

  it('explains malformed host and port input', () => {
    expect(() => resolveComfyUIUrls('http://host:bad-port')).toThrow(/ComfyUI.*地址无效.*8188/);
  });
});
