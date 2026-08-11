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
      <div className="pointer-events-auto inline-flex w-full max-w-[680px] flex-col items-center gap-3 rounded-lg border border-accent/20 bg-surface-dark/92 px-4 py-3 text-center shadow-[var(--ui-shadow-panel)] sm:w-auto sm:flex-row sm:px-5">
        <p className="text-sm leading-6 text-text-muted sm:text-[15px]">
          {t('settings.missingAnyApiKeyMessage')}
        </p>
        <UiButton
          type="button"
          variant="primary"
          size="sm"
          className="shrink-0"
          onClick={() => openSettingsDialog({ category: 'providers' })}
        >
          {t('settings.openProvidersSettings')}
        </UiButton>
      </div>
    </div>
  );
}
