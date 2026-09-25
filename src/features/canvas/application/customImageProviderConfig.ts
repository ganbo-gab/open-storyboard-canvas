import type { CustomProviderConfig } from '@/stores/customProvidersStore';
import {
  normalizeProviderBaseUrl,
  normalizeProviderEndpointPath,
} from './providerUrl';
import {
  normalizeCustomImageRequestContract,
  CUSTOM_IMAGE_REQUEST_LEGACY_FALLBACK_KEY,
  type ContractValidationIssue,
  type CustomImageRequestContractV1,
  type ImageRequestBodyMode,
  type ImageRequestVariantV1,
  type JsonTemplateValue,
} from './customImageProviderContract';

export interface CustomImageProviderDraft extends Omit<CustomProviderConfig, 'id' | 'extraParams'> {
  id: string | null;
  supportedRatios: string[];
  extraParams: Record<string, unknown>;
  defaultRequestParams: Record<string, unknown>;
  imageRequestContract: CustomImageRequestContractV1;
}

export interface CustomImageProviderFieldIssue {
  path: string;
  message: string;
}

export interface CustomImageProviderDraftResult {
  value: CustomImageProviderDraft | null;
  issues: CustomImageProviderFieldIssue[];
}

export interface CustomImageProviderConfigResult {
  value: CustomProviderConfig | null;
  issues: CustomImageProviderFieldIssue[];
}

export interface ResolvedCustomImageRequestContract {
  value: CustomImageRequestContractV1;
  source: 'versioned' | 'legacy';
  issues: ContractValidationIssue[];
}

const DEFAULT_RATIOS = ['auto', '16:9', '1:1'];
const BODY_MODES = new Set<ImageRequestBodyMode>(['json', 'multipart', 'form-urlencoded']);
const RESPONSE_FORMATS = new Set(['openai-images', 'url-array', 'data-url', 'generic']);
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function uniqueStrings(value: unknown, fallback: string[] = []): string[] {
  const values = Array.isArray(value) ? value : fallback;
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((entry) => {
    const normalized = typeof entry === 'string' ? entry.trim() : String(entry ?? '').trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    result.push(normalized);
  });
  return result;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isPlainRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key.trim() && !UNSAFE_KEYS.has(key))
      .map(([key, entry]) => [key.trim(), String(entry ?? '')]),
  );
}

function cloneJsonRecord(
  value: unknown,
  path: string,
  issues: CustomImageProviderFieldIssue[],
): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!isPlainRecord(value)) {
    issues.push({ path, message: '必须是 JSON 对象' });
    return {};
  }

  const cloneValue = (entry: unknown, entryPath: string): unknown => {
    if (
      entry === null
      || typeof entry === 'string'
      || typeof entry === 'boolean'
      || (typeof entry === 'number' && Number.isFinite(entry))
    ) {
      return entry;
    }
    if (Array.isArray(entry)) {
      return entry.map((item, index) => cloneValue(item, `${entryPath}[${index}]`));
    }
    if (isPlainRecord(entry)) {
      const result: Record<string, unknown> = {};
      Object.entries(entry).forEach(([key, item]) => {
        if (UNSAFE_KEYS.has(key)) {
          issues.push({ path: `${entryPath}.${key}`, message: '不允许原型或构造器字段' });
          return;
        }
        result[key] = cloneValue(item, `${entryPath}.${key}`);
      });
      return result;
    }
    issues.push({ path: entryPath, message: '仅允许 JSON 值' });
    return null;
  };

  return cloneValue(value, path) as Record<string, unknown>;
}

function importedPlanFromSource(
  source: Record<string, unknown>,
  issues: CustomImageProviderFieldIssue[],
): Record<string, unknown> | null {
  const rawPlan = Object.fromEntries(
    ['templateKey', 'templateReason', 'compatibility', 'requestPlan', 'responsePlan']
      .filter((key) => source[key] !== undefined && source[key] !== null && source[key] !== '')
      .map((key) => [key, source[key]]),
  );
  if (Object.keys(rawPlan).length === 0) return null;
  return cloneJsonRecord(rawPlan, 'importPlan', issues);
}

