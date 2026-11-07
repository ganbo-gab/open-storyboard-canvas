import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiCheckbox, UiIconButton, UiInput } from '@/components/ui';
import { SecretField } from '@/features/secrets/SecretField';
import type { ImageHostSettings } from '@/features/settings/imageHostSettings';
import { ImageHostConfigurationAssistant } from './ImageHostConfigurationAssistant';

export function ImageHostSection({ value, onChange }: { value: ImageHostSettings; onChange(value: ImageHostSettings): void }) {
  const { t } = useTranslation();
  const [headerError, setHeaderError] = useState('');
  const update = (patch: Partial<ImageHostSettings>) => onChange({ ...value, ...patch });
  const headers = Object.entries(value.extraHeaders);
  return <div className="mx-auto max-w-3xl space-y-5">
    <ImageHostConfigurationAssistant value={value} onChange={onChange} />
    {value.migrationNotice && <div role="status" className="rounded-lg border border-[var(--line)] bg-surface p-4 text-xs leading-5 text-text-muted">
      <p>{t(`settings.imageHosting.migration.${value.migrationNotice}`)}</p>
      {value.legacyDraft?.endpoint && <p className="mt-2 break-all">{t('settings.imageHosting.previousEndpoint')} <code>{value.legacyDraft.endpoint}</code></p>}
    </div>}
    <div className="space-y-4 rounded-xl border border-[var(--line)] bg-surface p-4">
      <label className="block text-xs font-medium text-text-muted">{t('settings.imageHosting.uploadUrl')}
        <UiInput value={value.uploadUrl} onChange={(event) => update({ uploadUrl: event.target.value })} className="mt-1 w-full" placeholder={t('settings.imageHosting.uploadUrlPlaceholder')} autoComplete="off" />
      </label>
      <p className="text-xs text-text-muted">{t('settings.imageHosting.uploadHelp')}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-xs font-medium text-text-muted">{t('settings.imageHosting.fileField')}
          <UiInput value={value.fileField} onChange={(event) => update({ fileField: event.target.value })} className="mt-1 w-full" placeholder="file" />
        </label>
        <label className="block text-xs font-medium text-text-muted">{t('settings.imageHosting.responseUrlPath')}
          <UiInput value={value.responseUrlPath} onChange={(event) => update({ responseUrlPath: event.target.value })} className="mt-1 w-full" placeholder="data.url" />
        </label>
      </div>
      <p className="text-xs leading-5 text-text-muted">{t('settings.imageHosting.responseHelp')}</p>
    </div>
    <div className="rounded-xl border border-[var(--line)] bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-text-dark">{t('settings.imageHosting.headers')}</h3>
        <UiButton size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => {
          let name = 'Authorization';
          for (let index = 1; Object.hasOwn(value.extraHeaders, name); index += 1) name = `X-Header-${index}`;
          update({ extraHeaders: { ...value.extraHeaders, [name]: '' } });
        }}>{t('settings.imageHosting.addHeader')}</UiButton>
      </div>
      <p className="mt-2 text-xs leading-5 text-text-muted">{t('settings.imageHosting.headersHelp')}</p>
      <div className="mt-3 space-y-3">{headers.map(([name, content], index) => <div key={index} className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]">
        <label className="text-xs text-text-muted">{t('settings.imageHosting.headerName')}
          <UiInput aria-label={`${t('settings.imageHosting.headerName')} ${index + 1}`} value={name} className="mt-1 w-full" onChange={(event) => {
            const nextName = event.target.value;
            if (headers.some(([other], at) => at !== index && other.toLowerCase() === nextName.toLowerCase())) { setHeaderError(t('settings.imageHosting.errors.duplicateHeader')); return; }
            setHeaderError('');
            update({ extraHeaders: Object.fromEntries(headers.map((entry, at) => at === index ? [nextName, content] : entry)) });
          }} />
        </label>
        <div className="col-span-2 col-start-1 row-start-2 text-xs text-text-muted sm:col-span-1 sm:col-start-auto sm:row-start-auto">{t('settings.imageHosting.headerValue')}
          <SecretField label={`${t('settings.imageHosting.headerValue')} ${index + 1}`} value={content} onChange={(next) => update({ extraHeaders: { ...value.extraHeaders, [name]: next } })} className="mt-1" placeholder="Bearer …" />
        </div>
        <UiIconButton aria-label={`${t('settings.imageHosting.removeHeader')} ${index + 1}`} title={t('settings.imageHosting.removeHeader')} onClick={() => { setHeaderError(''); update({ extraHeaders: Object.fromEntries(headers.filter((_entry, at) => at !== index)) }); }}><Trash2 className="h-4 w-4" /></UiIconButton>
      </div>)}</div>
      {headerError && <p role="alert" className="mt-2 text-xs text-danger">{headerError}</p>}
    </div>
    <label className="flex items-start gap-3 rounded-xl border border-[var(--line)] bg-surface p-4">
      <UiCheckbox aria-label={t('settings.imageHosting.enable')} checked={value.enabled} onCheckedChange={(enabled) => update({ enabled, ...(enabled ? { migrationNotice: undefined } : {}) })} className="mt-0.5 shrink-0" />
      <span><span className="block text-sm font-medium text-text-dark">{t('settings.imageHosting.enable')}</span><span className="mt-1 block text-xs leading-5 text-text-muted">{t('settings.imageHosting.enableDesc')}</span></span>
    </label>
  </div>;
}
