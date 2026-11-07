import { AlertTriangle, Braces, CheckCircle2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { UiButton, UiTextArea } from '@/components/ui';
import type { CustomImageProviderFieldIssue } from '@/features/canvas/application/customImageProviderConfig';

interface CustomImageProviderContractEditorProps {
  value: string;
  issues: CustomImageProviderFieldIssue[];
  generatedByAi?: boolean;
  onChange: (value: string) => void;
  onApply: () => void;
}

export function CustomImageProviderContractEditor({
  value,
  issues,
  generatedByAi = false,
  onChange,
  onApply,
}: CustomImageProviderContractEditorProps) {
  const { t } = useTranslation();
  const sections = [
    'basicRequest',
    'templates',
    'imageFields',
    'ratioMappings',
    'asyncResponse',
  ] as const;

  return (
    <details className="col-span-2 rounded-lg border border-accent/25 bg-accent/5 p-3">
      <summary className="cursor-pointer text-[11px] font-medium text-text-dark">
        <Braces className="mr-1.5 inline h-3.5 w-3.5 text-accent" />
        {t('settings.customProviders.contract.title')}
        <span className="ml-2 font-normal text-text-muted">
          {t('settings.customProviders.contract.subtitle')}
        </span>
      </summary>

      <div className="mt-3 space-y-3">
        {generatedByAi && (
          <div className="flex items-center gap-1.5 rounded-md border border-success/25 bg-success/8 px-2.5 py-2 text-[11px] text-success">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {t('settings.customProviders.contract.aiDraftNotice')}
          </div>
        )}

        <div className="grid gap-2 sm:grid-cols-5">
          {sections.map((section) => (
            <div key={section} className="rounded-md border border-[var(--line)] bg-bg px-2 py-2">
              <div className="text-[10px] font-medium text-text-dark">
                {t(`settings.customProviders.contract.sections.${section}.title`)}
              </div>
              <div className="mt-1 text-[9px] leading-4 text-text-muted">
                {t(`settings.customProviders.contract.sections.${section}.description`)}
              </div>
            </div>
          ))}
        </div>

        <UiTextArea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
          aria-invalid={issues.length > 0 || undefined}
          className={`ui-scrollbar h-80 resize-y font-mono text-[11px] leading-5 ${issues.length > 0 ? 'border-danger/45' : ''}`}
          aria-label={t('settings.customProviders.contract.editorLabel')}
        />

        {issues.length > 0 && (
          <div className="rounded-md border border-danger/25 bg-danger/8 p-2.5">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-danger">
              <AlertTriangle className="h-3.5 w-3.5" />
              {t('settings.customProviders.contract.validationTitle')}
            </div>
            <ul className="mt-1.5 space-y-1 text-[10px] leading-4 text-danger/90">
              {issues.slice(0, 10).map((entry, index) => (
                <li key={`${entry.path}-${index}`}>
                  <code className="font-medium text-danger">{entry.path}</code>: {entry.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 text-[10px] leading-4 text-text-muted">
          <span>{t('settings.customProviders.contract.securityHint')}</span>
          <UiButton type="button" variant="secondary" size="sm" onClick={onApply}>
            {t('settings.customProviders.contract.apply')}
          </UiButton>
        </div>
      </div>
    </details>
  );
}
