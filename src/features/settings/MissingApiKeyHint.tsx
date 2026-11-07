import { useTranslation } from 'react-i18next';
import { UiButton } from '@/components/ui/primitives';
import { openSettingsDialog } from './settingsEvents';

interface MissingApiKeyHintProps {
  className?: string;
}

export function MissingApiKeyHint({ className = '' }: MissingApiKeyHintProps) {
  const { t } = useTranslation();

  return (
    <div className={`flex w-full justify-center ${className}`}>
      <div className="pointer-events-auto inline-flex w-full max-w-[640px] flex-col items-center gap-3 rounded-full border border-[var(--line-strong)] bg-elevated px-4 py-2 text-center shadow-[var(--shadow-pop)] sm:w-auto sm:flex-row sm:px-3">
        <p className="text-xs leading-5 text-text-muted">
          {t('settings.missingAnyApiKeyMessage')}
        </p>
        <UiButton
          type="button"
          variant="primary"
          size="sm"
          className="shrink-0 rounded-full"
          onClick={() => openSettingsDialog({ category: 'providers' })}
        >
          {t('settings.openProvidersSettings')}
        </UiButton>
      </div>
    </div>
  );
}
