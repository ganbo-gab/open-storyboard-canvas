import { uploadImageToConfiguredHost } from '@/features/canvas/application/imageHosting';
import { normalizeImageHostSettings, useSettingsStore, type ImageHostSettings } from '@/stores/settingsStore';
import { imageHostConfigurationError } from '@/features/settings/imageHostSettings';
import { getAssetPortableSource } from '@/features/assets/application/assetMediaStorage';
import { isPublicReferenceUrl } from '../domain/referenceErrors';
import type { JobRef } from '../runtime/types';

/** Ready only after an explicit custom upload endpoint has been configured and enabled. */
export function isImageHostConfigured(raw: ImageHostSettings = useSettingsStore.getState().imageHostSettings): boolean {
  const settings = normalizeImageHostSettings(raw);
  return settings.enabled && imageHostConfigurationError(settings) === null;
}

/** Explicit UI action only: call after the user confirms disclosure to their configured host. */
export async function uploadChannelReferenceToConfiguredHost(ref: JobRef, confirmation: { confirmed: true }, index = 0): Promise<JobRef> {
  if (confirmation?.confirmed !== true) throw new Error('reference.uploadNotConfirmed');
  if (isPublicReferenceUrl(ref.path)) return ref;
  // The configured hosting contract is image-only; never disguise audio/video as images.
  if (ref.kind !== 'image') throw new Error('reference.publicUrlRequiredForMedia');
  const path = await uploadImageToConfiguredHost(await getAssetPortableSource(ref.path), index, useSettingsStore.getState().imageHostSettings);
  if (!isPublicReferenceUrl(path)) throw new Error('reference.invalidHostedUrl');
  return { ...ref, path };
}

/**
 * Host every local source of one slot after explicit confirmation and return the updated slot map.
 * Sources already public are kept as-is; order and the other slots are untouched.
 */
export async function hostChannelReferenceSlot(
  referenceSlots: Record<string, string[]>,
  slotKey: string,
  slotKind: JobRef['kind'],
  confirmation: { confirmed: true },
): Promise<Record<string, string[]>> {
  const sources = referenceSlots[slotKey] ?? [];
  const hosted: string[] = [];
  for (const [index, path] of sources.entries()) {
    const ref = await uploadChannelReferenceToConfiguredHost({ kind: slotKind, slot: slotKey, assetId: `${slotKey}-${index}`, path, mime: `${slotKind}/*` }, confirmation, index);
    hosted.push(ref.path);
  }
  return { ...referenceSlots, [slotKey]: hosted };
}
