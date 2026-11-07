import { describe, expect, it } from 'vitest';
import captured from './legacyWireGoldens.json';
import { migrateLegacyConfig } from './legacyConfig';
import { validateProfile } from '../domain/profile';
import { renderRequest } from '../domain/template';
import type { CustomProviderConfig } from '@/stores/customProvidersStore';
import type { JsonValue } from '../domain/profile';

/** Captured by executing the original executor's pure preview builders before their deletion.
 * No migrated renderer participates in producing these expected requests.
 */
describe('captured legacy preset wire equivalence', () => {
  it.each(captured.fixtures.map((fixture) => [fixture.key, fixture] as const))('%s retains its actual old wire request or explicit prerequisite', async (_key, fixture) => {
    const config = fixture.config as CustomProviderConfig;
    const result = migrateLegacyConfig(config);
    expect(validateProfile(result.profile)).toEqual([]);
    if (!config.baseUrl || fixture.preview.bodyMode === 'signed') {
      expect(result.profile.operations).toEqual({});
      expect(result.unmigrated.length).toBeGreaterThan(0);
      return;
    }
    const modelId = config.models[0] ?? 'fixture-model';
    // Empty generic presets require the same user-provided model in both executions.
    if (!result.profile.models.length) result.profile.models.push({ id: modelId,
      operations: ['image.generate'], params: [
        { key: 'size', label: 'Size', type: 'text' }, { key: 'aspectRatio', label: 'Ratio', type: 'text' },
      ] });
    const model = result.profile.models[0];
    const params: Record<string, JsonValue> = {};
    for (const param of model.params) {
      const supplied = param.key === 'size' ? fixture.request.size : param.key === 'aspectRatio' ? fixture.request.aspect_ratio : undefined;
      if (supplied !== undefined) params[param.key] = param.options?.find((option) => option.label === supplied)?.value ?? supplied;
    }
    const { request } = await renderRequest(result.profile, { jobId: 'golden', channelId: result.profile.id, modelId,
      operation: config.mediaType === 'video' ? 'video.generate' : 'image.generate', prompt: fixture.request.prompt,
      params, refs: [], count: 1 }, config.apiKey, async () => { throw new Error('No refs in captured fixture'); });
    expect(request.url).toBe(fixture.preview.url);
    expect(request.method).toBe(fixture.preview.method);
    if (request.body.mode === 'json') expect(request.body.json).toEqual('body' in fixture.preview ? fixture.preview.body : undefined);
    else if (request.body.mode === 'multipart') {
      const old = 'multipart' in fixture.preview ? fixture.preview.multipart : undefined;
      expect(Object.fromEntries(request.body.fields.map(({ name, value }) => [name, value])))
        .toEqual(Object.fromEntries((old?.fields ?? []).map(({ name, value }) => [name, value])));
      expect(request.body.files).toEqual([]);
    } else throw new Error(`Unexpected captured wire mode ${request.body.mode}`);
  });
});
