import { useRef, useState } from 'react';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { PopoverSurface, anchorAbove, type MenuAnchor } from '@/components/ui';
import type { DreaminaTransitionSegment } from '@/features/canvas/application/dreaminaCapabilities';
import type { VideoInputSchema } from '@/features/canvas/application/videoInputSchema';
import type { VideoCatalogEntry, VideoModelConfigValue } from '@/features/canvas/application/videoModelCatalog';
import { retainModeState, type ResolvedMode } from '@/features/channels/application/modelModes';
import { RATIO_PARAM_KEYS, SIZE_PARAM_KEYS } from '@/features/channels/domain/profile';
import { DeclaredParameters } from '@/features/channels/ui/DeclaredParameters';
import { DreaminaMultiframeEditor } from '@/features/canvas/ui/DreaminaMultiframeEditor';
import { ModelPickerChip } from './ModelPicker';
import { ChannelModeSections, ChoiceTiles, declaredChannelModes } from './ChannelModeSections';
import type { ComposerReference } from './useNodeReferences';

/** Channel mode state stored on the node (top-level `channelModeId` / `referenceSlots`). */
export interface VideoChannelModeState {
  modeId?: string;
  slots: Record<string, string[]>;
  /** Upstream references the user can assign to slots. */
  references: readonly ComposerReference[];
  /** `config` patches the node's model config (mode switches move chip values / extra params to what the mode declares). */
  onChange(patch: { channelModeId?: string; referenceSlots?: Record<string, string[]>; config?: Partial<VideoModelConfigValue> }): void;
}

/** Canvas chips already cover duration / size / ratio; the declared panel shows the rest. */
const CHIP_FIELD_KEYS = {
  duration: ['seconds', 'duration'],
  resolution: SIZE_PARAM_KEYS,
  aspectRatio: RATIO_PARAM_KEYS,
} as const satisfies Record<string, readonly string[]>;
type ChipField = keyof typeof CHIP_FIELD_KEYS;
const CHIP_FIELDS = Object.keys(CHIP_FIELD_KEYS) as ChipField[];
const CHIP_PARAM_KEYS = new Set<string>(CHIP_FIELDS.flatMap((field) => CHIP_FIELD_KEYS[field]));

interface ChipChoices {
  /** Scalar wire values, as stored in the node config. */
  options: string[];
  labels: Map<string, string>;
  fallback: string | undefined;
}

/** What one declared mode allows for a chip field; null when the mode does not declare it (nothing is sent). */
function modeChipChoices(mode: ResolvedMode, field: ChipField): ChipChoices | null {
  const keys: readonly string[] = CHIP_FIELD_KEYS[field];
  const param = mode.params.find((entry) => keys.includes(entry.key));
  if (!param) return null;
  const scalar = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : undefined);
  const labels = new Map<string, string>();
  const options = (param.options ?? []).flatMap((option) => {
    const value = scalar(option.value);
    if (value === undefined) return [];
    labels.set(value, option.label);
    return [value];
  });
  const declaredDefault = scalar(param.default);
  if (!options.length && declaredDefault !== undefined) options.push(declaredDefault);
  return { options, labels, fallback: declaredDefault !== undefined && options.includes(declaredDefault) ? declaredDefault : options[0] };
}

/** Keeps chip values the mode still allows; everything else moves to that mode's declared default. */
function coerceToMode(value: VideoModelConfigValue, mode: ResolvedMode): Partial<VideoModelConfigValue> {
  const next: Partial<VideoModelConfigValue> = {};
  for (const field of CHIP_FIELDS) {
    const choices = modeChipChoices(mode, field);
    const current = value[field];
    if (choices?.fallback !== undefined && (current === undefined || !choices.options.includes(current))) next[field] = choices.fallback;
  }
  return next;
}

export const DREAMINA_MULTIFRAME_ENTRY_ID = 'dreamina:multi-frame-video';

