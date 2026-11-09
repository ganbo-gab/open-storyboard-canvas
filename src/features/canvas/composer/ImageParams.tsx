import { useRef, useState } from 'react';
import { Camera, ChevronDown, Copy, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { PopoverSurface, UiButton, UiInput, UiSwitch, UiTextArea, anchorAbove, type MenuAnchor } from '@/components/ui';
import type { CatalogEntry } from '@/features/canvas/application/modelCatalog';
import type { ModelConfigValue } from '@/features/canvas/ui/ModelConfigPicker';
import { ModelPickerChip, type ModelOption } from './ModelPicker';
import { NativeImageControls } from './NativeImageControls';
import { resolveNativeChannelModel } from '@/features/channels/application/channelService';

const COUNT_CHOICES = [1, 2, 3, 4] as const;
export const MAX_GENERATION_COUNT = 10;

export function formatRatioLabel(ratio: string, autoLabel: string): string {
  return ratio === 'auto' ? autoLabel : ratio;
}

/** Keep the current ratio when the new model supports it; otherwise its first ratio. */
export function pickRatio(entry: CatalogEntry, current: string | undefined): string {
  return current && entry.supportedRatios.includes(current) ? current : entry.supportedRatios[0] ?? 'auto';
}

export function toModelOptions(catalog: readonly CatalogEntry[]): ModelOption[] {
  return catalog.map((entry) => ({
    id: entry.id,
    group: entry.providerLabel,
    label: entry.modelLabel,
    usable: entry.usable,
    hint: entry.notReadyReason,
  }));
}

/**
 * Model + "16:9 · 2K" settings chips for image generators (image, storyboard grid, panorama).
 * Extra params are written only when the user sets them: an untouched panel adds nothing to the request.
 */
export function ImageModelControls({
  catalog,
  value,
  onChange,
  nodeId,
}: {
  catalog: readonly CatalogEntry[];
  value: ModelConfigValue | null;
  onChange(next: ModelConfigValue): void;
  nodeId?: string;
}) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const entry = catalog.find((candidate) => candidate.id === value?.entryId) ?? null;
  const extra = value?.extraParams ?? {};
  const ratio = value?.ratio ?? 'auto';
  const resolution = typeof extra.resolutionType === 'string' ? extra.resolutionType : null;
  const autoLabel = t('modelParams.autoAspectRatio');
  const native = value && resolveNativeChannelModel(value.entryId);

  const patchExtra = (patch: Record<string, unknown>) => {
    if (!value) return;
    const next = { ...extra };
    for (const [key, item] of Object.entries(patch)) {
      if (item === undefined || item === '') delete next[key];
      else next[key] = item;
    }
    onChange({ ...value, extraParams: next });
  };

  return (
    <>
      <ModelPickerChip
        options={toModelOptions(catalog)}
        value={value?.entryId ?? null}
        onChange={(id) => {
          const picked = catalog.find((candidate) => candidate.id === id);
          if (picked) onChange({ entryId: id, ratio: pickRatio(picked, value?.ratio), extraParams: value?.extraParams });
        }}
      />
      {native && nodeId && value ? <NativeImageControls nodeId={nodeId} value={value} onChange={onChange} /> : entry ? (
        <button
          ref={triggerRef}
          type="button"
          className="composer-chip"
          aria-haspopup="dialog"
          aria-expanded={Boolean(anchor)}
          onClick={() => setAnchor(anchor ? null : anchorAbove(triggerRef.current!))}
        >
          <SlidersHorizontal />
          <span className="composer-chip__text">
            {[formatRatioLabel(ratio, autoLabel), resolution].filter(Boolean).join(' · ')}
          </span>
          <ChevronDown />
        </button>
      ) : null}
      {anchor && entry && value ? (
        <PopoverSurface anchor={anchor} width={300} label={t('rework.canvas.composer.settings')} onClose={() => setAnchor(null)}>
          <section className="ui-popover__section">
            <div className="ui-popover__title">{t('rework.canvas.composer.ratio')}</div>
            <div className="ui-tiles">
              {entry.supportedRatios.map((option) => (
                <button
                  key={option}
                  type="button"
                  className="ui-tile"
                  aria-pressed={option === ratio}
                  onClick={() => onChange({ ...value, ratio: option })}
                >
                  {formatRatioLabel(option, autoLabel)}
                </button>
              ))}
            </div>
          </section>
          {entry.supportedResolutions?.length ? (
            <section className="ui-popover__section">
              <div className="ui-popover__title">{t('rework.canvas.composer.resolution')}</div>
              <div className="ui-tiles">
                {entry.supportedResolutions.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className="ui-tile"
                    aria-pressed={option === resolution}
                    onClick={() => patchExtra({ resolutionType: option === resolution ? undefined : option })}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </section>
          ) : null}
          {entry.supportedModelVersions?.length ? (
            <section className="ui-popover__section">
              <div className="ui-popover__title">{t('rework.canvas.composer.version')}</div>
              <div className="ui-tiles">
                {entry.supportedModelVersions.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className="ui-tile"
                    aria-pressed={extra.modelVersion === option}
                    onClick={() => patchExtra({ modelVersion: extra.modelVersion === option ? undefined : option })}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </section>
          ) : null}
          {entry.supportsWebSearch ? (
            <section className="ui-popover__section flex items-center justify-between gap-3">
              <span className="text-[13px]">{t('rework.canvas.composer.webSearch')}</span>
              <UiSwitch checked={Boolean(extra.webSearch)} onCheckedChange={(checked) => patchExtra({ webSearch: checked || undefined })} />
            </section>
          ) : null}
          <section className="ui-popover__section">
            <UiButton variant="ghost" size="sm" className="ui-popover__title w-full justify-between px-0" onClick={() => setAdvanced((open) => !open)}>
              {t('rework.canvas.composer.advanced')}
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${advanced ? 'rotate-180' : ''}`} />
            </UiButton>
            {advanced ? (
              <div className="flex flex-col gap-2">
                <UiInput
                  type="number"
                  value={typeof extra.seed === 'number' ? extra.seed : ''}
                  placeholder={t('rework.canvas.composer.seed')}
                  onChange={(event) => patchExtra({ seed: event.target.value.trim() === '' ? undefined : Number(event.target.value) })}
                />
                <UiTextArea
                  rows={2}
                  className="min-h-[60px]"
                  value={typeof extra.negativePrompt === 'string' ? extra.negativePrompt : ''}
                  placeholder={t('rework.canvas.composer.negativePrompt')}
                  onChange={(event) => patchExtra({ negativePrompt: event.target.value.trim() || undefined })}
                />
                <p className="text-[11.5px] leading-4 text-text-subtle">{t('rework.canvas.composer.advancedHint')}</p>
              </div>
            ) : null}
          </section>
        </PopoverSurface>
      ) : null}
    </>
  );
}

/** "×N": how many results one press produces. */
export function CountChip({ value, choices, onChange }: { value: number; choices?: readonly number[]; onChange(next: number): void }) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="composer-chip"
        aria-haspopup="dialog"
        aria-expanded={Boolean(anchor)}
        title={t('rework.canvas.composer.count')}
        onClick={() => setAnchor(anchor ? null : anchorAbove(triggerRef.current!))}
      >
        <Copy />
        <span className="composer-chip__text">×{value}</span>
      </button>
      {anchor ? (
        <PopoverSurface anchor={anchor} width={196} label={t('rework.canvas.composer.count')} onClose={() => setAnchor(null)}>
          <div className="ui-popover__title">{t('rework.canvas.composer.count')}</div>
          <div className="ui-tiles">
            {(choices ?? COUNT_CHOICES).map((count) => (
              <button
                key={count}
                type="button"
                className="ui-tile"
                aria-pressed={count === value}
                onClick={() => {
                  onChange(count);
                  setAnchor(null);
                }}
              >
                {count}
              </button>
            ))}
          </div>
          {!choices && <UiInput
            className="mt-2"
            type="number"
            min={1}
            max={MAX_GENERATION_COUNT}
            value={value}
            aria-label={t('rework.canvas.composer.customCount')}
            onChange={(event) => {
              const next = Math.round(Number(event.target.value));
              if (Number.isFinite(next)) onChange(Math.min(MAX_GENERATION_COUNT, Math.max(1, next)));
            }}
          />}
        </PopoverSurface>
      ) : null}
    </>
  );
}

/** Opens the cinematography panel; highlighted while a camera setup is applied. */
export function CameraChip({ active, onClick }: { active: boolean; onClick(): void }) {
  const { t } = useTranslation();
  return (
    <button type="button" className="composer-chip composer-chip--utility" title={t('cameraControl.title')} aria-label={t('cameraControl.title')} data-active={active || undefined} onClick={onClick}>
      <Camera />
      <span className="composer-chip__text">{t('cameraControl.title')}</span>
    </button>
  );
}
