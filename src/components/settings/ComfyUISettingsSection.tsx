import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ComfyWorkflowManager } from './ComfyWorkflowManager';
import { UiButton } from '@/components/ui';
import { useCustomProvidersStore } from '@/stores/customProvidersStore';
import { CustomImageProviderWorkbench } from './CustomImageProviderWorkbench';

export function ComfyUISettingsSection() {
  const { t } = useTranslation();
  const providers = useCustomProvidersStore((state) => state.providers).filter((provider) => provider.apiStyle === 'comfyui');
  const setPendingEditId = useCustomProvidersStore((state) => state.setPendingEditId);
  const [editorKey, setEditorKey] = useState(0);

  const startNew = () => {
    setPendingEditId(null);
    setEditorKey((value) => value + 1);
  };
  const startEdit = (id: string) => {
    setPendingEditId(id);
    setEditorKey((value) => value + 1);
  };

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--line)] px-6 py-5">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-text-dark">ComfyUI</h2>
          <p className="mt-1 max-w-2xl text-[13px] text-text-muted">{t('settings.comfyui.description')}</p>
        </div>
        {providers.length > 0 && (
          <UiButton variant="secondary" icon={<Plus />} onClick={startNew}>
            {t('settings.comfyui.newConnection')}
          </UiButton>
        )}
      </div>

      <div className="ui-scrollbar flex-1 space-y-4 overflow-y-auto p-6">
        {providers.length > 0 && (
          <section aria-label={t('settings.comfyui.savedConnections')} className="space-y-2">
            <h3 className="text-[13px] font-semibold text-text-dark">{t('settings.comfyui.savedConnections')}</h3>
            <div className="grid gap-4">
              {providers.map((provider) => (
                <ComfyWorkflowManager key={provider.id} provider={provider} onEdit={() => startEdit(provider.id)} />
              ))}
            </div>
          </section>
        )}
        <CustomImageProviderWorkbench key={editorKey} initialRoute="comfyui" />
      </div>
    </>
  );
}
