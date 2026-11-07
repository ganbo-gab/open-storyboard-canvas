import { describe, expect, it } from 'vitest';
import { credentialFailureOf } from './credentialFailure';
import { SecretStoreError } from './secretStore';
import { classifyTransportError } from '@/features/channels/domain/errors';
import { classifyWorkbenchFailure } from '@/features/workbench/domain/types';
import { ModelDownloadError } from '@/features/stage/application/imageTo3dMaterialization';

describe('credential failures at request boundaries', () => {
  it.each([
    { state: 'locked', code: 'storage_locked' },
    '{"state":"locked","code":"storage_locked"}',
    new Error('{"state":"error","code":"invalid_encoding"}'),
    new SecretStoreError('locked', 'vault-locked'),
    new SecretStoreError('error', 'credential-missing'),
    new ModelDownloadError('credential', '{"state":"locked","code":"storage_locked"}'),
  ])('keeps native, wrapped and browser vault failures out of network retries (%s)', (error) => {
    expect(credentialFailureOf(error)).not.toBeNull();
    expect(classifyTransportError(error)).toMatchObject({ beforeSend: true, error: { category: 'credential', retryable: false } });
    expect(classifyWorkbenchFailure(error, true)).toMatchObject({ kind: 'authentication' });
  });
  it.each([new Error('Connection timeout after send'), '{"state":"locked","code":"upstream_custom_error"}',
    { state: 'other', code: 'storage_locked' }, 'storage_locked'])('does not invent pre-send proof from unrelated errors (%s)', (error) => {
    expect(credentialFailureOf(error)).toBeNull();
    expect(classifyTransportError(error).beforeSend).toBe(false);
  });
});
