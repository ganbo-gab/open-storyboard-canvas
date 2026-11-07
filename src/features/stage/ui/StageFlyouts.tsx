import type { LucideIcon } from 'lucide-react';
import { Camera, Crosshair, DiamondPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiSwitch } from '@/components/ui';
import type { DirectorStudioCameraSettings, DirectorStudioLightingSettings } from '@/features/canvas/domain/canvasNodes';
import { SliderField } from './stageKit';

/** "Add" flyout: large, described entries instead of a row of cryptic icons. */
export function AddFlyoutBody({ entries }: {
  entries: Array<{ key: string; icon: LucideIcon; label: string; hint: string; keys?: string; onClick: () => void }>;
}) {
  return (
    <div className="-mx-1.5 space-y-0.5">
      {entries.map((entry) => (
        <button key={entry.key} type="button" onClick={entry.onClick} className="group flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-[var(--hover)]">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--tile-bg)] text-text-muted shadow-[inset_0_0_0_1px_var(--line)] transition-colors group-hover:bg-accent/15 group-hover:text-accent">
            <entry.icon className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-medium text-text-dark">{entry.label}</span>
            <span className="block text-[11px] leading-4 text-text-subtle">{entry.hint}</span>
          </span>
          {entry.keys ? <kbd className="stage-kbd">{entry.keys}</kbd> : null}
        </button>
      ))}
    </div>
  );
}

const LIGHT_FIELDS = [
  ['mainIntensity', 'directorStudio.lighting.mainIntensity', 0, 4, 0.05, ''],
  ['mainYaw', 'directorStudio.lighting.mainYaw', -180, 180, 1, '°'],
  ['mainPitch', 'directorStudio.lighting.mainPitch', -20, 89, 1, '°'],
  ['ambientIntensity', 'directorStudio.lighting.ambientIntensity', 0, 3, 0.05, ''],
] as const;

export function LightingFlyoutBody({ lighting, onChange }: {
  lighting: DirectorStudioLightingSettings;
  onChange: (patch: Partial<DirectorStudioLightingSettings>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <label className="flex items-center justify-between text-xs text-text-dark">
        {t('directorStudio.lighting.enabled')}
        <UiSwitch aria-label={t('directorStudio.lighting.enabled')} checked={lighting.enabled} onCheckedChange={(enabled) => onChange({ enabled })} />
      </label>
      <div className={`space-y-2 transition-opacity ${lighting.enabled ? '' : 'pointer-events-none opacity-40'}`}>
        {LIGHT_FIELDS.map(([key, labelKey, min, max, step, suffix]) => (
          <SliderField key={key} label={t(labelKey)} value={Number(lighting[key])} min={min} max={max} step={step} suffix={suffix || undefined} onChange={(value) => onChange({ [key]: value })} />
        ))}
        <div className="grid grid-cols-2 gap-2 pt-1">
          {([
            ['mainColor', 'directorStudio.lighting.mainColor'],
            ['ambientColor', 'directorStudio.lighting.ambientColor'],
          ] as const).map(([key, labelKey]) => (
            <label key={key} className="flex cursor-pointer items-center gap-2 rounded-lg bg-[var(--tile-bg)] p-1.5 text-[11px] text-text-muted shadow-[inset_0_0_0_1px_var(--line)] hover:text-text-dark">
              <span className="relative h-6 w-6 overflow-hidden rounded-md shadow-[inset_0_0_0_1px_var(--line-strong)]" style={{ backgroundColor: lighting[key] }}>
                <input type="color" value={lighting[key]} onChange={(event) => onChange({ [key]: event.target.value })} className="absolute inset-0 cursor-pointer opacity-0" aria-label={t(labelKey)} />
              </span>
              {t(labelKey)}
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Director lens: focal presets plus exact FOV / distance. */
export function LensFlyoutBody({ camera, presets, onFov, onDistance, onPreset }: {
  camera: DirectorStudioCameraSettings;
  presets: ReadonlyArray<{ id: string; fov: number; labelKey: string }>;
  onFov: (value: number) => void;
  onDistance: (value: number) => void;
  onPreset: (id: string, fov: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-1.5">
        {presets.map((preset) => (
          <button key={preset.id} type="button" onClick={() => onPreset(preset.id, preset.fov)} className="stage-chip h-9 justify-between px-2.5 shadow-[inset_0_0_0_1px_var(--line)]" data-active={camera.activePreset === preset.id || undefined}>
            <span>{t(preset.labelKey)}</span>
            <span className="font-mono text-[10px] text-text-subtle">{preset.fov}°</span>
          </button>
        ))}
      </div>
      <SliderField label={t('directorStudio.camera.fov')} value={camera.fov} min={10} max={150} step={0.1} suffix="°" onChange={onFov} />
      <SliderField label={t('directorStudio.camera.lensDistance')} value={camera.lensDistance} min={2} max={40} step={0.1} suffix="m" onChange={onDistance} />
    </div>
  );
}

/** Previs camera: motion templates for the selected subject, first-person pilot, record framing. */
export function CameraMotionFlyoutBody({ presets, subjectLabel, pilotActive, pilotKeys, onPreset, onTogglePilot, onAddKey }: {
  presets: Array<{ id: string; label: string; disabled: boolean; disabledReason?: string }>;
  subjectLabel: string | null;
  pilotActive: boolean;
  pilotKeys?: string;
  onPreset: (id: string) => void;
  onTogglePilot: () => void;
  onAddKey: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <button type="button" onClick={onAddKey} className="flex w-full items-center gap-2.5 rounded-xl bg-accent px-3 py-2.5 text-left text-[var(--accent-fg)] shadow-[0_8px_20px_-8px_rgb(var(--accent-rgb)/0.9)] transition-transform active:scale-[0.98]">
        <DiamondPlus className="h-4 w-4" />
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold">{t('directorStudio.previs.addCameraKey')}</span>
          <span className="block text-[11px] opacity-80">{t('directorStudio.previs.addCameraKeyHelp')}</span>
        </span>
      </button>
      <button type="button" onClick={onTogglePilot} aria-pressed={pilotActive} className="stage-chip h-10 w-full justify-start px-3 shadow-[inset_0_0_0_1px_var(--line)]" data-active={pilotActive || undefined} data-director-tooltip={t('directorStudio.motion.pilot.help')} data-director-tooltip-keys={pilotKeys}>
        <Crosshair className="h-4 w-4" />{t(pilotActive ? 'directorStudio.motion.pilot.exit' : 'directorStudio.motion.pilot.enter')}
      </button>
      <div>
        <div className="mb-1.5 flex items-baseline justify-between text-[10px] font-semibold uppercase tracking-[0.06em] text-text-subtle">
          {t('directorStudio.motion.cameraPresets.title')}
          {subjectLabel ? <span className="truncate pl-2 font-normal normal-case tracking-normal">{t('directorStudio.previs.presetSubject', { name: subjectLabel })}</span> : null}
        </div>
        <div className="space-y-0.5">
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              disabled={preset.disabled}
              onClick={() => onPreset(preset.id)}
              className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-xs text-text-muted transition-colors hover:bg-[var(--hover)] hover:text-text-dark disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
              data-director-tooltip={preset.disabled ? preset.disabledReason : undefined}
            >
              <Camera className="h-3.5 w-3.5 shrink-0 text-text-subtle" />{preset.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
