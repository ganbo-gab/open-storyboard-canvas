import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiInput, UiModal } from '@/components/ui';

interface RenameDialogProps {
  isOpen: boolean;
  title: string;
  defaultValue?: string;
  onClose: () => void;
  onConfirm: (name: string) => void;
}

export function RenameDialog({
  isOpen,
  title,
  defaultValue = '',
  onClose,
  onConfirm,
}: RenameDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(defaultValue);

  useEffect(() => {
    if (isOpen) {
      setName(defaultValue);
    }
  }, [isOpen, defaultValue]);

  const handleConfirm = () => {
    if (name.trim()) {
      onConfirm(name.trim());
      onClose();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleConfirm();
    }
  };

  const canConfirm = Boolean(name.trim());

  return (
    <UiModal
      isOpen={isOpen}
      title={title}
      onClose={onClose}
      widthClassName="w-[min(360px,calc(100vw-1.5rem))]"
      containerClassName="z-[100]"
      footer={(
        <>
          <UiButton type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </UiButton>
          <UiButton
            type="button"
            variant="primary"
            onClick={handleConfirm}
            disabled={!canConfirm}
          >
            {t('common.confirm')}
          </UiButton>
        </>
      )}
    >
      <label className="block text-sm font-medium text-text-dark">
        <span>{t('project.name')}</span>
        <UiInput
          data-autofocus="true"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('project.namePlaceholder')}
          className="mt-2 h-10"
          maxLength={120}
        />
      </label>
    </UiModal>
  );
}
