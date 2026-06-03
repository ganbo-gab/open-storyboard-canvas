import type { CustomProviderConfig } from '@/stores/customProvidersStore';
import { isImageCustomProvider } from '@/stores/customProvidersStore';
import {
  getConfiguredApiKeyCount,
  type ProviderApiKeys,
} from '@/stores/settingsStore';

interface DreaminaProviderStatus {
  loggedIn: boolean;
}

interface ProviderAvailabilityInput {
  apiKeys: ProviderApiKeys;
  builtInProviderIds: readonly string[];
  customProviders: readonly CustomProviderConfig[];
  dreaminaStatus?: DreaminaProviderStatus | null;
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isNoAuthToken(value: unknown): boolean {
  if (!hasText(value)) {
    return false;
  }
  return /^(none|no[-_\s]?auth|anonymous|public|disabled)$/i.test(value.trim());
}

export function customProviderAllowsMissingApiKey(provider: CustomProviderConfig): boolean {
  const extraParams = asPlainRecord(provider.extraParams);
  if (!extraParams) {
    return false;
  }

  if (
    extraParams.allowNoApiKey === true
    || extraParams.allowNoKey === true
    || extraParams.noApiKeyRequired === true
    || extraParams.apiKeyOptional === true
    || extraParams.requiresApiKey === false
    || extraParams.apiKeyRequired === false
    || extraParams.authRequired === false
    || extraParams.requiresAuth === false
  ) {
    return true;
  }

  const auth = asPlainRecord(extraParams.auth);
  return isNoAuthToken(extraParams.auth)
    || isNoAuthToken(extraParams.authType)
    || isNoAuthToken(extraParams.authMode)
    || isNoAuthToken(auth?.type)
    || isNoAuthToken(auth?.mode);
}

export function hasCustomProviderCredential(provider: CustomProviderConfig): boolean {
  return hasText(provider.apiKey) || customProviderAllowsMissingApiKey(provider);
}

export function hasConfiguredCustomProvider(provider: CustomProviderConfig): boolean {
  return hasText(provider.baseUrl) && hasCustomProviderCredential(provider);
}

export function getConfiguredImageProviderCount({
  apiKeys,
  builtInProviderIds,
  customProviders,
  dreaminaStatus,
}: ProviderAvailabilityInput): number {
  const builtInCount = getConfiguredApiKeyCount(apiKeys, builtInProviderIds);
  const customCount = customProviders.filter((provider) => (
    isImageCustomProvider(provider) && hasConfiguredCustomProvider(provider)
  )).length;
  const dreaminaCount = dreaminaStatus?.loggedIn ? 1 : 0;

  return builtInCount + customCount + dreaminaCount;
}

export function hasConfiguredImageProvider(input: ProviderAvailabilityInput): boolean {
  return getConfiguredImageProviderCount(input) > 0;
}
