import { useTranslation } from 'react-i18next';
import { UiInput } from '@/components/ui';
import { RATIO_PARAM_KEYS, SIZE_PARAM_KEYS, type ParamSpec } from '@/features/channels/domain/profile';
import { configureSizeDisplay, pixelSizeChoices } from '@/features/channels/ui/sizeParameterPresentation';
import './parameterQuickSetup.css';

export function ParameterQuickSetup({ params, onChange }: { params: ParamSpec[]; onChange(params: ParamSpec[]): void }) {
  const { t } = useTranslation();
  const pixels = params.filter(param => SIZE_PARAM_KEYS.includes(param.key) && pixelSizeChoices(param).length > 0);
  const ratio = params.find(param => RATIO_PARAM_KEYS.includes(param.key));
  const resolution = params.find(param => SIZE_PARAM_KEYS.includes(param.key));
  if (!pixels.length && !ratio && !resolution) return null;
  const patch = (param: ParamSpec, next: ParamSpec) => onChange(params.map(item => item === param ? next : item));
  return <div className="channel-size-setup min-w-0 space-y-4 rounded-lg border border-line bg-surface p-4">
    <div><h5 className="text-sm font-medium">{t('ui.channels.sizeGuide.title')}</h5><p className="mt-1 text-xs leading-5 text-text-muted">{t('ui.channels.sizeGuide.hint')}</p></div>
    {pixels.map(param => <div key={param.key} className="space-y-3">
      <div role="group" aria-label={`${param.label} ${t('ui.channels.sizeGuide.title')}`} className="channel-size-choices">
        {(['pixels', 'ratio-resolution'] as const).map(mode => <button type="button" key={mode} className="ui-tile channel-size-choice" aria-pressed={(param.sizeDisplay ?? 'pixels') === mode}
          onClick={() => patch(param, configureSizeDisplay(param, mode))}>
          <strong className="block text-sm">{t(`ui.channels.sizeGuide.${mode}`)}</strong>
          <span className="block text-xs text-text-muted">{t(`ui.channels.sizeGuide.${mode}Example`)}</span>
        </button>)}
      </div>
      <p className="text-xs leading-5 text-text-muted">{t('ui.channels.sizeGuide.exactValues')}</p>
      {param.sizeDisplay === 'ratio-resolution' && <details className="text-xs">
        <summary className="cursor-pointer text-text-muted">{t('ui.channels.sizeGuide.mapping')}</summary>
        <p className="mt-2 leading-5 text-text-muted">{t('ui.channels.sizeGuide.mappingHint')}</p>
        <div className="mt-2 space-y-2">{pixelSizeChoices(param).map(choice => <div key={choice.index} className="channel-size-mapping-row">
          <code className="break-all text-text-muted">{String(param.options?.[choice.index]?.value)}</code>
          <UiInput aria-label={`${param.key} ${choice.index + 1} ${t('ui.channels.sizeGuide.ratio')}`} value={choice.ratio} onChange={event => patch(param, { ...param, options: param.options?.map((option, index) => index === choice.index ? { ...option, size: { ratio: event.target.value, resolution: choice.resolution } } : option) })} />
          <UiInput aria-label={`${param.key} ${choice.index + 1} ${t('ui.channels.sizeGuide.resolution')}`} value={choice.resolution} onChange={event => patch(param, { ...param, options: param.options?.map((option, index) => index === choice.index ? { ...option, size: { ratio: choice.ratio, resolution: event.target.value } } : option) })} />
        </div>)}</div>
      </details>}
    </div>)}
    {!pixels.length && <p className="text-xs leading-5 text-text-muted">{t('ui.channels.sizeGuide.nativePair', { ratio: ratio?.label ?? '—', resolution: resolution?.label ?? '—' })}</p>}
    <p className="text-xs leading-5 text-text-muted">{t('ui.channels.sizeGuide.next')}</p>
  </div>;
}
