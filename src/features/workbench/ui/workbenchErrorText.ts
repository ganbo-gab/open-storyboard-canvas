import { WorkbenchReferenceSlotFullError } from '../application/appendReferences';
import type { TFunction } from 'i18next';

import type { WorkbenchValidationIssue } from '../application/workbenchValidation';
import { WorkbenchDraftValidationError } from '../application/workbenchValidation';

const MEDIA_KIND_LABEL: Record<string, string> = {
  image: 'rework.image',
  video: 'rework.video',
  audio: 'rework.audio',
  chat: 'rework.chat',
};

/** One validation issue as user text; media-kind params are shown in the UI language. */
export function validationIssueText(t: TFunction, issue: WorkbenchValidationIssue): string {
  const kind = issue.params.kind;
  const label = typeof kind === 'string' ? MEDIA_KIND_LABEL[kind] : undefined;
  return t(`rework.validation.${issue.code}`, { ...issue.params, ...(label ? { kind: t(label) } : {}), defaultValue: issue.code });
}

/** Store errors carry stable codes as messages; translate known codes and keep upstream text otherwise. */
export function workbenchErrorText(t: TFunction, exists: (key: string) => boolean, cause: unknown): string {
  if (cause instanceof WorkbenchReferenceSlotFullError) return t('channelModes.noFreeSlot', { mode: cause.modeLabel });
  if (cause instanceof WorkbenchDraftValidationError && cause.issues[0]) return validationIssueText(t, cause.issues[0]);
  const message = cause instanceof Error ? cause.message : String(cause);
  const key = `rework.validation.${message}`;
  return exists(key) ? t(key) : message;
}