function importPlanRequiresSignedProxy(importPlan: Record<string, unknown> | null): boolean {
  if (!importPlan) return false;
  const compatibility = isPlainRecord(importPlan.compatibility) ? importPlan.compatibility : {};
  const requestPlan = isPlainRecord(importPlan.requestPlan) ? importPlan.requestPlan : {};
  const templateKey = String(importPlan.templateKey ?? '').trim().toLowerCase();
  const risk = String(compatibility.risk ?? '').trim().toLowerCase();
  const mode = String(requestPlan.mode ?? '').trim().toLowerCase();
  return templateKey === 'signed_proxy_required'
    || compatibility.needsProxy === true
    || risk === 'signed-auth'
    || risk === 'signed'
    || mode === 'signed'
    || mode === 'signed-auth';
}

function responsePathsFromLegacy(extraParams: Record<string, unknown>): string[] | undefined {
  const rawPaths = extraParams.responseImagePaths;
  const values = Array.isArray(rawPaths)
    ? rawPaths
    : typeof extraParams.responseImagePath === 'string'
      ? [extraParams.responseImagePath]
      : [];
  const paths = uniqueStrings(values);
  return paths.length > 0 ? paths : undefined;
}

function legacyBodyMode(extraParams: Record<string, unknown>): ImageRequestBodyMode | undefined {
  const rawMode = String(extraParams.requestBodyMode ?? extraParams.bodyMode ?? '').trim().toLowerCase();
  if (BODY_MODES.has(rawMode as ImageRequestBodyMode)) return rawMode as ImageRequestBodyMode;
  if (isPlainRecord(extraParams.multipart) && extraParams.multipart.enabled !== false) return 'multipart';
  return undefined;
}

function legacyVariant(
  provider: Pick<CustomProviderConfig, 'endpointPath' | 'httpMethod' | 'extraParams'>,
  endpointPath: string | undefined,
): ImageRequestVariantV1 {
  const extraParams = isPlainRecord(provider.extraParams) ? provider.extraParams : {};
  const bodyMode = legacyBodyMode(extraParams);
  const responseImagePaths = responsePathsFromLegacy(extraParams);
  const asyncTask = isPlainRecord(extraParams.asyncTask)
    ? extraParams.asyncTask as Record<string, JsonTemplateValue>
    : undefined;
  return {
    ...(endpointPath ? { endpointPath } : {}),
    ...(provider.httpMethod ? { method: provider.httpMethod } : {}),
    ...(bodyMode ? { bodyMode } : {}),
    ...(responseImagePaths ? { responseImagePaths } : {}),
    ...(asyncTask ? { asyncTask } : {}),
  };
}

function deriveLegacyContract(
  provider: Pick<CustomProviderConfig, 'endpointPath' | 'httpMethod' | 'extraParams'>,
): CustomImageRequestContractV1 {
  const extraParams = isPlainRecord(provider.extraParams) ? provider.extraParams : {};
  const configuredEndpoint = normalizeProviderEndpointPath(provider.endpointPath ?? '') || undefined;
  const textEndpoint = normalizeProviderEndpointPath(
    typeof extraParams.imageGenerationEndpointPath === 'string'
      ? extraParams.imageGenerationEndpointPath
      : configuredEndpoint ?? '',
  ) || undefined;
  const imageEndpoint = normalizeProviderEndpointPath(
    typeof extraParams.imageEditEndpointPath === 'string'
      ? extraParams.imageEditEndpointPath
      : configuredEndpoint ?? textEndpoint ?? '',
  ) || undefined;
  const rawRatioMappings = extraParams.ratioMappings;
  const ratioMappings = isPlainRecord(rawRatioMappings)
    ? rawRatioMappings
    : undefined;
  const normalized = normalizeCustomImageRequestContract({
    version: 1,
    textToImage: legacyVariant(provider, textEndpoint),
    imageToImage: legacyVariant(provider, imageEndpoint),
    ...(ratioMappings ? { ratioMappings } : {}),
  });
  return normalized.value ?? { version: 1 };
}

