import { Bot, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { UiButton } from '@/components/ui/primitives';
import type { CustomImageProviderCreationRoute } from './customImageProviderWorkbenchState';

interface CustomImageProviderCreationChoiceProps {
  onChoose: (route: CustomImageProviderCreationRoute) => void;
}

export function CustomImageProviderCreationChoice({ onChoose }: CustomImageProviderCreationChoiceProps) {
  const { t } = useTranslation();

  return (
    <section className="mx-auto max-w-3xl py-3">
      <div className="mb-5">
        <h3 className="text-sm font-semibold text-text-dark">
          {t('settings.customProviders.workbench.chooseTitle')}
        </h3>
        <p className="mt-1 text-xs leading-5 text-text-muted">
          {t('settings.customProviders.workbench.chooseDescription')}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <UiButton
          type="button"
          variant="muted"
          className="h-auto min-h-36 items-start justify-start border border-border-dark bg-surface-dark p-4 text-left hover:border-accent/45"
          onClick={() => onChoose('ai')}
        >
          <Bot className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
          <span className="ml-3 block">
            <span className="block text-sm font-semibold text-text-dark">
              {t('settings.customProviders.workbench.aiRouteTitle')}
            </span>
            <span className="mt-1.5 block text-xs font-normal leading-5 text-text-muted">
              {t('settings.customProviders.workbench.aiRouteDescription')}
            </span>
          </span>
        </UiButton>

        <UiButton
          type="button"
          variant="muted"
          className="h-auto min-h-36 items-start justify-start border border-border-dark bg-surface-dark p-4 text-left hover:border-accent/45"
          onClick={() => onChoose('manual')}
        >
          <SlidersHorizontal className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
          <span className="ml-3 block">
            <span className="block text-sm font-semibold text-text-dark">
              {t('settings.customProviders.workbench.manualRouteTitle')}
            </span>
            <span className="mt-1.5 block text-xs font-normal leading-5 text-text-muted">
              {t('settings.customProviders.workbench.manualRouteDescription')}
            </span>
          </span>
        </UiButton>

      </div>
    </section>
  );
}
