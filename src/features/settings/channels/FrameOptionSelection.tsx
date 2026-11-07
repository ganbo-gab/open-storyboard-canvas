import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiField, UiInput, UiSelect } from '@/components/ui';
import type { ParamSpec } from '@/features/channels/domain/profile';
import { sameParameterValue } from '@/features/channels/domain/parameterValue';
import { pixelSizeChoices } from '@/features/channels/ui/sizeParameterPresentation';
import { PixelSizeControl } from '@/features/channels/ui/PixelSizeControl';
import { PixelSizeCombinationEditor } from './PixelSizeCombinationEditor';
import { commonFrameOptions, mergeParameterOptions, setParameterOptionEnabled, type ParameterOption } from './parameterOptionSelection';
import './parameterQuickSetup.css';

const wireText = (option: ParameterOption) => typeof option.value === 'string' ? option.value : JSON.stringify(option.value);

/** Checkboxes edit the declared options only; each visible choice retains its exact API value. */
export function FrameOptionSelection({ param, onChange }: { param: ParamSpec; onChange(param: ParamSpec): void }) {
  const { t } = useTranslation();
  // Keep unchecked custom choices available during this editing session, so a click can be undone.
  const [parked, setParked] = useState<ParameterOption[]>(() => param.options ?? []);
  const [customValue, setCustomValue] = useState('');
  const [customLabel, setCustomLabel] = useState('');
  const options = param.options ?? [];
  const available = mergeParameterOptions(parked, options).map(entry => options.find(current => sameParameterValue(current.value, entry.value)) ?? entry);
  const common = commonFrameOptions(param);
  const paired = param.sizeDisplay === 'ratio-resolution';
  const sizes = pixelSizeChoices({ ...param, options: available });
  const has = (option: ParameterOption) => options.some(current => sameParameterValue(current.value, option.value));
  const toggle = (option: ParameterOption, enabled: boolean) => {
    setParked(current => mergeParameterOptions(current, [option]));
    onChange(setParameterOptionEnabled(param, option, enabled));
  };
  const label = (option: ParameterOption, onlyResolution = false): string => {
    const size = pixelSizeChoices({ ...param, options: [option] })[0];
    return paired && size ? (onlyResolution ? size.resolution : `${size.ratio} · ${size.resolution}`) : option.label;
  };
  const choice = (option: ParameterOption, onlyResolution = false) => {
    const checked = has(option), last = checked && options.length === 1;
    return <label key={JSON.stringify(option.value)} className="channel-frame-option" data-checked={checked || undefined} title={last ? t('ui.channels.frameOptions.keepOne') : undefined}>
      <input type="checkbox" checked={checked} disabled={last} aria-label={`${label(option)} (${wireText(option)})`} onChange={event => toggle(option, event.target.checked)} />
      <span className="min-w-0"><strong>{label(option, onlyResolution)}</strong>{wireText(option) !== label(option, onlyResolution) && <small>{wireText(option)}</small>}</span>
    </label>;
  };
  const defaultIndex = options.findIndex(option => sameParameterValue(option.value, param.default));
  const addCustom = () => {
    const value = customValue.trim();
    if (!value) return;
    const existing = available.find(option => sameParameterValue(option.value, value));
    toggle(existing ?? { label: customLabel.trim() || value, value }, true);
    setCustomValue(''); setCustomLabel('');
  };
  if (paired) return <div className="channel-frame-selection space-y-4">
    <p className="text-xs text-text-muted">{t('ui.channels.combinations.enabled', { count: sizes.filter(size => has(available[size.index])).length })}</p>
    <PixelSizeCombinationEditor key={JSON.stringify(param.options)} param={param} onChange={onChange} />
    {available.some((_, index) => !sizes.some(size => size.index === index)) && <fieldset className="space-y-2"><legend className="mb-2 text-xs font-medium">{t('ui.channels.frameOptions.special')}</legend>
      <div className="channel-frame-grid">{available.filter((_, index) => !sizes.some(size => size.index === index)).map(option => choice(option))}</div>
    </fieldset>}
    <div className="space-y-2 border-t border-line pt-3"><p className="text-xs font-medium">{t('ui.channels.frameOptions.default')}</p>
      <PixelSizeControl param={param} value={param.default} onChange={value => { const option = options.find(item => sameParameterValue(item.value, value)); if (option) onChange({ ...param, default: option.value }); }} />
    </div>
  </div>;
  return <div className="channel-frame-selection space-y-3">
    <p className="text-xs leading-5 text-text-muted">{t('ui.channels.frameOptions.selectionHint', { count: options.length })}</p>
    <div className="channel-frame-grid">{available.map(option => choice(option))}</div>
    {!options.length && <p role="status" className="text-xs text-warning">{t('ui.channels.frameOptions.empty')}</p>}
    <UiField label={t('ui.channels.frameOptions.default')}>
      <UiSelect aria-label={`${param.label} ${t('ui.channels.frameOptions.default')}`} value={String(defaultIndex)} onChange={event => onChange({ ...param, default: options[Number(event.target.value)]?.value })}>
        <option value="-1">{t('ui.channels.frameOptions.noDefault')}</option>
        {options.map((option, index) => <option key={index} value={String(index)}>{label(option)}{paired && pixelSizeChoices({ ...param, options: [option] }).length ? ` (${wireText(option)})` : ''}</option>)}
      </UiSelect>
    </UiField>
    {common.length > 0 && <details className="channel-frame-more">
      <summary>{t('ui.channels.frameOptions.more')}</summary>
      <p className="my-3 text-xs leading-5 text-text-muted">{t('ui.channels.frameOptions.candidatesHint')}</p>
      <div className="channel-frame-grid">{common.map(option => choice(options.find(current => sameParameterValue(current.value, option.value)) ?? option))}</div>
    </details>}
    <details className="channel-frame-more"><summary>{t('ui.channels.frameOptions.custom')}</summary>
      <div className="mt-3 space-y-3">
        <div className="channel-frame-custom"><UiField label={t('ui.channels.frameOptions.wireValue')}><UiInput aria-label={`${param.label} ${t('ui.channels.frameOptions.wireValue')}`} value={customValue} placeholder={t('ui.channels.frameOptions.valueExample')} onChange={event => setCustomValue(event.target.value)} /></UiField>
          <UiField label={t('ui.channels.frameOptions.label')}><UiInput aria-label={`${param.label} ${t('ui.channels.frameOptions.label')}`} value={customLabel} onChange={event => setCustomLabel(event.target.value)} /></UiField></div>
        <UiButton size="sm" icon={<Plus />} disabled={!customValue.trim()} onClick={addCustom}>{t('ui.channels.frameOptions.add')}</UiButton>
      </div>
    </details>
  </div>;
}
