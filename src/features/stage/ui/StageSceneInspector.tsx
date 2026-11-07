import { Eraser, FileText, Globe2, Grid3x3, Image, Monitor, MousePointer2, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiSegmented, UiSwitch, UiTextArea } from '@/components/ui';
import type { DirectorStudioScreenshotResolution, DirectorStudioViewSettings } from '@/features/canvas/domain/canvasNodes';
import { SliderField, StageSection } from './stageKit';

function ToggleRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3">
      <span className="min-w-0">
        <span className="block text-xs text-text-dark">{label}</span>
        {hint ? <span className="mt-0.5 block text-[10px] leading-4 text-text-subtle">{hint}</span> : null}
      </span>
      <UiSwitch aria-label={label} checked={checked} onCheckedChange={onChange} className="mt-0.5 shrink-0" />
    </label>
  );
}

/** Inspector shown when nothing is selected: the world itself — description, ground, background, output, navigation. */
export function StageSceneInspector({
  counts,
  prompt,
  onPromptChange,
  onPromptCommit,
  grid,
  onGrid,
  resolution,
  resolutionOptions,
  onResolution,
  viewSettings,
  onViewSettings,
  hasPanorama,
  panoramaBusyLabel,
  onImportPanorama,
  onClearPanorama,
}: {
  counts: { person: number; object: number; scene: number };
  prompt: string;
  onPromptChange: (value: string) => void;
  onPromptCommit: () => void;
  grid: { visible: boolean; height: number };
  onGrid: (patch: Partial<{ visible: boolean; height: number }>) => void;
  resolution: DirectorStudioScreenshotResolution;
  resolutionOptions: Array<{ value: DirectorStudioScreenshotResolution; label: string }>;
  onResolution: (value: DirectorStudioScreenshotResolution) => void;
  viewSettings: DirectorStudioViewSettings;
  onViewSettings: (patch: Partial<DirectorStudioViewSettings>) => void;
  hasPanorama: boolean;
  panoramaBusyLabel: string | null;
  onImportPanorama: () => void;
  onClearPanorama: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="pb-4">
      <div className="flex items-center gap-2.5 px-3.5 pb-3 pt-1">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-[var(--hover)] text-text-muted"><Globe2 className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-text-dark">{t('directorStudio.dock.scene')}</div>
          <div className="text-[11px] text-text-subtle">{t('directorStudio.dock.sceneCounts', counts)}</div>
        </div>
      </div>

      <StageSection title={t('directorStudio.prompt.title')} icon={<FileText className="h-3 w-3" />}>
        <UiTextArea
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          onBlur={onPromptCommit}
          rows={5}
          className="nodrag nowheel w-full resize-y px-2.5 py-2 text-xs leading-5 placeholder:text-text-subtle"
          placeholder={t('directorStudio.prompt.placeholder')}
        />
        <p className="text-[10px] leading-4 text-text-subtle">{t('directorStudio.prompt.hint')}</p>
      </StageSection>

      <StageSection title={t('directorStudio.toolbar.grid')} icon={<Grid3x3 className="h-3 w-3" />}>
        <ToggleRow label={t('directorStudio.grid.visible')} checked={grid.visible} onChange={(visible) => onGrid({ visible })} />
        <SliderField label={t('directorStudio.grid.height')} value={grid.height} min={-3} max={5} step={0.1} suffix="m" onChange={(height) => onGrid({ height })} />
      </StageSection>

      <StageSection title={t('directorStudio.dock.background')} icon={<Image className="h-3 w-3" />} defaultOpen={hasPanorama}>
        <p className="text-[11px] leading-5 text-text-subtle">{t('directorStudio.panoramaImportHint')}</p>
        <div className="grid grid-cols-2 gap-1.5">
          <UiButton size="sm" variant="secondary" onClick={onImportPanorama} disabled={Boolean(panoramaBusyLabel)}>
            <Upload className="h-3.5 w-3.5" />{panoramaBusyLabel ?? t('directorStudio.panoramaImport')}
          </UiButton>
          <UiButton size="sm" variant="ghost" onClick={onClearPanorama} disabled={!hasPanorama} className="text-danger hover:text-danger">
            <Eraser className="h-3.5 w-3.5" />{t('directorStudio.clearPanorama')}
          </UiButton>
        </div>
      </StageSection>

      <StageSection title={t('directorStudio.toolbar.resolution')} icon={<Monitor className="h-3 w-3" />} defaultOpen={false}>
        <UiSegmented value={resolution} options={resolutionOptions} onChange={onResolution} aria-label={t('directorStudio.toolbar.resolution')} size="sm" className="w-full" />
        <p className="text-[10px] leading-4 text-text-subtle">{t('directorStudio.resolutionNote')}</p>
      </StageSection>

      <StageSection title={t('directorStudio.viewSettings.title')} icon={<MousePointer2 className="h-3 w-3" />} defaultOpen={false}>
        <ToggleRow label={t('directorStudio.viewSettings.wheelZoomEnabled')} hint={t('directorStudio.viewSettings.wheelZoomEnabledHint')} checked={viewSettings.wheelZoomEnabled} onChange={(wheelZoomEnabled) => onViewSettings({ wheelZoomEnabled })} />
        <ToggleRow label={t('directorStudio.viewSettings.reverseWheelZoom')} hint={t('directorStudio.viewSettings.reverseWheelZoomHint')} checked={viewSettings.reverseWheelZoom} onChange={(reverseWheelZoom) => onViewSettings({ reverseWheelZoom })} />
        <ToggleRow label={t('directorStudio.viewSettings.showAdvancedPedestrianTags')} hint={t('directorStudio.viewSettings.showAdvancedPedestrianTagsHint')} checked={viewSettings.showAdvancedPedestrianTags} onChange={(showAdvancedPedestrianTags) => onViewSettings({ showAdvancedPedestrianTags })} />
      </StageSection>
    </div>
  );
}
