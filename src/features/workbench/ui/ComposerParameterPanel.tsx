import { useTranslation } from 'react-i18next';
import { UiField, UiInput, UiSelect, UiSlider } from '@/components/ui';
import { DeclaredParameters } from '@/features/channels/ui/DeclaredParameters';
import { numericParameterOptions, parameterLabel, sameParameterValue, parameterDisplayName, parameterIsAdvanced } from '@/features/channels/ui/parameterPresentation';
import type { ParamSpec } from '@/features/channels/domain/profile';
import { PixelSizeControl } from '@/features/channels/ui/PixelSizeControl';
import { pixelSizeChoices } from '@/features/channels/ui/sizeParameterPresentation';

export function ComposerParameterPanel({ params, values, onChange }: { params: ParamSpec[]; values: Record<string, unknown>; onChange(values: Record<string, unknown>): void }) {
  const { t } = useTranslation();
  const visual = params.filter((param) => param.display !== 'hidden' && !parameterIsAdvanced(param) && (param.type === 'enum' || (param.type === 'number' && param.min !== undefined && param.max !== undefined)));
  const change = (key: string, value: unknown) => { const next = { ...values }; if (value === undefined) delete next[key]; else next[key] = value; onChange(next); };
  return <div className="space-y-5">
    {visual.map((param) => {
      const value = values[param.key] ?? param.default;
      const options = param.options ?? [];
      const numeric = param.display === 'select' || param.display === 'buttons' ? null : numericParameterOptions(param);
      const selected = options.findIndex((option) => sameParameterValue(option.value, value));
      return <UiField key={param.key} label={`${parameterDisplayName(param)}${param.required ? ' *' : ''}`} hint={param.description}
        trailing={Object.hasOwn(values, param.key) ? <button type="button" className="text-xs text-text-muted hover:text-text" onClick={() => change(param.key, undefined)}>{t('ui.workbench.default')}</button> : null}>
        {param.sizeDisplay === 'ratio-resolution' && pixelSizeChoices(param).length > 0
          ? <PixelSizeControl param={param} value={value} onChange={next => change(param.key, next)} />
          : numeric ? <div className="flex items-center gap-3">
          <UiSlider aria-label={param.label} min={0} max={numeric.length - 1} step={1} value={Math.max(0, selected)} onChange={(index) => change(param.key, options[index].value)} className="min-w-0 flex-1" />
          <div className="w-24 shrink-0"><UiSelect aria-label={`${param.label} ${t('ui.workbench.preciseValue')}`} value={String(selected)} onChange={(event) => change(param.key, options[Number(event.target.value)]?.value)}>
            <option value="-1">—</option>{options.map((option, index) => <option key={index} value={index}>{option.label}</option>)}
          </UiSelect></div>
        </div> : param.type === 'enum' ? (param.display === 'buttons' || (param.display !== 'select' && options.length <= 8)) ? <div className="grid grid-cols-[repeat(auto-fit,minmax(96px,1fr))] gap-2">
          {options.map((option, index) => <button key={index} type="button" className="ui-tile min-h-9 whitespace-normal px-2" aria-pressed={selected === index} onClick={() => change(param.key, option.value)}>{option.label}</button>)}
        </div> : <UiSelect aria-label={param.label} value={String(selected)} onChange={(event) => change(param.key, options[Number(event.target.value)]?.value)}>
          <option value="-1">—</option>{options.map((option, index) => <option key={index} value={index}>{option.label}</option>)}
        </UiSelect> : <div className="flex items-center gap-3">
          <UiSlider aria-label={param.label} min={param.min} max={param.max} step={param.step ?? 1} value={typeof value === 'number' ? value : param.min ?? 0} onChange={(next) => change(param.key, next)} className="min-w-0 flex-1" />
          <UiInput type="number" aria-label={`${param.label} ${t('ui.workbench.preciseValue')}`} className="w-24 shrink-0" min={param.min} max={param.max} step={param.step ?? 1} value={parameterLabel(param, value)} onChange={(event) => change(param.key, event.target.value === '' ? undefined : Number(event.target.value))} />
        </div>}
      </UiField>;
    })}
    <DeclaredParameters params={params.filter((param) => !visual.includes(param))} values={values} onChange={onChange} />
    {!params.length && <p className="text-sm text-text-muted">{t('ui.workbench.noParameters')}</p>}
  </div>;
}
