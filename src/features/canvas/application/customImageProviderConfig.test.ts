import { describe, expect, it } from 'vitest';
import type { CustomProviderConfig } from '@/stores/customProvidersStore';
import {
  createEmptyCustomImageProviderDraft,
  customImageProviderConfigToDraft,
  customImageProviderDraftFromUnknown,
  customImageProviderDraftToConfig,
  extractCustomImageProviderJson,
  resolveCustomImageRequestContract,
  writeCustomImageRequestContract,
} from './customImageProviderConfig';

function legacyProvider(overrides: Partial<CustomProviderConfig> = {}): CustomProviderConfig {
  return {
    id: 'legacy-provider',
    label: 'Legacy',
    baseUrl: 'https://example.com/v1',
    endpointPath: '/images/generations',
    httpMethod: 'POST',
    apiKey: 'secret',
    apiStyle: 'openai-compatible',
    models: ['image-model'],
    supportsWebSearch: false,
    responseFormat: 'generic',
    extraParams: {
      vendorExtension: { keep: true },
      requestBodyMode: 'multipart',
      requestBodyHints: { modelField: 'input.model', referenceImageField: 'image' },
      defaultRequestParams: { quality: 'high' },
      responseImagePath: 'payload.assets[0].url',
      asyncTask: {
        enabled: true,
        taskIdPath: 'id',
        resultEndpointPath: '/jobs/{taskId}',
        imagePath: 'result.url',
      },
      supportedRatios: ['auto', '16:9'],
    },
    ...overrides,
  };
}

