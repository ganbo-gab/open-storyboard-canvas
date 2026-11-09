import { useRef, useState } from 'react';
import { ChevronDown, Layers, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PopoverSurface, anchorAbove, type MenuAnchor } from '@/components/ui';
import { modeParamDefaults, retainModeState } from '@/features/channels/application/modelModes';
import { ComposerParameterPanel } from '@/features/workbench/ui/ComposerParameterPanel';
import { parameterSummary } from '@/features/channels/ui/parameterPresentation';
import { useCanvasStore } from '@/stores/canvasStore';
import type { ModelConfigValue } from '@/features/canvas/ui/ModelConfigPicker';
import { ChannelModeSections } from './ChannelModeSections';
import { useNativeImageMode } from './useNativeImageMode';

export function NativeImageControls({ nodeId, value, onChange }: { nodeId: string; value: ModelConfigValue; onChange(value: ModelConfigValue): void }) {
  const { t } = useTranslation();
  const updateNodeData = useCanvasStore(state => state.updateNodeData);
  const resolved = useNativeImageMode(nodeId, value);
  const trigger = useRef<HTMLButtonElement>(null);
  const [panel, setPanel] = useState<{ kind: 'mode' | 'params'; anchor: MenuAnchor } | null>(null);
  if (!resolved) return null;
  const { native, requested, slots, count, active, modes, params, references, error } = resolved;
  const auto = requested === undefined;
  const modeLabel = native.model.modes ? active.mode.label : count && native.model.operations.includes('image.edit') ? t('ui.channels.autoImage.edit') : t('ui.channels.autoImage.generate');
  const open = (kind: 'mode' | 'params', element: HTMLElement) => setPanel(current => current?.kind === kind ? null : { kind, anchor: anchorAbove(element) });
  const choose = (id: string | undefined) => {
    if (id !== undefined && id === requested) { setPanel(null); return; }
    // A manual mode keeps its explicit reference choices; switching to auto reads current graph inputs.
    const next = id === undefined ? undefined : modes.find(mode => mode.mode.id === id);
    const kept = next ? retainModeState(next, value.extraParams ?? {}, slots ?? {}) : undefined;
    updateNodeData(nodeId, { channelModeId: id, referenceSlots: id !== undefined && requested !== undefined && slots !== undefined ? kept?.slots : undefined,
      modelConfig: { ...value, extraParams: kept ? { ...modeParamDefaults(next!), ...kept.params } : value.extraParams } });
    setPanel(null);
  };
  return <>
    <button type="button" className="composer-chip" onClick={event => open('mode', event.currentTarget)} title={error || t('ui.channels.autoImage.hint')}><Layers /><span className="composer-chip__text">{error ? t('ui.channels.autoImage.choose') : `${auto ? `${t('ui.channels.autoImage.auto')} · ` : ''}${modeLabel}`}</span><ChevronDown /></button>
    <button ref={trigger} type="button" className="composer-chip" title={parameterSummary(active.params, params).join(' · ') || t('ui.workbench.parameters')} onClick={event => open('params', event.currentTarget)}><SlidersHorizontal /><span className="composer-chip__text">{parameterSummary(active.params, params).join(' · ') || t('ui.workbench.parameters')}</span><ChevronDown /></button>
    {panel && <PopoverSurface anchor={panel.anchor} width={420} label={t(panel.kind === 'mode' ? 'channelModes.mode' : 'ui.workbench.parameters')} onClose={() => setPanel(null)}>
      {panel.kind === 'params' ? <ComposerParameterPanel params={active.params} values={params} onChange={extraParams => onChange({ ...value, extraParams })} /> : <>
        <button type="button" className="ui-menu__item" onClick={() => choose(undefined)}>{t('ui.channels.autoImage.auto')}</button>
        <p className="my-2 text-xs leading-5 text-text-muted">{t('ui.channels.autoImage.hint')}</p>
        {native.model.modes && modes.map(mode => <button type="button" className="ui-menu__item" key={mode.mode.id} onClick={() => choose(mode.mode.id)}>{mode.mode.label}</button>)}
        {!auto && <ChannelModeSections modes={[active]} active={active} slots={slots ?? {}} references={references.all} onModeChange={mode => choose(mode.mode.id)} onSlotsChange={referenceSlots => updateNodeData(nodeId, { referenceSlots })} />}
        {error && <p role="alert" className="mt-2 text-xs text-warning">{error}</p>}
      </>}
    </PopoverSurface>}
  </>;
}
