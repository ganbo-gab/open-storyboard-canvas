import { useTranslation } from 'react-i18next';
import { UiSelect } from '@/components/ui';
import type { ParamSpec } from '../domain/profile';
import { pixelSizeChoices, sizeChoiceIndex } from './sizeParameterPresentation';

/** Two friendly selectors, one exact declared wire value; unsupported combinations never appear. */
export function PixelSizeControl({ param, value, onChange }: { param: ParamSpec; value: unknown; onChange(value: unknown): void }) {
  const { t } = useTranslation();
  const choices = pixelSizeChoices(param), index = sizeChoiceIndex(param, value);
  const selected = choices.find(choice => choice.index === index);
  const ratios = [...new Set(choices.map(choice => choice.ratio))];
  const resolutions = [...new Set(choices.map(choice => choice.resolution))];
  const choose = (nextIndex: number) => {
    const option = param.options?.[nextIndex];
    if (option) onChange(option.value);
  };
  const others = (param.options ?? []).map((option, i) => ({ ...option, index: i })).filter(option => !choices.some(choice => choice.index === option.index));
  return <div className="space-y-2">
    <div className="grid grid-cols-2 gap-3">
      <label className="space-y-1 text-xs text-text-muted"><span>{t('ui.channels.sizeGuide.resolution')}</span>
        <UiSelect aria-label={`${param.label} ${t('ui.channels.sizeGuide.resolution')}`} value={selected?.resolution ?? ''} onChange={event => {
          const same = choices.find(choice => choice.resolution === event.target.value && choice.ratio === selected?.ratio);
          choose((same ?? choices.find(choice => choice.resolution === event.target.value))?.index ?? -1);
        }}><option value="" disabled>—</option>{resolutions.map(resolution => <option key={resolution} value={resolution}>{resolution}</option>)}</UiSelect>
      </label>
      <label className="space-y-1 text-xs text-text-muted"><span>{t('ui.channels.sizeGuide.ratio')}</span>
        <UiSelect aria-label={`${param.label} ${t('ui.channels.sizeGuide.ratio')}`} value={selected?.ratio ?? ''} onChange={event => {
          const same = choices.find(choice => choice.ratio === event.target.value && choice.resolution === selected?.resolution);
          choose((same ?? choices.find(choice => choice.ratio === event.target.value))?.index ?? -1);
        }}><option value="" disabled>—</option>{ratios.map(ratio => <option key={ratio} value={ratio}>{ratio}</option>)}</UiSelect>
      </label>
    </div>
    {others.length > 0 && <div className="flex flex-wrap gap-2">{others.map(option => <button type="button" key={option.index} className="ui-tile px-3 py-1 text-xs" aria-pressed={index === option.index} onClick={() => choose(option.index)}>{option.label}</button>)}</div>}
    {selected && <p className="text-xs text-text-subtle">{t('ui.channels.sizeGuide.actualSize', { size: String(param.options?.[index]?.value ?? '') })}</p>}
  </div>;
}