export function resolveCustomImageRequestContract(
  provider: Pick<CustomProviderConfig, 'endpointPath' | 'httpMethod' | 'extraParams'>,
): ResolvedCustomImageRequestContract {
  const extraParams = isPlainRecord(provider.extraParams) ? provider.extraParams : {};
  const rawContract = extraParams.imageRequestContract;
  if (rawContract !== undefined && rawContract !== null) {
    const normalized = normalizeCustomImageRequestContract(rawContract);
    if (normalized.value && normalized.issues.length === 0) {
      return { value: normalized.value, source: 'versioned', issues: [] };
    }
    return {
      value: deriveLegacyContract(provider),
      source: 'legacy',
      issues: normalized.issues,
    };
  }
  return { value: deriveLegacyContract(provider), source: 'legacy', issues: [] };
}

function firstResponsePath(contract: CustomImageRequestContractV1): string | undefined {
  return contract.textToImage?.responseImagePaths?.[0]
    ?? contract.imageToImage?.responseImagePaths?.[0];
}

function firstAsyncTask(contract: CustomImageRequestContractV1): Record<string, JsonTemplateValue> | undefined {
  return contract.textToImage?.asyncTask ?? contract.imageToImage?.asyncTask;
}

function firstImageField(contract: CustomImageRequestContractV1): string | undefined {
  return contract.imageToImage?.imageFields?.[0]?.name;
}

export function writeCustomImageRequestContract(
  extraParams: Record<string, unknown> | undefined,
  contract: CustomImageRequestContractV1,
  defaultRequestParams?: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = normalizeCustomImageRequestContract(contract);
  if (!normalized.value || normalized.issues.length > 0) {
    throw new Error(normalized.issues.map((entry) => `${entry.path}: ${entry.message}`).join('；'));
  }
  const value = normalized.value;
  const next: Record<string, unknown> = {
    ...(extraParams ?? {}),
    imageRequestContract: value,
  };
  const contractOwnsWireShape = Boolean(
    value.textToImage?.bodyTemplate !== undefined
      || value.imageToImage?.bodyTemplate !== undefined
      || (value.textToImage?.imageFields?.length ?? 0) > 0
      || (value.imageToImage?.imageFields?.length ?? 0) > 0,
  );
  if (contractOwnsWireShape) {
    delete next[CUSTOM_IMAGE_REQUEST_LEGACY_FALLBACK_KEY];
  }

  // These keys are compatibility mirrors owned by this adapter. Remove the
  // previous values first so clearing a field in the new contract cannot
  // silently resurrect the old behavior on a legacy reader.
  [
    'requestBodyMode',
    'bodyMode',
    'imageGenerationEndpointPath',
    'imageEditEndpointPath',
    'responseImagePath',
    'responseImagePaths',
    'asyncTask',
    'ratioMappings',
  ].forEach((key) => delete next[key]);

  const previousMultipart = isPlainRecord(next.multipart) ? { ...next.multipart } : null;
  const previousHints = isPlainRecord(next.requestBodyHints) ? { ...next.requestBodyHints } : null;
  const hasDeclaredImageFields = Boolean(
    (value.textToImage?.imageFields?.length ?? 0) > 0
      || (value.imageToImage?.imageFields?.length ?? 0) > 0,
  );
  // A legacy image-to-image variant has no declarative imageFields yet. Keep
  // its referenceImageField as a compatibility fallback; the gateway applies
  // the remaining requestBodyHints when the new contract has no template.
  // Once the user declares imageFields (or removes imageToImage entirely),
  // the old managed marker is safe to replace/clear.
  const preserveLegacyReferenceField = Boolean(value.imageToImage) && !hasDeclaredImageFields;
  if (previousHints) {
    if (!preserveLegacyReferenceField) delete previousHints.referenceImageField;
    if (Object.keys(previousHints).length > 0) next.requestBodyHints = previousHints;
    else delete next.requestBodyHints;
  }
  if (previousMultipart && previousMultipart.enabled !== true) {
    delete previousMultipart.enabled;
  }
  if (previousMultipart && Object.keys(previousMultipart).length > 0) {
    next.multipart = previousMultipart;
  } else {
    delete next.multipart;
  }

  if (defaultRequestParams) next.defaultRequestParams = defaultRequestParams;
  const primaryBodyMode = value.textToImage?.bodyMode ?? value.imageToImage?.bodyMode;
  if (primaryBodyMode) {
    next.requestBodyMode = primaryBodyMode;
  }
  if (value.textToImage?.endpointPath) {
    next.imageGenerationEndpointPath = value.textToImage.endpointPath;
  }
  if (value.imageToImage?.endpointPath) {
    next.imageEditEndpointPath = value.imageToImage.endpointPath;
  }
  const responseImagePath = firstResponsePath(value);
  const responseImagePaths = value.textToImage?.responseImagePaths
    ?? value.imageToImage?.responseImagePaths
    ?? [];
  if (responseImagePath) next.responseImagePath = responseImagePath;
  if (responseImagePaths.length > 0) next.responseImagePaths = responseImagePaths;
  const asyncTask = firstAsyncTask(value);
  if (asyncTask) next.asyncTask = asyncTask;
  if (value.ratioMappings) next.ratioMappings = value.ratioMappings;

  const imageField = firstImageField(value);
  if (imageField) {
    const requestBodyHints = isPlainRecord(next.requestBodyHints) ? next.requestBodyHints : {};
    next.requestBodyHints = { ...requestBodyHints, referenceImageField: imageField };
    if (value.imageToImage?.bodyMode === 'multipart') {
      const multipart = isPlainRecord(next.multipart) ? next.multipart : {};
      next.multipart = { ...multipart, enabled: true, fileField: imageField.replace(/\[\]$/, '') };
    }
  } else if (
    value.textToImage?.bodyMode !== 'multipart'
      && value.imageToImage?.bodyMode !== 'multipart'
  ) {
    // A non-multipart contract must not inherit the old multipart transport
    // marker. Unknown vendor fields inside the object are retained above.
    const multipart = isPlainRecord(next.multipart) ? { ...next.multipart } : null;
    if (multipart) {
      delete multipart.enabled;
      delete multipart.fileField;
      if (Object.keys(multipart).length > 0) next.multipart = multipart;
      else delete next.multipart;
    }
  }

  // This editor owns full-custom configs. Never accidentally route them into
  // the preset/modern editor through a template inherited during import.
  if (next.providerConfigVersion === 'new-v1') delete next.providerConfigVersion;
  if (next.requestComposer === 'modern') delete next.requestComposer;
  return next;
}

