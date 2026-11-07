import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJSONStorage } from 'zustand/middleware';
import { z } from 'zod';
import type * as TauriCore from '@tauri-apps/api/core';
import type * as AiCommands from '@/commands/ai';
import type * as ImageCommands from '@/commands/image';
const bridge = vi.hoisted(() => ({ native: false, fetch: vi.fn<typeof fetch>(), http: vi.fn(), create: vi.fn(), update: vi.fn(), image: vi.fn() }));
vi.mock('@tauri-apps/api/core', async (original) => ({ ...await original<typeof TauriCore>(), isTauri: () => bridge.native }));
vi.mock('@/commands/ai', async (original) => ({ ...await original<typeof AiCommands>(), customHttpRequest: bridge.http,
  createGenerationJob: bridge.create, updateGenerationJob: bridge.update }));
vi.mock('@/commands/image', async (original) => ({ ...await original<typeof ImageCommands>(), prepareNodeImageSourceWithHeaders: bridge.image }));
import { channelChatInput, normalizeChannelSmokeInput, previewChannel, submitChannelSmoke } from '../application/channelService';
import { getChannelJob, recoverChannelJob, submitChannelJob, waitForChannelJob } from './channelExecution';
import { setChannelCredential, getChannelCredential, useChannelStore } from '../store/channelStore';
import { openAIStandardProfile } from '../presets/openai';
import { anthropicProfile } from '../presets/anthropic';
import { geminiNativeProfile } from '../presets/gemini';
import type { ChannelProfileV2, OperationSpec } from '../domain/profile';
import type { JobInput } from './types';
import { SecretStoreError, secretStore } from '@/features/secrets/secretStore';
import { useMemorySecretVault } from '@/features/secrets/testSupport';

useMemorySecretVault();
const values = new Map<string, string>();
const storage: Storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); },
  removeItem: (key) => { values.delete(key); }, clear: () => values.clear(), key: (index) => [...values.keys()][index] ?? null,
  get length() { return values.size; } };
function job(profile: ChannelProfileV2): JobInput {
  return { jobId: '', channelId: profile.id, modelId: profile.models[0].id, operation: 'chat', prompt: 'A quiet scene', params: {}, refs: [], count: 1 };
}
function chatProfile(source: ChannelProfileV2): ChannelProfileV2 {
  const profile = structuredClone(source);
  profile.id = `smoke-${profile.id}-${crypto.randomUUID()}`;
  profile.baseUrl = 'https://relay.test';
  profile.models = profile.models.filter((model) => model.operations.includes('chat'));
  return profile;
}
function asyncProfile(): ChannelProfileV2 {
  return { version: 2, id: `temporary-${crypto.randomUUID()}`, name: 'Temporary', baseUrl: 'https://relay.test', auth: { type: 'bearer' },
    models: [{ id: 'image-model', operations: ['image.generate'], params: [] }], operations: {
      'image.generate': { method: 'POST', path: '/submit', body: 'json', template: { model: '{{model}}', prompt: '{{prompt}}' }, response: {
        mode: 'async', taskIdPath: 'id', poll: { method: 'GET', path: '/tasks/{{taskId}}', intervalSec: 0.001, timeoutMin: 0.0001,
          statusPath: 'status', success: ['done'], failure: ['failed'], outputs: [{ path: 'url', as: 'url' }],
          resultRequest: { method: 'GET', path: '/tasks/{{taskId}}/result' } },
      } },
    } };
}
function response(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status }); }
function savedJobs(): string { return storage.getItem('channel-generation-jobs-v2') ?? ''; }
function wire(): RequestInit { return bridge.fetch.mock.calls.at(-1)?.[1] ?? {}; }

beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('localStorage', storage); vi.stubGlobal('fetch', bridge.fetch); values.clear();
  useChannelStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
  useChannelStore.setState({ channels: [], migratedLegacyIds: [] });
  bridge.native = false; bridge.fetch.mockReset(); bridge.http.mockReset(); bridge.image.mockReset();
  bridge.create.mockReset().mockResolvedValue(undefined); bridge.update.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('channel smoke request normalization', () => {
  it.each([
    { protocol: 'OpenAI', source: openAIStandardProfile, input: { messages: [{ role: 'user', content: 'A quiet scene' }] } },
    { protocol: 'Anthropic', source: anthropicProfile, input: { messages: [{ role: 'user', content: [{ type: 'text', text: 'A quiet scene' }] }] } },
    { protocol: 'Gemini', source: geminiNativeProfile, input: { contents: [{ role: 'user', parts: [{ text: 'A quiet scene' }] }] } },
  ])('$protocol nonstream generic smoke previews the actual adapted wire and retains selected mode parameters', async ({ source, input, protocol }) => {
    const profile = chatProfile(source); const model = profile.models[0]; const operation = profile.operations.chat!;
    const template = { ...operation.template as Record<string, string>, seed: '{{param.seed}}' };
    const selected: OperationSpec = { ...operation, path: `/selected${operation.path}`, template };
    model.modes = [{ id: 'first', label: 'First', operation: 'chat', endpoint: operation },
      { id: 'selected', label: 'Selected', operation: 'chat', params: [{ key: 'seed', label: 'Seed', type: 'number' }], endpoint: selected }];
    const inputJob = { ...job(profile), modeId: 'selected', params: { stream: false, seed: 27 } };
    const preview = previewChannel(profile, inputJob);
    expect(preview.body).toMatchObject({ mode: 'json', json: { ...input, seed: 27 } });
    expect(preview.url).toContain('/selected');
    if (protocol === 'Gemini') expect(preview.url).toContain(':generateContent?alt=json');
    bridge.fetch.mockResolvedValueOnce(response({ choices: [{ message: { content: 'Smoke passed' } }] }));
    const id = await submitChannelSmoke(profile, inputJob, 'TRANSIENT_CHAT_KEY');
    expect(await waitForChannelJob(id)).toMatchObject({ status: 'succeeded' });
    expect(bridge.fetch).toHaveBeenCalledOnce(); expect(bridge.fetch.mock.calls[0][0]).toBe(preview.url);
    expect(JSON.parse(String(wire().body))).toEqual(preview.body.mode === 'json' ? preview.body.json : undefined);
    expect(savedJobs()).toContain('"modeId":"selected"'); expect(savedJobs()).not.toContain('TRANSIENT_CHAT_KEY');
    expect(savedJobs()).not.toContain('A quiet scene');
    expect(savedJobs()).not.toContain('"chatPayload":');
  });

  it.each([openAIStandardProfile, anthropicProfile, geminiNativeProfile])('rejects $id streaming smoke during preview and before durable creation or HTTP', async (source) => {
    const profile = chatProfile(source); const input = { ...job(profile), params: { stream: true } };
    expect(() => previewChannel(profile, input)).toThrow(/stream|流式/i);
    await expect(submitChannelSmoke(profile, input, 'NO_PAID_STREAM')).rejects.toThrow(/stream|流式/i);
    expect(bridge.fetch).not.toHaveBeenCalled(); expect(savedJobs()).toBe('');
  });

  it('rejects a template-fixed stream request rather than changing the approved wire', async () => {
    const profile = chatProfile(openAIStandardProfile); profile.operations.chat!.template = { model: '{{model}}', messages: '{{messages}}', stream: true };
    expect(() => previewChannel(profile, job(profile))).toThrow(/stream|流式/i);
    await expect(submitChannelSmoke(profile, job(profile), 'NO_PAID_STREAM')).rejects.toThrow(/stream|流式/i);
    expect(bridge.fetch).not.toHaveBeenCalled(); expect(savedJobs()).toBe('');
  });

  it('does not silently drop undeclared smoke parameters', async () => {
    const profile = chatProfile(openAIStandardProfile); const input = { ...job(profile), params: { undeclared: 7 } };
    expect(() => previewChannel(profile, input)).toThrow(/undeclared/);
    await expect(submitChannelSmoke(profile, input, 'NO_PAID_REQUEST')).rejects.toThrow(/undeclared/);
    expect(bridge.fetch).not.toHaveBeenCalled();
  });

  it('preserves declared reference slots and count through generic chat normalization', async () => {
    const profile = chatProfile(openAIStandardProfile); const operation = profile.operations.chat!;
    profile.models[0].modes = [{ id: 'with-reference', label: 'Reference', operation: 'chat',
      slots: [{ key: 'reference', label: 'Reference', kind: 'image', min: 1, max: 1 }],
      endpoint: { ...operation, imageEncoding: 'url', template: { model: '{{model}}', messages: '{{messages}}', reference: '{{slotFirst.reference}}' } } }];
    const input = { ...job(profile), modeId: 'with-reference', count: 2,
      refs: [{ kind: 'image' as const, slot: 'reference', assetId: 'reference', path: 'https://images.test/reference.png', mime: 'image/png' }] };
    const normalized = normalizeChannelSmokeInput(profile, input);
    expect(normalized.refs).toBe(input.refs); expect(normalized.count).toBe(2); expect(normalized.modeId).toBe('with-reference');
    const preview = previewChannel(profile, input); expect(preview.body).toMatchObject({ mode: 'json', json: { reference: expect.any(String) } });
    bridge.fetch.mockResolvedValueOnce(response({ choices: [{ message: { content: 'Reference retained' } }] }));
    await waitForChannelJob(await submitChannelSmoke(profile, input, 'REFERENCE_KEY'));
    expect(JSON.parse(String(wire().body))).toMatchObject({ reference: 'https://images.test/reference.png' });
  });

  it('maps explicitly declared Gemini generation settings without inventing other defaults', async () => {
    const profile = chatProfile(geminiNativeProfile); profile.models[0].params.push(
      { key: 'temperature', label: 'Temperature', type: 'number' }, { key: 'max_tokens', label: 'Tokens', type: 'number' });
    const input = { ...job(profile), params: { temperature: 0, max_tokens: 123 } };
    const preview = previewChannel(profile, input);
    expect(preview.body).toEqual({ mode: 'json', json: { contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 123 } } });
    bridge.fetch.mockResolvedValueOnce(response({ candidates: [{ content: { parts: [{ text: 'Gemini passed' }] } }] }));
    await waitForChannelJob(await submitChannelSmoke(profile, input, 'GEMINI_SETTING_KEY'));
    expect(JSON.parse(String(wire().body))).toEqual(preview.body.mode === 'json' ? preview.body.json : undefined);
  });

  it('preserves ordinary adapted streaming preview but rejects it at the durable smoke executor', async () => {
    const profile = chatProfile(openAIStandardProfile);
    const input = channelChatInput(profile, profile.models[0].id, { messages: [{ role: 'user', content: 'Hello' }], stream: true });
    expect(previewChannel(profile, input).body).toMatchObject({ mode: 'json', json: { stream: true } });
    await expect(submitChannelSmoke(profile, input, 'NO_PAID_STREAM')).rejects.toThrow(/stream|流式/i);
    await expect(submitChannelJob(profile, input, 'NO_PAID_STREAM')).rejects.toThrow(/stream|流式/i);
    expect(bridge.fetch).not.toHaveBeenCalled(); expect(savedJobs()).toBe('');
  });
});

