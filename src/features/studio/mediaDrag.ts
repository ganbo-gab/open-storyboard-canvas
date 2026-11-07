/** In-app drags of library media. Payloads are ids only; the drop target re-reads the source record. */
export const STUDIO_MEDIA_DRAG_TYPE = 'application/x-open-storyboard-media+json';

export type StudioMediaDrag =
  | { kind: 'workbench-result'; taskId: string; resultIndex: number }
  | { kind: 'asset'; assetIds: string[] };

export function hasStudioMediaDrag(transfer: Pick<DataTransfer, 'types'> | null): boolean {
  return transfer?.types.includes(STUDIO_MEDIA_DRAG_TYPE) ?? false;
}

export function writeStudioMediaDrag(transfer: DataTransfer, payload: StudioMediaDrag): void {
  transfer.effectAllowed = 'copy';
  transfer.setData(STUDIO_MEDIA_DRAG_TYPE, JSON.stringify(payload));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function readStudioMediaDrag(transfer: Pick<DataTransfer, 'types' | 'getData'> | null): StudioMediaDrag | null {
  if (!transfer || !hasStudioMediaDrag(transfer)) return null;
  try {
    const raw: unknown = JSON.parse(transfer.getData(STUDIO_MEDIA_DRAG_TYPE));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    if (value.kind === 'workbench-result' && nonEmptyString(value.taskId)
      && typeof value.resultIndex === 'number' && Number.isSafeInteger(value.resultIndex) && value.resultIndex >= 0) {
      return { kind: 'workbench-result', taskId: value.taskId, resultIndex: value.resultIndex };
    }
    if (value.kind === 'asset' && Array.isArray(value.assetIds) && value.assetIds.length > 0 && value.assetIds.every(nonEmptyString)) {
      return { kind: 'asset', assetIds: [...value.assetIds] };
    }
    return null;
  } catch { return null; }
}