describe('custom image provider config', () => {
  it('keeps a video ComfyUI provider in the video catalog after repeated draft saves', () => {
    const initial = legacyProvider({
      mediaType: 'video',
      apiStyle: 'comfyui',
      extraParams: {
        auth: { mode: 'none' },
        comfyui: {
          workflow: { '6': { class_type: 'CLIPTextEncode', inputs: { text: '' } } },
          outputNodeIds: ['6'],
        },
      },
    });
    const firstDraft = customImageProviderConfigToDraft(initial);
    const firstSave = customImageProviderDraftToConfig(firstDraft, initial.id).value!;
    const secondDraft = customImageProviderConfigToDraft(firstSave);
    const secondSave = customImageProviderDraftToConfig(secondDraft, initial.id).value!;

    expect(firstDraft.mediaType).toBe('video');
    expect(firstSave.mediaType).toBe('video');
    expect(secondDraft.mediaType).toBe('video');
    expect(secondSave.mediaType).toBe('video');
    expect(secondSave.extraParams?.mediaType).toBe('video');
  });

  it('lazily derives a versioned contract from legacy fields without changing endpoints', () => {
    const resolved = resolveCustomImageRequestContract(legacyProvider());

    expect(resolved.source).toBe('legacy');
    expect(resolved.value).toMatchObject({
      version: 1,
      textToImage: {
        endpointPath: '/images/generations',
        bodyMode: 'multipart',
        responseImagePaths: ['payload.assets[0].url'],
      },
      imageToImage: {
        endpointPath: '/images/generations',
        bodyMode: 'multipart',
      },
    });
  });

  it('dual-writes the contract and legacy mirrors while preserving unknown extra params', () => {
    const draft = customImageProviderConfigToDraft(legacyProvider());
    draft.imageRequestContract = {
      version: 1,
      textToImage: {
        endpointPath: '/images/generations',
        method: 'POST',
        bodyMode: 'form-urlencoded',
        bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}' },
        responseImagePaths: ['data[0].url'],
      },
      imageToImage: {
        endpointPath: '/images/generations',
        method: 'POST',
        bodyMode: 'multipart',
        bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}' },
        imageFields: [{ name: 'image', mode: 'repeat', encoding: 'base64' }],
      },
    };

    const saved = customImageProviderDraftToConfig(draft, 'fallback');

    expect(saved.issues).toEqual([]);
    expect(saved.value?.extraParams).toMatchObject({
      vendorExtension: { keep: true },
      imageRequestContract: draft.imageRequestContract,
      requestBodyMode: 'form-urlencoded',
      responseImagePath: 'data[0].url',
      imageGenerationEndpointPath: '/images/generations',
      imageEditEndpointPath: '/images/generations',
      defaultRequestParams: { quality: 'high' },
    });
    expect(saved.value?.extraParams?.requestBodyHints).toMatchObject({
      modelField: 'input.model',
      referenceImageField: 'image',
    });
  });

  it('clears stale legacy mirrors when the versioned contract removes owned fields', () => {
    const providerWithMirrors = legacyProvider({
      extraParams: {
        vendorExtension: { keep: true },
        requestBodyMode: 'multipart',
        bodyMode: 'multipart',
        requestBodyHints: {
          modelField: 'input.model',
          referenceImageField: 'old-image',
        },
        multipart: {
          enabled: true,
          fileField: 'old-image',
          vendorFlag: 'keep-me',
        },
        imageGenerationEndpointPath: '/old/generate',
        imageEditEndpointPath: '/old/edit',
        responseImagePath: 'old.url',
        responseImagePaths: ['old.url', 'old.url2'],
        asyncTask: { enabled: true, taskIdPath: 'id' },
        ratioMappings: { '16:9': { ratio: 'landscape' } },
      },
    });
    const draft = customImageProviderConfigToDraft(providerWithMirrors);
    draft.imageRequestContract = {
      version: 1,
      textToImage: {
        endpointPath: '/new/generate',
        method: 'POST',
        bodyMode: 'json',
        bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}' },
      },
    };

    const saved = customImageProviderDraftToConfig(draft, 'fallback');
    expect(saved.issues).toEqual([]);
    const extraParams = saved.value?.extraParams ?? {};

    expect(extraParams).toMatchObject({
      vendorExtension: { keep: true },
      requestBodyMode: 'json',
      imageGenerationEndpointPath: '/new/generate',
      requestBodyHints: { modelField: 'input.model' },
      multipart: { vendorFlag: 'keep-me' },
    });
    expect(extraParams).not.toHaveProperty('bodyMode');
    expect(extraParams).not.toHaveProperty('imageEditEndpointPath');
    expect(extraParams).not.toHaveProperty('responseImagePath');
    expect(extraParams).not.toHaveProperty('responseImagePaths');
    expect(extraParams).not.toHaveProperty('asyncTask');
    expect(extraParams).not.toHaveProperty('ratioMappings');
    expect(extraParams.requestBodyHints).not.toHaveProperty('referenceImageField');
    expect(extraParams.multipart).not.toHaveProperty('enabled');
    expect(extraParams.multipart).not.toHaveProperty('fileField');
  });

  it('round-trips a saved versioned contract through the unified draft', () => {
    const firstDraft = customImageProviderConfigToDraft(legacyProvider());
    firstDraft.imageRequestContract = {
      version: 1,
      textToImage: {
        endpointPath: '/custom/generate',
        bodyMode: 'json',
        bodyTemplate: {
          model_name: '{{model}}',
          input: { text: '{{prompt}}' },
        },
      },
      ratioMappings: {
        '16:9': {
          ratio: 'landscape',
          fields: { 'input.aspectRatio': '{{aspectRatio}}' },
        },
      },
    };
    const saved = customImageProviderDraftToConfig(firstDraft, 'fallback').value!;
    const reopened = customImageProviderConfigToDraft(saved);

    expect(reopened.imageRequestContract).toEqual(firstDraft.imageRequestContract);
    expect(reopened.defaultRequestParams).toEqual({ quality: 'high' });
  });

  it('returns field-level issues for invalid contract JSON instead of saving it', () => {
    const imported = customImageProviderDraftFromUnknown({
      label: 'Broken',
      imageRequestContract: {
        version: 1,
        textToImage: { method: 'DELETE', bodyTemplate: { callback: () => 'bad' } },
      },
    }, createEmptyCustomImageProviderDraft());

    expect(imported.issues.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      'imageRequestContract.textToImage.method',
      'imageRequestContract.textToImage.bodyTemplate.callback',
    ]));
  });

  it('preserves an AI/import signed-proxy requirement as an executable safety block', () => {
    const imported = customImageProviderDraftFromUnknown({
      templateKey: 'signed_proxy_required',
      compatibility: {
        canDirectCall: false,
        needsProxy: true,
        risk: 'signed-auth',
        reason: 'AK/SK signing is required',
      },
      label: 'Signed provider',
      baseUrl: 'https://signed.example.com',
      models: ['image-model'],
      imageRequestContract: {
        version: 1,
        textToImage: {
          endpointPath: '/generate',
          bodyMode: 'json',
          bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}' },
        },
      },
    });

    expect(imported.issues).toEqual([]);
    expect(imported.value?.extraParams).toMatchObject({
      transport: 'signed',
      needsProxy: true,
      signedAuth: { required: true },
      importPlan: {
        templateKey: 'signed_proxy_required',
        compatibility: { needsProxy: true, risk: 'signed-auth' },
      },
    });
  });

  it('extracts a single JSON object from markdown fences or surrounding text', () => {
    expect(extractCustomImageProviderJson('```json\n{"label":"Provider"}\n```'))
      .toEqual({ label: 'Provider' });
    expect(extractCustomImageProviderJson('result follows: {"label":"Provider"} done'))
      .toEqual({ label: 'Provider' });
  });

  it('clears removed legacy mirrors and preserves all response paths on dual-write', () => {
    const next = writeCustomImageRequestContract({
      vendorExtension: { keep: true },
      requestBodyMode: 'multipart',
      bodyMode: 'multipart',
      responseImagePath: 'old.url',
      responseImagePaths: ['old.url', 'old.alt'],
      asyncTask: { enabled: true, resultEndpointPath: '/jobs/{taskId}' },
      ratioMappings: { '16:9': { size: 'old' } },
      imageGenerationEndpointPath: '/old/generate',
      imageEditEndpointPath: '/old/edit',
      requestBodyHints: { modelField: 'input.model', referenceImageField: 'old-image' },
      multipart: { enabled: true, fileField: 'old-image' },
    }, {
      version: 1,
      textToImage: {
        endpointPath: '/new/generate',
        bodyMode: 'json',
        responseImagePaths: ['data[0].url', 'data[0].b64_json'],
      },
    });

    expect(next).toMatchObject({
      vendorExtension: { keep: true },
      imageGenerationEndpointPath: '/new/generate',
      responseImagePath: 'data[0].url',
      responseImagePaths: ['data[0].url', 'data[0].b64_json'],
      requestBodyHints: { modelField: 'input.model' },
    });
    expect(next.requestBodyMode).toBe('json');
    expect(next.bodyMode).toBeUndefined();
    expect(next.asyncTask).toBeUndefined();
    expect(next.ratioMappings).toBeUndefined();
    expect(next.imageEditEndpointPath).toBeUndefined();
    expect(next.requestBodyHints).not.toHaveProperty('referenceImageField');
    expect(next.multipart).toBeUndefined();
  });

  it('keeps legacy request-body hints available after migration and save', () => {
    const legacy = legacyProvider({
      apiStyle: 'generic-json',
      extraParams: {
        requestBodyMode: 'form-urlencoded',
        requestBodyHints: {
          modelField: 'input.model',
          promptField: 'input.prompt',
          ratioField: 'input.aspect_ratio',
          sizeField: 'input.size',
          referenceImageField: 'input.images',
        },
      },
    });

    const draft = customImageProviderConfigToDraft(legacy);
    const saved = customImageProviderDraftToConfig(draft, legacy.id);

    expect(saved.issues).toEqual([]);
    expect(saved.value?.extraParams?.requestBodyHints).toMatchObject({
      modelField: 'input.model',
      promptField: 'input.prompt',
      ratioField: 'input.aspect_ratio',
      sizeField: 'input.size',
      referenceImageField: 'input.images',
    });
    expect(saved.value?.extraParams?.imageRequestContract).toMatchObject({
      imageToImage: { bodyMode: 'form-urlencoded' },
    });
  });
});
