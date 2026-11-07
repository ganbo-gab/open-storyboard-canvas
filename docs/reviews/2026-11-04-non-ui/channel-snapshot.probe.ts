// Captures real TypeScript snapshots at the native IPC boundary; no network or vault calls.
import { writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import type { CreateGenerationJobRequest } from '@/commands/ai';
import { submitChannelSmoke } from '@/features/channels/application/channelService';
import { submitChannelJob } from '@/features/channels/runtime/channelExecution';
import { secretToken } from '@/features/secrets/secretStore';
import type { ChannelProfileV2 } from '@/features/channels/domain/profile';

const bridge = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@tauri-apps/api/core', async (original) => ({ ...await original<typeof import('@tauri-apps/api/core')>(), isTauri: () => true }));
vi.mock('@/commands/ai', async (original) => ({ ...await original<typeof import('@/commands/ai')>(), createGenerationJob: bridge.create }));

function profile(): ChannelProfileV2 {
  return { version: 2, id: 'audit-contract', name: 'Audit', baseUrl: 'https://audit.invalid', auth: { type: 'bearer' },
    models: [{ id: 'chat', operations: ['chat'], params: [] }, { id: 'image', operations: ['image.generate'], params: [] }],
    operations: {
      chat: { method: 'POST', path: '/chat', body: 'json', template: { model: '{{model}}', messages: '{{messages}}' }, response: { mode: 'sync', outputs: [] } },
      'image.generate': { method: 'POST', path: '/images', body: 'json', template: { model: '{{model}}', prompt: '{{prompt}}' }, response: { mode: 'sync', outputs: [{ path: 'url', as: 'url' }] } },
    },
  };
}

it('captures the transient image snapshot for validation by actual Rust code', async () => {
  bridge.create.mockReset().mockImplementation(async (request: CreateGenerationJobRequest) => {
    writeFileSync(new URL('./transient-snapshot.json', import.meta.url), JSON.stringify(request.pollDescriptor, null, 2));
    throw new Error('audit captured before HTTP');
  });
  await expect(submitChannelJob(profile(), { jobId: '', channelId: 'audit-contract', modelId: 'image', operation: 'image.generate', prompt: 'audit image', refs: [], params: {}, count: 1 }, 'audit-fake-transient-key')).rejects.toThrow('audit captured');
  expect(bridge.create).toHaveBeenCalledOnce();
});

it('does not persist chat message payload in the recovery snapshot', async () => {
  bridge.create.mockReset().mockImplementation(async (request: CreateGenerationJobRequest) => {
    writeFileSync(new URL('./chat-snapshot.json', import.meta.url), JSON.stringify(request.pollDescriptor, null, 2));
    throw new Error('audit captured before HTTP');
  });
  await expect(submitChannelSmoke(profile(), { jobId: '', channelId: 'audit-contract', modelId: 'chat', operation: 'chat', prompt: 'AUDIT_PRIVATE_PROMPT', refs: [], params: {}, count: 1 }, secretToken({ namespace: 'channel', id: 'audit-contract' }))).rejects.toThrow('audit captured');
  const request: CreateGenerationJobRequest = bridge.create.mock.calls[0][0];
  expect(JSON.stringify(request.pollDescriptor)).not.toContain('AUDIT_PRIVATE_PROMPT');
});
