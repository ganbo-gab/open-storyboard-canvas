import { useTranslation } from 'react-i18next';
import { UiField, UiSelect, UiSegmented } from '@/components/ui';
import {
  DEFAULT_CANVAS_MOUSE_BINDINGS, TRADITIONAL_CANVAS_MOUSE_BINDINGS,
  canvasMouseBindingsSchema, canvasMouseClickActionSchema, canvasMouseDragActionSchema,
  canvasMousePreset, type CanvasMouseBindings, type CanvasMouseBindingSlot, type CanvasWheelMode,
} from './canvasMouseSettings';

const BUTTON_ROWS = [
  { key: 'left', slots: ['leftClick', 'leftDoubleClick', 'leftDrag'] },
  { key: 'middle', slots: ['middleClick', 'middleDoubleClick', 'middleDrag'] },
  { key: 'right', slots: ['rightClick', 'rightDoubleClick', 'rightDrag'] },
] as const;

export function CanvasMouseSettingsSection({ bindings, wheelMode, onBindingsChange, onWheelModeChange }: {
  bindings: CanvasMouseBindings;
  wheelMode: CanvasWheelMode;
  onBindingsChange(bindings: CanvasMouseBindings): void;
  onWheelModeChange(mode: CanvasWheelMode): void;
}) {
  const { t } = useTranslation();
  const update = (slot: CanvasMouseBindingSlot, value: string) => onBindingsChange(canvasMouseBindingsSchema.parse({ ...bindings, [slot]: value }));
  return <div className="mb-4 space-y-4">
    <UiField label={t('settings.canvasInteraction.preset')} hint={t('settings.canvasInteraction.presetHelp')}>
      <UiSelect aria-label={t('settings.canvasInteraction.preset')} value={canvasMousePreset(bindings)} onChange={(event) => {
        if (event.target.value === 'default') onBindingsChange({ ...DEFAULT_CANVAS_MOUSE_BINDINGS });
        else if (event.target.value === 'traditional') onBindingsChange({ ...TRADITIONAL_CANVAS_MOUSE_BINDINGS });
      }}>
        <option value="default">{t('settings.canvasInteraction.presets.default')}</option>
        <option value="traditional">{t('settings.canvasInteraction.presets.traditional')}</option>
        <option value="custom" disabled>{t('settings.canvasInteraction.presets.custom')}</option>
      </UiSelect>
    </UiField>
    <p className="text-xs leading-5 text-text-muted">{t('settings.canvasInteraction.scope')}</p>
    <div className="overflow-x-auto rounded-lg border border-[var(--line)]">
      <table className="w-full min-w-[500px] table-fixed border-collapse text-left text-xs">
        <thead className="bg-elevated text-text-muted"><tr>
          <th className="w-20 px-3 py-3 font-medium">{t('settings.canvasInteraction.button')}</th>
          {(['click', 'doubleClick', 'drag'] as const).map((kind) => <th key={kind} className="px-3 py-3 font-medium">{t(`settings.canvasInteraction.events.${kind}`)}</th>)}
        </tr></thead>
        <tbody>{BUTTON_ROWS.map((row) => <tr key={row.key} className="border-t border-[var(--line)]">
          <th scope="row" className="px-3 py-4 font-medium text-text-dark">{t(`settings.canvasInteraction.buttons.${row.key}`)}</th>
          {row.slots.map((slot, index) => <td key={slot} className="px-3 py-4">
            <UiSelect className="w-full" aria-label={t(`settings.canvasInteraction.slots.${slot}`)} value={bindings[slot]} onChange={(event) => update(slot, event.target.value)}>
              {(index === 2 ? canvasMouseDragActionSchema.options : canvasMouseClickActionSchema.options).map((action) => <option key={action} value={action}>{t(`settings.canvasInteraction.actions.${action}`)}</option>)}
            </UiSelect>
          </td>)}
        </tr>)}</tbody>
      </table>
    </div>
    <UiField label={t('settings.canvasInteraction.wheel')} hint={t('settings.canvasInteraction.wheelAutoHelp')}>
      <UiSegmented<CanvasWheelMode> value={wheelMode} options={(['auto', 'zoom', 'pan'] as const).map((value) => ({ value, label: t(`settings.canvasInteraction.wheelOptions.${value}`) }))}
        onChange={onWheelModeChange} aria-label={t('settings.canvasInteraction.wheel')} size="sm" />
    </UiField>
    <div className="rounded-lg border border-[var(--line)] bg-elevated p-3">
      <h4 className="mb-2 text-xs font-medium text-text-dark">{t('settings.canvasInteraction.gesturesTitle')}</h4>
      <ul className="list-inside list-disc space-y-1 text-xs leading-5 text-text-muted">
        {(['spacePan', 'shiftSelect', 'trackpad', 'modifierZoom', 'tools'] as const).map((gesture) => <li key={gesture}>{t(`settings.canvasInteraction.gestures.${gesture}`)}</li>)}
      </ul>
    </div>
  </div>;
}