export function createEmptyCustomImageProviderDraft(): CustomImageProviderDraft {
  return {
    id: null,
    mediaType: 'image',
    label: '',
    baseUrl: '',
    endpointPath: '',
    modelListEndpointPath: '/models',
    httpMethod: 'POST',
    apiKey: '',
    apiStyle: 'openai-compatible',
    models: [],
    supportsWebSearch: false,
    supportedRatios: [...DEFAULT_RATIOS],
    supportedResolutions: [],
    supportedModelVersions: [],
    extraHeaders: {},
    queryParams: {},
    responseFormat: 'openai-images',
    extraParams: {},
    defaultRequestParams: {},
    imageRequestContract: { version: 1 },
    note: '',
  };
}

export function customImageProviderConfigToDraft(provider: CustomProviderConfig): CustomImageProviderDraft {
  const extraParams = isPlainRecord(provider.extraParams) ? { ...provider.extraParams } : {};
  const resolvedContract = resolveCustomImageRequestContract(provider);
  const contract = resolvedContract.value;
  if (resolvedContract.source === 'legacy') {
    extraParams[CUSTOM_IMAGE_REQUEST_LEGACY_FALLBACK_KEY] = true;
  }
  const defaultRequestParams = isPlainRecord(extraParams.defaultRequestParams)
    ? { ...extraParams.defaultRequestParams }
    : {};
  const ratios = uniqueStrings(extraParams.supportedRatios, DEFAULT_RATIOS);
  return {
    ...provider,
    id: provider.id,
    mediaType: provider.apiStyle === 'comfyui' && provider.mediaType === 'video' ? 'video' : 'image',
    endpointPath: provider.endpointPath ?? '',
    modelListEndpointPath: provider.modelListEndpointPath ?? '/models',
    httpMethod: provider.httpMethod ?? 'POST',
    queryParams: provider.queryParams ?? {},
    responseFormat: provider.responseFormat ?? 'openai-images',
    supportedRatios: ratios.length > 0 ? ratios : [...DEFAULT_RATIOS],
    supportedResolutions: provider.supportedResolutions ?? [],
    supportedModelVersions: provider.supportedModelVersions ?? [],
    extraHeaders: provider.extraHeaders ?? {},
    extraParams,
    defaultRequestParams,
    imageRequestContract: contract,
  };
}

