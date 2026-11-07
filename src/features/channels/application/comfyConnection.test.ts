import { describe, expect, it, vi } from 'vitest';
import type { ComfyUITransport } from '@/features/canvas/infrastructure/comfyuiGateway';
import { inspectComfyUIConnection } from './comfyConnection';

function transport(stats: unknown, queue: unknown): ComfyUITransport {
  return { json: vi.fn(async (path) => {
    const result = path === '/system_stats' ? stats : queue;
    if (result instanceof Error) throw result;
    return result;
  }), multipart: vi.fn(), url: vi.fn() };
}

describe('truthful ComfyUI control statistics', () => {
  it.each([
    { running: [], pending: [], status: 'idle' },
    { running: [], pending: [['private prompt metadata']], status: 'queued' },
    { running: [['private running prompt']], pending: [['private pending prompt']], status: 'running' },
  ])('reports observed $status counts without exposing queue task payloads', async ({ running, pending, status }) => {
    const client = transport({ system: { comfyui_version: '0.3.fixture' }, devices: [{ name: 'Fixture GPU', type: 'cuda', vram_total: 24000, vram_free: 12000, api_key: 'private-stat-field' }] },
      { queue_running: running, queue_pending: pending });
    const stats = await inspectComfyUIConnection(client);
    expect(stats).toMatchObject({ reachable: true, status, system: { version: '0.3.fixture', devices: [{ name: 'Fixture GPU', vram_total: 24000, vram_free: 12000 }] },
      queue: { running: running.length, pending: pending.length } });
    expect(JSON.stringify(stats)).not.toContain('private');
    expect(client.json).toHaveBeenCalledTimes(2); expect(client.multipart).not.toHaveBeenCalled();
  });

  it('keeps missing GPU values and malformed queue counts unknown rather than inventing zero', async () => {
    const stats = await inspectComfyUIConnection(transport({ system: { os: 'fixture' }, devices: [{ name: 'CPU', type: 'cpu' }] }, {}));
    expect(stats).toMatchObject({ reachable: true, status: 'unknown', system: { devices: [{ name: 'CPU', type: 'cpu' }] } });
    expect(stats.queue).toBeUndefined(); expect(stats.system?.devices?.[0]).not.toHaveProperty('vram_total');
    expect(stats.system).not.toHaveProperty('version');
  });

  it('distinguishes reachable queue-only service from unreachable service', async () => {
    const queueOnly = await inspectComfyUIConnection(transport(new Error('stats unavailable'), { queue_running: [], queue_pending: [[]] }));
    expect(queueOnly).toMatchObject({ reachable: true, status: 'queued', queue: { running: 0, pending: 1 } });
    expect(queueOnly.system).toBeUndefined();
    const offline = await inspectComfyUIConnection(transport(new Error('connection refused'), new Error('connection refused')));
    expect(offline).toMatchObject({ reachable: false, status: 'unreachable' });
    expect(offline.queue).toBeUndefined(); expect(offline.system).toBeUndefined();
  });

  it('rejects invalid GPU counters without making them up', async () => {
    const stats = await inspectComfyUIConnection(transport({ devices: [{ name: 'bad fixture', vram_total: -1 }] }, { queue_running: [], queue_pending: [] }));
    expect(stats.system).toBeUndefined(); expect(stats.errors.systemStats).toBeDefined(); expect(stats.status).toBe('idle');
  });
});
