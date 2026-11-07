import { useRef, useState } from 'react';
import { AudioLines, ChevronDown, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PopoverSurface, anchorAbove, type MenuAnchor } from '@/components/ui';
import type { ChannelAudioModelEntry } from '@/features/channels/application/audioModelCatalog';
import { retainModeState, type ResolvedMode } from '@/features/channels/application/modelModes';
import { DeclaredParameters } from '@/features/channels/ui/DeclaredParameters';
import { ChannelModeSections, declaredChannelModes } from './ChannelModeSections';
import { ModelPickerChip } from './ModelPicker';
import type { ComposerReference } from './useNodeReferences';

export interface AudioChannelState {
  entry: ChannelAudioModelEntry;
  mode: ResolvedMode;
  params: Record<string, unknown>;
  slots: Record<string, string[]>;
  references: readonly ComposerReference[];
  onChange(patch: { channelModeId?: string; referenceSlots?: Record<string, string[]>; audioGenerationParams?: Record<string, unknown> }): void;
}

/** Audio uses the same channel declarations, modes, slots and parameters as the workbench. */
export function AudioModelControls({ selectedModelId, channelCatalog, channel, onPickChannelModel }: {
  selectedModelId?: string | null;
  channelCatalog: readonly ChannelAudioModelEntry[];
  channel: AudioChannelState | null;
  onPickChannelModel(entry: ChannelAudioModelEntry): void;
}) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const modes = channel ? declaredChannelModes(channel.entry.modes) : null;
  const hasSettings = Boolean(channel && (modes || channel.mode.params.length || channel.mode.slots.length));
  return <>
    <ModelPickerChip icon={<AudioLines />} options={channelCatalog.map((entry) => ({ id: entry.id, group: entry.providerLabel, label: entry.modelLabel, usable: entry.usable, hint: entry.notReadyReason }))}
      value={channel?.entry.id ?? selectedModelId ?? null} onChange={(id) => { const entry = channelCatalog.find((candidate) => candidate.id === id); if (entry?.usable) onPickChannelModel(entry); }}
      settingsCategory="providers" emptyLabel={t('rework.canvas.composer.addChannel')} manageLabel={t('rework.canvas.composer.manageAudioModels')} />
    {channel && hasSettings ? <button ref={triggerRef} type="button" className="composer-chip" aria-haspopup="dialog" aria-expanded={Boolean(anchor)} onClick={() => setAnchor(anchor ? null : anchorAbove(triggerRef.current!))}>
      <SlidersHorizontal /><span className="composer-chip__text">{modes && modes.length > 1 ? channel.mode.mode.label : t('rework.canvas.composer.settings')}</span><ChevronDown />
    </button> : null}
    {anchor && channel ? <PopoverSurface anchor={anchor} width={modes ? 380 : 320} label={t('rework.canvas.composer.settings')} onClose={() => setAnchor(null)}>
      {modes ? <ChannelModeSections modes={modes} active={channel.mode} slots={channel.slots} references={channel.references}
        onModeChange={(mode) => { const kept = retainModeState(mode, channel.params, channel.slots); channel.onChange({ channelModeId: mode.mode.id, referenceSlots: kept.slots, audioGenerationParams: kept.params }); }}
        onSlotsChange={(referenceSlots) => channel.onChange({ referenceSlots })} /> : null}
      {channel.mode.params.length ? <section className="ui-popover__section"><DeclaredParameters params={channel.mode.params} values={channel.params} onChange={(audioGenerationParams) => channel.onChange({ audioGenerationParams })} /></section> : null}
    </PopoverSurface> : null}
  </>;
}