function defaultDuration(entry: VideoCatalogEntry): string {
  if (entry.providerId === 'agnes' && entry.supportedDurations.includes('5')) return '5';
  return entry.supportedDurations[0] ?? '4';
}

/** Switching models keeps every setting the new model also supports (channel lists start with the declared default). */
export function pickVideoModelConfig(entry: VideoCatalogEntry, current: VideoModelConfigValue | undefined): VideoModelConfigValue {
  const keep = (value: string | undefined, supported: string[], fallback: string) =>
    value && supported.includes(value) ? value : supported[0] ?? fallback;
  return {
    entryId: entry.id,
    duration: current?.duration && entry.supportedDurations.includes(current.duration) ? current.duration : defaultDuration(entry),
    resolution: keep(current?.resolution, entry.supportedResolutions, '1280x720'),
    aspectRatio: keep(current?.aspectRatio, entry.supportedAspectRatios, '16:9'),
    extraParams: { ...(entry.defaultExtraParams ?? {}) },
  };
}

/** Only channel models that declare their own modes get the mode / slot UI. */
function channelModes(entry: VideoCatalogEntry | undefined): readonly ResolvedMode[] | null {
  return entry?.channelModelRef ? declaredChannelModes(entry.modes) : null;
}

function activeChannelMode(entry: VideoCatalogEntry | undefined, modeId: string | undefined): ResolvedMode | null {
  const modes = channelModes(entry);
  return modes ? modes.find((mode) => mode.mode.id === modeId) ?? modes[0] : null;
}

function videoDurationLabel(choices: ChipChoices | null, duration: string, workflow: string): string {
  return choices?.labels.get(duration) ?? (duration === 'workflow' ? workflow : `${duration}s`);
}

/** Node-header duration text: the declared option label (e.g. "智能选择") when the active mode names it. */
export function describeVideoDuration(entry: VideoCatalogEntry | undefined, modeId: string | undefined, duration: string, workflow: string): string {
  const mode = activeChannelMode(entry, modeId);
  return videoDurationLabel(mode ? modeChipChoices(mode, 'duration') : null, duration, workflow);
}

function isAgnesKeyframes(extra: Record<string, unknown> | undefined): boolean {
  const raw = extra?.agnesVideoMode ?? extra?.videoMode ?? extra?.mode;
  return typeof raw === 'string' && raw.toLowerCase() === 'keyframes';
}

function describeInputs(schema: VideoInputSchema): string {
  const parts: string[] = [];
  if (schema.images.enabled && schema.images.max > 0) {
    parts.push(`图 ${schema.images.min}-${schema.images.max}${schema.images.requireImageHost ? ' (URL)' : ''}`);
  }
  if (schema.video.enabled) parts.push(`视频 ${schema.video.min}-${schema.video.max}`);
  if (schema.audio.enabled) parts.push(`音频 ${schema.audio.min}-${schema.audio.max}`);
  return parts.join(' · ');
}

/**
 * Model + "5s · 720p · 16:9" chips for the video generator. Rarely touched controls
 * (input mode, keyframes, multi-frame transitions) appear only for models that have them.
 */