function normalizeImportedContract(
  source: Record<string, unknown>,
  fallbackProvider: Pick<CustomProviderConfig, 'endpointPath' | 'httpMethod' | 'extraParams'>,
  issues: CustomImageProviderFieldIssue[],
): CustomImageRequestContractV1 {
  const extraParams = isPlainRecord(source.extraParams) ? source.extraParams : {};
  const rawContract = source.imageRequestContract ?? extraParams.imageRequestContract;
  if (rawContract === undefined) {
    return resolveCustomImageRequestContract(fallbackProvider).value;
  }
  const normalized = normalizeCustomImageRequestContract(rawContract);
  issues.push(...normalized.issues.map((entry) => ({
    path: `imageRequestContract.${entry.path.replace(/^imageRequestContract\.?/, '')}`.replace(/\.$/, ''),
    message: entry.message,
  })));
  return normalized.value ?? resolveCustomImageRequestContract(fallbackProvider).value;
}

export function customImageProviderDraftFromUnknown(
  input: unknown,
  baseDraft: CustomImageProviderDraft = createEmptyCustomImageProviderDraft(),
): CustomImageProviderDraftResult {
  const issues: CustomImageProviderFieldIssue[] = [];
  if (!isPlainRecord(input)) {
    return { value: null, issues: [{ path: 'config', message: '配置必须是 JSON 对象' }] };
  }
  const sourceExtraParams = cloneJsonRecord(input.extraParams, 'extraParams', issues);
  const extraParams = {
    ...baseDraft.extraParams,
    ...sourceExtraParams,
  };
  const importPlan = importedPlanFromSource(input, issues);
  if (importPlan) extraParams.importPlan = importPlan;
  if (importPlanRequiresSignedProxy(importPlan)) {
    extraParams.transport = 'signed';
    extraParams.needsProxy = true;
    extraParams.signedAuth = {
      ...(isPlainRecord(extraParams.signedAuth) ? extraParams.signedAuth : {}),
      required: true,
    };
  }
  const importedContract = input.imageRequestContract ?? sourceExtraParams.imageRequestContract;
  const hasImportedContract = importedContract !== undefined && importedContract !== null;
  if (!hasImportedContract) {
    extraParams[CUSTOM_IMAGE_REQUEST_LEGACY_FALLBACK_KEY] = true;
  }
  const defaultRequestParams = cloneJsonRecord(
    input.defaultRequestParams ?? sourceExtraParams.defaultRequestParams ?? baseDraft.defaultRequestParams,
    'defaultRequestParams',
    issues,
  );
  const method = String(input.httpMethod ?? baseDraft.httpMethod ?? 'POST').trim().toUpperCase();
  const responseFormat = String(input.responseFormat ?? baseDraft.responseFormat ?? 'generic');
  const endpointPath = String(input.endpointPath ?? baseDraft.endpointPath ?? '');
  const fallbackProvider = {
    endpointPath,
    httpMethod: method === 'GET' ? 'GET' as const : 'POST' as const,
    extraParams: {
      ...extraParams,
      defaultRequestParams,
    },
  };
  const imageRequestContract = normalizeImportedContract(input, fallbackProvider, issues);

  const value: CustomImageProviderDraft = {
    ...baseDraft,
    id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : baseDraft.id,
    mediaType: input.apiStyle === 'comfyui' && input.mediaType === 'video' ? 'video' : 'image',
    label: String(input.label ?? baseDraft.label ?? ''),
    baseUrl: String(input.baseUrl ?? baseDraft.baseUrl ?? ''),
    endpointPath,
    modelListEndpointPath: String(input.modelListEndpointPath ?? baseDraft.modelListEndpointPath ?? ''),
    httpMethod: method === 'GET' ? 'GET' : 'POST',
    apiKey: '',
    apiStyle: String(input.apiStyle ?? baseDraft.apiStyle ?? 'generic-json'),
    models: uniqueStrings(input.models, baseDraft.models),
    supportsWebSearch: Boolean(input.supportsWebSearch ?? baseDraft.supportsWebSearch),
    supportedRatios: uniqueStrings(input.supportedRatios, baseDraft.supportedRatios),
    supportedResolutions: uniqueStrings(input.supportedResolutions, baseDraft.supportedResolutions),
    supportedModelVersions: uniqueStrings(input.supportedModelVersions, baseDraft.supportedModelVersions),
    extraHeaders: stringRecord(input.extraHeaders ?? baseDraft.extraHeaders),
    queryParams: stringRecord(input.queryParams ?? baseDraft.queryParams),
    responseFormat: RESPONSE_FORMATS.has(responseFormat)
      ? responseFormat as CustomImageProviderDraft['responseFormat']
      : 'generic',
    extraParams,
    defaultRequestParams,
    imageRequestContract,
    note: String(input.note ?? baseDraft.note ?? ''),
  };
  return { value, issues };
}

