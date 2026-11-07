import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiModal } from './primitives';

interface UiConfirmProps {
  isOpen: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  tone?: 'danger' | 'primary';
  containerClassName?: string;
  onConfirm: () => void;
  onClose: () => void;
}

/** In-app replacement for `window.confirm`: themed, keyboard-reachable, same on every platform. */
export function UiConfirm({ isOpen, title, description, confirmLabel, tone = 'danger', containerClassName = 'z-100', onConfirm, onClose }: UiConfirmProps) {
  const { t } = useTranslation();
  return (
    <UiModal
      resizable={false}
      isOpen={isOpen}
      title={title}
      onClose={onClose}
      widthClassName="w-[min(400px,calc(100vw-1.5rem))]"
      containerClassName={containerClassName}
      footer={(
        <>
          <UiButton type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </UiButton>
          <UiButton
            type="button"
            variant={tone === 'danger' ? 'destructive' : 'primary'}
            data-autofocus="true"
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel ?? t('common.confirm')}
          </UiButton>
        </>
      )}
    >
      {description && <p className="text-sm leading-6 text-text-muted">{description}</p>}
    </UiModal>
  );
}