describe('job-scoped transient recovery credentials', () => {
  it('uses each submitting temporary key for same-profile recovery and retrieve without saving it or resubmitting', async () => {
    const profile = asyncProfile();
    await setChannelCredential(profile.id, 'SAVED_KEY_MUST_NOT_OVERRIDE');
    const input = { ...job(profile), operation: 'image.generate' as const };
    bridge.fetch.mockResolvedValueOnce(response({ id: 'first-task' })).mockResolvedValueOnce(response({ error: 'query denied' }, 401));
    const first = await submitChannelSmoke(profile, input, 'TEMPORARY_FIRST_KEY'); await waitForChannelJob(first);
    bridge.fetch.mockResolvedValueOnce(response({ id: 'second-task' })).mockResolvedValueOnce(response({ error: 'query denied' }, 401));
    const second = await submitChannelSmoke(profile, input, 'TEMPORARY_SECOND_KEY'); await waitForChannelJob(second);
    expect(getChannelJob(first)).toMatchObject({ status: 'recoverable_wait' });
    expect(getChannelJob(second)).toMatchObject({ status: 'recoverable_wait' });
    for (const [id, taskId, key] of [[first, 'first-task', 'TEMPORARY_FIRST_KEY'], [second, 'second-task', 'TEMPORARY_SECOND_KEY']]) {
      const start = bridge.fetch.mock.calls.length;
      bridge.fetch.mockResolvedValueOnce(response({ status: 'done' })).mockResolvedValueOnce(response({ error: 'result denied' }, 401));
      await recoverChannelJob(id); await waitForChannelJob(id);
      expect(bridge.fetch.mock.calls.slice(start).map(([url, init]) => ({ url, method: init?.method, headers: init?.headers }))).toEqual([
        { url: `https://relay.test/tasks/${taskId}`, method: 'GET', headers: expect.objectContaining({ Authorization: `Bearer ${key}` }) },
        { url: `https://relay.test/tasks/${taskId}/result`, method: 'GET', headers: expect.objectContaining({ Authorization: `Bearer ${key}` }) },
      ]);
    }
    expect(bridge.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
    for (const key of ['TEMPORARY_FIRST_KEY', 'TEMPORARY_SECOND_KEY', 'SAVED_KEY_MUST_NOT_OVERRIDE']) {
      expect(JSON.stringify([...values.values()])).not.toContain(key); expect(JSON.stringify(useChannelStore.getState())).not.toContain(key);
    }
  });

  it('recovers an unsaved new channel using its submitting temporary credential', async () => {
    const profile = asyncProfile(); const input = { ...job(profile), operation: 'image.generate' as const };
    bridge.fetch.mockResolvedValueOnce(response({ id: 'new-task' })).mockResolvedValueOnce(response({}, 401));
    const id = await submitChannelSmoke(profile, input, 'UNSAVED_NEW_KEY'); await waitForChannelJob(id);
    bridge.fetch.mockResolvedValueOnce(response({}, 403));
    await recoverChannelJob(id); await waitForChannelJob(id);
    expect(wire().headers).toMatchObject({ Authorization: 'Bearer UNSAVED_NEW_KEY' });
    expect(savedJobs()).not.toContain('UNSAVED_NEW_KEY'); expect(getChannelCredential(profile.id)).toBe('');
    expect(bridge.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('reconstructs authenticated saved outputs with the submitting temporary key', async () => {
    bridge.native = true; const profile = asyncProfile();
    profile.operations['image.generate']!.response = { mode: 'sync', outputs: [{ url: '/protected.png', kind: 'image', auth: true }] };
    bridge.http.mockResolvedValueOnce({ status: 200, text: '{}' }); bridge.image.mockRejectedValueOnce(new Error('download interrupted')).mockResolvedValueOnce({ imagePath: '/local/recovered.png' });
    const id = await submitChannelJob(profile, { ...job(profile), operation: 'image.generate' }, 'DOWNLOAD_TRANSIENT_KEY');
    expect(await waitForChannelJob(id)).toMatchObject({ status: 'recoverable_wait', resumable: true });
    await recoverChannelJob(id);
    expect(await waitForChannelJob(id)).toMatchObject({ status: 'succeeded', result: '/local/recovered.png' });
    expect(bridge.image).toHaveBeenLastCalledWith('https://relay.test/protected.png', { Authorization: 'Bearer DOWNLOAD_TRANSIENT_KEY' }, 512, expect.any(Object));
    expect(bridge.http).toHaveBeenCalledOnce(); expect(JSON.stringify(bridge.update.mock.calls)).not.toContain('DOWNLOAD_TRANSIENT_KEY');
  });

  it('retains vault references instead of caching plaintext that bypasses a later vault lock', async () => {
    const profile = asyncProfile(); await setChannelCredential(profile.id, 'LOCKED_VAULT_KEY');
    bridge.fetch.mockResolvedValueOnce(response({ id: 'vault-task' })).mockResolvedValueOnce(response({}, 401));
    const id = await submitChannelSmoke(profile, { ...job(profile), operation: 'image.generate' }); await waitForChannelJob(id);
    const calls = bridge.fetch.mock.calls.length;
    vi.mocked(secretStore.get).mockRejectedValue(new SecretStoreError('locked', 'test-lock'));
    await recoverChannelJob(id).catch(() => undefined); await vi.advanceTimersByTimeAsync(10); await waitForChannelJob(id);
    expect(bridge.fetch).toHaveBeenCalledTimes(calls); expect(savedJobs()).not.toContain('LOCKED_VAULT_KEY');
  });

  it('requires credential reconfiguration after reload and never restores a temporary key from snapshots', async () => {
    const profile = asyncProfile(); const id = `custom-local-channel-job-reloaded-${crypto.randomUUID()}`;
    storage.setItem('channel-generation-jobs-v2', JSON.stringify({ [id]: { job_id: id, status: 'unknown', external_task_id: 'reloaded-task', resumable: true,
      poll_descriptor: { version: 2, adapter: 'template', credentialSource: 'transient', profile, input: { ...job(profile), operation: 'image.generate', prompt: '' }, submit: {} } } }));
    await expect(recoverChannelJob(id)).rejects.toThrow(/凭据/); expect(bridge.fetch).not.toHaveBeenCalled();
  });

  it('does not reuse an older saved profile key after a transient replacement job reloads, and accepts explicit job reconfiguration', async () => {
    const profile = asyncProfile(); await setChannelCredential(profile.id, 'OLDER_SAVED_KEY');
    const id = `custom-local-channel-job-reloaded-replacement-${crypto.randomUUID()}`;
    storage.setItem('channel-generation-jobs-v2', JSON.stringify({ [id]: { job_id: id, status: 'unknown', external_task_id: 'replacement-task', resumable: true,
      poll_descriptor: { version: 2, adapter: 'template', credentialSource: 'transient', profile,
        input: { ...job(profile), operation: 'image.generate', prompt: '' }, submit: {} } } }));
    await expect(recoverChannelJob(id)).rejects.toThrow(/凭据/); expect(bridge.fetch).not.toHaveBeenCalled();
    bridge.fetch.mockResolvedValueOnce(response({}, 401));
    await recoverChannelJob(id, undefined, 'RECONFIGURED_JOB_KEY'); await waitForChannelJob(id);
    expect(wire().headers).toMatchObject({ Authorization: 'Bearer RECONFIGURED_JOB_KEY' }); expect(wire().method).toBe('GET');
    expect(savedJobs()).not.toContain('RECONFIGURED_JOB_KEY');
  });

  it('rejects an invalid saved credential-source marker instead of falling back to a profile key', async () => {
    const profile = asyncProfile(); await setChannelCredential(profile.id, 'UNRELATED_SAVED_KEY');
    const id = `custom-local-channel-job-invalid-credential-source-${crypto.randomUUID()}`;
    storage.setItem('channel-generation-jobs-v2', JSON.stringify({ [id]: { job_id: id, status: 'unknown', external_task_id: 'accepted-task', resumable: true,
      poll_descriptor: { version: 2, adapter: 'template', credentialSource: 'unknown-source', profile,
        input: { ...job(profile), operation: 'image.generate', prompt: '' }, submit: {} } } }));
    await expect(recoverChannelJob(id)).rejects.toMatchObject({ name: 'ZodError' });
    expect(bridge.fetch).not.toHaveBeenCalled();
  });

  it('durably marks replacement recovery of an original vault job before query and requires rebind after reload', async () => {
    const profile = asyncProfile(); await setChannelCredential(profile.id, 'ORIGINAL_SAVED_KEY');
    bridge.fetch.mockResolvedValueOnce(response({ id: 'original-vault-task' })).mockResolvedValueOnce(response({}, 401));
    const id = await submitChannelSmoke(profile, { ...job(profile), operation: 'image.generate' }); await waitForChannelJob(id);
    let sourceAtQuery: unknown;
    bridge.fetch.mockImplementationOnce(async () => {
      const persisted = z.record(z.string(), z.object({ poll_descriptor: z.object({ credentialSource: z.unknown().optional() }) })).parse(JSON.parse(savedJobs()));
      sourceAtQuery = persisted[id].poll_descriptor.credentialSource;
      return response({}, 401);
    });
    await recoverChannelJob(id, undefined, 'REPLACEMENT_RECOVERY_KEY'); await waitForChannelJob(id);
    expect(sourceAtQuery).toBe('transient'); expect(wire().headers).toMatchObject({ Authorization: 'Bearer REPLACEMENT_RECOVERY_KEY' });
    expect(savedJobs()).not.toContain('REPLACEMENT_RECOVERY_KEY');
    const saved = z.record(z.string(), z.record(z.string(), z.unknown())).parse(JSON.parse(savedJobs()));
    const reloaded = `custom-local-channel-job-reloaded-rebound-${crypto.randomUUID()}`;
    storage.setItem('channel-generation-jobs-v2', JSON.stringify({ ...saved, [reloaded]: { ...saved[id], job_id: reloaded } }));
    const calls = bridge.fetch.mock.calls.length;
    await expect(recoverChannelJob(reloaded)).rejects.toThrow(/凭据/);
    expect(bridge.fetch).toHaveBeenCalledTimes(calls);
  });

  it('fails closed before querying when replacement credential provenance cannot be persisted', async () => {
    bridge.native = true; const profile = asyncProfile(); await setChannelCredential(profile.id, 'ORIGINAL_VAULT_KEY');
    bridge.http.mockResolvedValueOnce({ status: 200, text: '{"id":"accepted-vault-task"}' }).mockResolvedValueOnce({ status: 401, text: '{}' });
    const id = await submitChannelSmoke(profile, { ...job(profile), operation: 'image.generate' }); await waitForChannelJob(id);
    const calls = bridge.http.mock.calls.length;
    bridge.update.mockRejectedValueOnce(new Error('credential provenance storage unavailable UNCOMMITTED_REPLACEMENT_KEY'));
    await expect(recoverChannelJob(id, undefined, 'UNCOMMITTED_REPLACEMENT_KEY')).rejects.toThrow('credential provenance storage unavailable [redacted]');
    expect(bridge.http).toHaveBeenCalledTimes(calls);
    expect(JSON.stringify(bridge.update.mock.calls)).not.toContain('UNCOMMITTED_REPLACEMENT_KEY');
    expect(JSON.stringify(await waitForChannelJob(id))).not.toContain('UNCOMMITTED_REPLACEMENT_KEY');
  });

  it('queries a resumable unknown task without submitting a replacement', async () => {
    const profile = asyncProfile(); await setChannelCredential(profile.id, 'RECONFIGURED_KEY');
    const id = `custom-local-channel-job-unknown-${crypto.randomUUID()}`;
    storage.setItem('channel-generation-jobs-v2', JSON.stringify({ [id]: { job_id: id, status: 'unknown', external_task_id: 'accepted-task', resumable: true,
      poll_descriptor: { version: 2, adapter: 'template', profile, input: { ...job(profile), operation: 'image.generate', prompt: '' }, submit: {} } } }));
    bridge.fetch.mockResolvedValueOnce(response({}, 401)); await recoverChannelJob(id); await waitForChannelJob(id);
    expect(bridge.fetch).toHaveBeenCalledOnce(); expect(wire().method).toBe('GET');
  });
});