export function customImageProviderDraftToConfig(
  draft: CustomImageProviderDraft,
  fallbackId: string,
): CustomImageProviderConfigResult {
  const issues: CustomImageProviderFieldIssue[] = [];
  const normalizedContract = normalizeCustomImageRequestContract(draft.imageRequestContract);
  issues.push(...normalizedContract.issues.map((entry) => ({
    path: `imageRequestContract.${entry.path.replace(/^imageRequestContract\.?/, '')}`.replace(/\.$/, ''),
    message: entry.message,
  })));
  const defaultRequestParams = cloneJsonRecord(
    draft.defaultRequestParams,
    'defaultRequestParams',
    issues,
  );
  if (!normalizedContract.value || issues.length > 0) {
    return { value: null, issues };
  }

  const mediaType = draft.apiStyle === 'comfyui' && draft.mediaType === 'video' ? 'video' : 'image';

  const extraParams = writeCustomImageRequestContract(
    {
      ...(draft.extraParams ?? {}),
      mediaType,
      supportedRatios: uniqueStrings(draft.supportedRatios, DEFAULT_RATIOS),
    },
    normalizedContract.value,
    defaultRequestParams,
  );
  const textEndpoint = normalizedContract.value.textToImage?.endpointPath;
  const configuredEndpoint = normalizeProviderEndpointPath(textEndpoint ?? draft.endpointPath ?? '');
  const configuredMethod = normalizedContract.value.textToImage?.method ?? draft.httpMethod ?? 'POST';

  return {
    value: {
      id: draft.id ?? fallbackId,
      label: draft.label.trim() || '未命名配置',
      mediaType,
      baseUrl: normalizeProviderBaseUrl(draft.baseUrl),
      endpointPath: configuredEndpoint,
      modelListEndpointPath: normalizeProviderEndpointPath(draft.modelListEndpointPath ?? ''),
      httpMethod: configuredMethod,
      apiKey: draft.apiKey,
      apiStyle: draft.apiStyle,
      models: uniqueStrings(draft.models),
      supportsWebSearch: draft.supportsWebSearch,
      extraHeaders: { ...(draft.extraHeaders ?? {}) },
      queryParams: { ...(draft.queryParams ?? {}) },
      responseFormat: draft.responseFormat ?? 'openai-images',
      supportedResolutions: uniqueStrings(draft.supportedResolutions).length > 0
        ? uniqueStrings(draft.supportedResolutions)
        : undefined,
      supportedModelVersions: uniqueStrings(draft.supportedModelVersions).length > 0
        ? uniqueStrings(draft.supportedModelVersions)
        : undefined,
      extraParams,
      note: draft.note ?? '',
    },
    issues: [],
  };
}

export function extractCustomImageProviderJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('JSON 内容为空');
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const source = fenced?.[1]?.trim() ?? trimmed;
  try {
    const parsed = JSON.parse(source) as unknown;
    return Array.isArray(parsed) ? parsed[0] : parsed;
  } catch (initialError) {
    const start = source.indexOf('{');
    const end = source.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(source.slice(start, end + 1)) as unknown;
      } catch {
        // Fall through to the original, more useful JSON parse error.
      }
    }
    throw initialError;
  }
}

export function parseCustomImageProviderJsonRecord(
  text: string,
  fieldLabel = 'JSON',
): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed) as unknown;
  if (!isPlainRecord(parsed)) {
    throw new Error(`${fieldLabel} 必须是 JSON 对象`);
  }
  return parsed;
}

export function stringifyCustomImageRequestContract(contract: CustomImageRequestContractV1): string {
  return JSON.stringify(contract, null, 2);
}