export function VideoModelControls({
  catalog,
  value,
  imageCount,
  onChange,
  channel,
}: {
  catalog: readonly VideoCatalogEntry[];
  /** Resolved config (stored value, or the first usable model). */
  value: VideoModelConfigValue | undefined;
  /** Image references connected and accepted by the model. */
  imageCount: number;
  onChange(next: VideoModelConfigValue): void;
  channel?: VideoChannelModeState;
}) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const entry = catalog.find((candidate) => candidate.id === value?.entryId);
  const workflow = t('node.aiVideo.workflow');
  const extra = value?.extraParams ?? {};
  const isAgnes = entry?.providerId === 'agnes';
  const multiframe = entry?.id === DREAMINA_MULTIFRAME_ENTRY_ID && imageCount >= 3;
  const modes = channelModes(entry);
  const activeMode = activeChannelMode(entry, channel?.modeId);
  const declaredParams = activeMode?.params.filter((param) => !CHIP_PARAM_KEYS.has(param.key)) ?? [];
  // Mode channels: undefined → not a mode model (catalog lists), null → this mode does not declare the field.
  const chipChoices = (field: ChipField) => (activeMode ? modeChipChoices(activeMode, field) : undefined);
  const durationChoices = chipChoices('duration');
  const resolutionChoices = chipChoices('resolution');
  const ratioChoices = chipChoices('aspectRatio');
  const durationLabel = (option: string) => videoDurationLabel(durationChoices ?? null, option, workflow);
  const resolutionLabel = (option: string) => resolutionChoices?.labels.get(option) ?? (option === 'workflow' ? workflow : option);
  const ratioLabel = (option: string) => ratioChoices?.labels.get(option) ?? option;

  const patch = (next: Partial<VideoModelConfigValue>) => {
    if (value) onChange({ ...value, ...next });
  };
  const patchExtra = (mutate: (next: Record<string, unknown>) => void) => {
    const next = { ...extra };
    mutate(next);
    patch({ extraParams: next });
  };

  const summary = !value
    ? ''
    : multiframe
      ? t('node.aiVideo.multiframeSummary', { count: imageCount - 1, resolution: value.resolution })
      : [
        durationChoices !== null ? durationLabel(value.duration) : '',
        resolutionChoices !== null ? resolutionLabel(value.resolution) : '',
        ratioChoices !== null && value.aspectRatio ? ratioLabel(value.aspectRatio) : '',
      ].filter(Boolean).join(' · ');
  const chipSummary = activeMode && modes && modes.length > 1 ? `${activeMode.mode.label} · ${summary}` : summary;
  const inputs = entry ? describeInputs(entry.inputSchema) : '';

  return (
    <>
      <ModelPickerChip
        options={catalog.map((candidate) => ({
          id: candidate.id,
          group: candidate.providerLabel,
          label: candidate.modelLabel,
          usable: candidate.usable,
          hint: candidate.notReadyReason,
        }))}
        value={value?.entryId ?? null}
        onChange={(id) => {
          const picked = catalog.find((candidate) => candidate.id === id);
          if (picked?.usable) onChange(pickVideoModelConfig(picked, value));
        }}
      />
      {entry && value ? (
        <button
          ref={triggerRef}
          type="button"
          className="composer-chip"
          aria-haspopup="dialog"
          aria-expanded={Boolean(anchor)}
          onClick={() => setAnchor(anchor ? null : anchorAbove(triggerRef.current!))}
        >
          <SlidersHorizontal />
          <span className="composer-chip__text">{chipSummary}</span>
          <ChevronDown />
        </button>
      ) : null}
      {anchor && entry && value ? (
        <PopoverSurface anchor={anchor} width={multiframe || modes ? 380 : 300} label={t('rework.canvas.composer.settings')} onClose={() => setAnchor(null)}>
          {modes && activeMode && channel ? (
            <ChannelModeSections
              modes={modes}
              active={activeMode}
              slots={channel.slots}
              references={channel.references}
              onModeChange={(next) => {
                const kept = retainModeState(next, extra, channel.slots);
                channel.onChange({ channelModeId: next.mode.id, referenceSlots: kept.slots, config: { ...coerceToMode(value, next), extraParams: kept.params } });
              }}
              onSlotsChange={(referenceSlots) => channel.onChange({ referenceSlots })}
            />
          ) : null}
          {!multiframe && durationChoices !== null ? (
            <section className="ui-popover__section">
              <div className="ui-popover__title">{t('node.aiVideo.duration')}</div>
              {isAgnes ? (
                <>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min={1}
                      max={18}
                      step={1}
                      value={Math.min(18, Math.max(1, Number(value.duration) || 5))}
                      onChange={(event) => patch({ duration: event.target.value })}
                      className="ui-range h-5 min-w-0 flex-1"
                      aria-label={t('node.aiVideo.duration')}
                    />
                    <span className="w-9 text-right text-[12px] tabular-nums">{value.duration}s</span>
                  </div>
                  <p className="mt-1 text-[11.5px] leading-4 text-text-subtle">{t('node.aiVideo.agnesDurationHint')}</p>
                </>
              ) : (
                <ChoiceTiles
                  options={durationChoices?.options ?? entry.supportedDurations}
                  value={value.duration}
                  label={durationLabel}
                  onPick={(duration) => patch({ duration })}
                />
              )}
            </section>
          ) : null}
          {ratioChoices !== null ? (
            <section className="ui-popover__section">
              <div className="ui-popover__title">{t('node.aiVideo.aspectRatio')}</div>
              <ChoiceTiles options={ratioChoices?.options ?? entry.supportedAspectRatios} value={value.aspectRatio} label={ratioLabel} onPick={(aspectRatio) => patch({ aspectRatio })} />
            </section>
          ) : null}
          {resolutionChoices !== null ? (
            <section className="ui-popover__section">
              <div className="ui-popover__title">{t('node.aiVideo.resolution')}</div>
              <ChoiceTiles
                options={resolutionChoices?.options ?? entry.supportedResolutions}
                value={value.resolution}
                label={resolutionLabel}
                onPick={(resolution) => patch({ resolution })}
              />
            </section>
          ) : null}
          {(entry.inputSchema.imageModes?.length ?? 0) > 1 ? (
            <section className="ui-popover__section">
              <div className="ui-popover__title">{t('videoInputModes.label')}</div>
              <ChoiceTiles
                options={entry.inputSchema.imageModes ?? []}
                value={String(extra.imageMode ?? 'reference')}
                label={(mode) => t(`videoInputModes.${mode}`)}
                onPick={(imageMode) => patchExtra((next) => { next.imageMode = imageMode; })}
              />
              <p className="mt-1 text-[11.5px] leading-4 text-text-subtle">{t('videoInputModes.hint')}</p>
            </section>
          ) : null}
          {isAgnes && imageCount > 1 ? (
            <section className="ui-popover__section">
              <div className="ui-popover__title">{t('node.aiVideo.agnesMode')}</div>
              <ChoiceTiles
                options={['multi', 'keyframes']}
                value={isAgnesKeyframes(extra) ? 'keyframes' : 'multi'}
                label={(mode) => t(mode === 'keyframes' ? 'node.aiVideo.agnesModeKeyframes' : 'node.aiVideo.agnesModeMulti')}
                onPick={(mode) => patchExtra((next) => {
                  delete next.videoMode;
                  delete next.mode;
                  if (mode === 'keyframes') next.agnesVideoMode = 'keyframes';
                  else delete next.agnesVideoMode;
                })}
              />
            </section>
          ) : null}
          {multiframe ? (
            <section className="ui-popover__section">
              <DreaminaMultiframeEditor
                imageCount={imageCount}
                value={extra.dreaminaTransitionSegments ?? extra.transitionSegments}
                onChange={(segments: DreaminaTransitionSegment[]) => patchExtra((next) => {
                  next.dreaminaTransitionSegments = segments;
                  delete next.transitionSegments;
                })}
              />
            </section>
          ) : null}
          {declaredParams.length ? (
            <section className="ui-popover__section">
              <DeclaredParameters params={declaredParams} values={extra} onChange={(extraParams) => patch({ extraParams })} />
            </section>
          ) : null}
          {inputs ? (
            <p className="ui-popover__section text-[11.5px] leading-4 text-text-subtle">
              {t('rework.canvas.composer.acceptsInputs', { inputs })}
            </p>
          ) : null}
        </PopoverSurface>
      ) : null}
    </>
  );
}
