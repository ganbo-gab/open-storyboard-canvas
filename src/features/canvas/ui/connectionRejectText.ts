import type { TFunction } from 'i18next';

import type { ConnectionRejectReason } from '@/features/canvas/application/canvasConnectionRules';

/** Localized, user-facing reason a connection is refused (shown on the hovered card while dragging). */
export function connectionRejectText(reason: ConnectionRejectReason, t: TFunction): string {
  switch (reason.type) {
    case 'missingNode':
      return t(reason.endpoint === 'source' ? 'canvas.connection.reject.missingSource' : 'canvas.connection.reject.missingTarget');
    case 'kindMismatch':
      return t('canvas.connection.reject.kindMismatch', {
        expected: reason.expected.map((kind) => t(`canvas.connection.kind.${kind}`)).join(' / '),
        actual: t(`canvas.connection.kind.${reason.actual}`),
      });
    default:
      return t(`canvas.connection.reject.${reason.type}`);
  }
}
