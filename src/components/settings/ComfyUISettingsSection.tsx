import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

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
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3 pr-10">
        <div>
          <h2 className="text-base font-semibold text-text-dark">ComfyUI</h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-text-muted">{t('settings.comfyui.description')}</p>
        </div>
        {providers.length > 0 && <button type="button" onClick={startNew} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border-dark bg-bg-dark px-3 text-xs font-medium text-text-dark hover:border-accent/45 focus:outline-none focus:ring-2 focus:ring-accent/60">
          <Plus className="h-3.5 w-3.5" />{t('settings.comfyui.newConnection')}
        </button>}
      </div>
      {providers.length > 0 && (
        <section aria-label={t('settings.comfyui.savedConnections')} className="space-y-2">
          <h3 className="text-xs font-semibold text-text-dark">{t('settings.comfyui.savedConnections')}</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {providers.map((provider) => (
              <div key={provider.id} className="flex min-w-0 items-center gap-3 rounded-lg border border-border-dark bg-bg-dark/50 p-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-text-dark">{provider.label}</div>
                  <div className="mt-1 truncate text-[11px] text-text-muted">{provider.baseUrl}</div>
                </div>
                <span className="rounded border border-border-dark px-1.5 py-0.5 text-[10px] text-text-muted">{t(provider.mediaType === 'video' ? 'settings.customProviders.workbench.comfyOutputVideo' : 'settings.customProviders.workbench.comfyOutputImage')}</span>
                <button type="button" onClick={() => startEdit(provider.id)} className="rounded-md px-2 py-1.5 text-xs text-accent hover:bg-accent/10 focus:outline-none focus:ring-2 focus:ring-accent/60">{t('settings.comfyui.edit')}</button>
              </div>
            ))}
          </div>
        </section>
      )}
      <CustomImageProviderWorkbench key={editorKey} initialRoute="comfyui" />
    </div>
  );
}
