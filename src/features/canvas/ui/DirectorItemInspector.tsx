import type { ReactNode } from 'react';
import { Eye, EyeOff, Link2, Move3d, PersonStanding, Save, Shirt, Sparkles, Trash2, Unlink, X, FileText, ImagePlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiChipButton, UiIconButton, UiInput, UiSegmented, UiSwitch, UiTextArea } from '@/components/ui';
import type { BlueprintBodyControls, BlueprintBodyStyle, BlueprintItem } from '@/features/canvas/domain/canvasNodes';
import { DIRECTOR_STUDIO_BODY_STYLES, normalizeBlueprintBodyControls } from '@/features/canvas/domain/directorStudioBodyControls';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { ensurePos3d } from './blueprintCoordinates';
import { SliderField, StageSection, VectorField } from '@/features/stage/ui/stageKit';

type VectorAxis = 'x' | 'y' | 'z';
type TextField = 'label' | 'relation' | 'note' | 'action';
type BodySection = 'core' | 'arms' | 'legs';

const BODY_FIELDS: Record<BodySection, ReadonlyArray<readonly [string, string, number, number, number, string?]>> = {
  core: [
    ['height', 'bodyHeight', 0.45, 1.8, 0.01],
    ['torsoWidth', 'torsoWidth', 0.45, 2, 0.01],
    ['headScale', 'headScale', 0.55, 1.8, 0.01],
    ['torsoLeanDeg', 'torsoLean', -45, 45, 1, '°'],
  ],
  arms: [
    ['length', 'armLength', 0.45, 1.8, 0.01],
    ['thickness', 'armThickness', 0.45, 2, 0.01],
    ['spreadDeg', 'armSpread', -35, 35, 1, '°'],
  ],
  legs: [
    ['length', 'legLength', 0.45, 1.8, 0.01],
    ['thickness', 'legThickness', 0.45, 2, 0.01],
    ['spreadDeg', 'legSpread', -25, 35, 1, '°'],
  ],
};
const BODY_SECTION_LABEL: Record<BodySection, string> = { core: 'bodyCore', arms: 'bodyArms', legs: 'bodyLegs' };

export interface DirectorItemInspectorProps {
  item: BlueprintItem;
  text: { label: string; relation: string; note: string; action: string };
  /** Static action presets (Director). Previs drives actions from the timeline instead. */
  actionPresets: Array<{ id: string; value: string; labelKey: string; selected: boolean }> | null;
  customActionPresets: Array<{ value: string; selected: boolean }>;
  /** Previs: route, actions and keyframe editor, shown right under the identity row. */
  motion?: ReactNode;
  poseInspector: ReactNode;
  poseShortcut: string;
  onTextChange: (field: TextField, value: string) => void;
  onTextCommit: () => void;
  onUpdate: (patch: Partial<BlueprintItem>) => void;
  onPosition: (axis: VectorAxis, value: number) => void;
  onRotationDegrees: (axis: VectorAxis, value: number) => void;
  onScale: (axis: VectorAxis, value: number) => void;
  onAction: (value: string) => void;
  onDeleteActionPreset: (value: string) => void;
  onSaveActionPreset: () => void;
  onStartPose: () => void;
  onBodyControls: (patch: Partial<BlueprintBodyControls>) => void;
  onBodySection: (section: BodySection, patch: Record<string, number>) => void;
  onLinkImage: () => void;
  onClearImage: () => void;
  onDelete: () => void;
}

/** Item inspector shared by Director and Previs: identity, placement, performance, body, reference and notes. */
export function DirectorItemInspector(props: DirectorItemInspectorProps) {
  const { t } = useTranslation();
  const { item, text } = props;
  const isPerson = item.category === 'person';
  const body = isPerson ? normalizeBlueprintBodyControls(item.bodyControls) : null;
  const labelHidden = item.showLabel === false;
  const rotation = {
    x: ((item.rotation3d?.x ?? 0) * 180) / Math.PI,
    y: ((item.rotation3d?.y ?? 0) * 180) / Math.PI,
    z: ((item.rotation3d?.z ?? 0) * 180) / Math.PI,
  };
  const commitOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    props.onTextCommit();
    event.currentTarget.blur();
  };

  return (
    <div className="pb-4">
      <div className="flex items-center gap-2 px-3.5 pb-3 pt-1">
        <label className="relative h-8 w-8 shrink-0 cursor-pointer overflow-hidden rounded-lg shadow-[inset_0_0_0_1px_var(--line-strong)]" style={{ backgroundColor: item.color || '#9ca3af' }} data-director-tooltip={t('directorStudio.inspector.color')}>
          <input type="color" value={item.color || '#9ca3af'} onChange={(event) => props.onUpdate({ color: event.target.value })} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" aria-label={t('directorStudio.inspector.color')} />
        </label>
        <UiInput
          value={text.label}
          onChange={(event) => props.onTextChange('label', event.target.value)}
          onBlur={props.onTextCommit}
          onKeyDown={commitOnEnter}
          className="h-8 min-w-0 flex-1 px-2.5 text-[13px] font-medium"
          aria-label={t('directorStudio.inspector.name')}
        />
        <UiIconButton
          size="sm"
          active={!labelHidden}
          aria-pressed={!labelHidden}
          aria-label={t(labelHidden ? 'directorStudio.inspector.showLabel' : 'directorStudio.inspector.hideLabel')}
          data-director-tooltip={t(labelHidden ? 'directorStudio.inspector.showLabel' : 'directorStudio.inspector.hideLabel')}
          onClick={() => props.onUpdate({ showLabel: labelHidden })}
        >
          {labelHidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </UiIconButton>
      </div>

      {props.motion}

      <StageSection title={t('directorStudio.inspector.transform')} icon={<Move3d className="h-3 w-3" />}>
        <VectorField label={t('directorStudio.inspector.position')} value={ensurePos3d(item)} min={-20} max={20} step={0.1} onChange={props.onPosition} onCommit={props.onPosition} />
        <VectorField label={t('directorStudio.inspector.rotation')} value={rotation} min={-180} max={180} step={1} suffix="°" onChange={props.onRotationDegrees} onCommit={props.onRotationDegrees} />
        <VectorField label={t('directorStudio.inspector.scale')} value={item.scale3d ?? { x: 1, y: 1, z: 1 }} min={0.1} max={5} step={0.05} onChange={props.onScale} onCommit={props.onScale} />
        <p className="text-[10px] leading-4 text-text-subtle">{t('directorStudio.inspector.scrubHint')}</p>
      </StageSection>

      {isPerson ? (
        <StageSection title={t(props.actionPresets ? 'directorStudio.inspector.action' : 'directorStudio.pose.title')} icon={<Sparkles className="h-3 w-3" />}>
          {props.poseInspector ?? (
            <UiButton size="sm" variant="accent" onClick={props.onStartPose} className="w-full" data-director-tooltip={t('directorStudio.pose.viewportHint')} data-director-tooltip-keys={props.poseShortcut}>
              <PersonStanding className="h-3.5 w-3.5" />{t('directorStudio.pose.enter')}
            </UiButton>
          )}
          {props.actionPresets ? (
            <>
              <div className="grid grid-cols-3 gap-1.5">
                {props.actionPresets.map((preset) => (
                  <UiChipButton key={preset.id} active={preset.selected} onClick={() => props.onAction(preset.value)} className="h-8 justify-center text-xs">{t(preset.labelKey)}</UiChipButton>
                ))}
              </div>
              {props.customActionPresets.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {props.customActionPresets.map((preset) => (
                    <span key={preset.value} className={`group/chip inline-flex h-7 max-w-full items-center overflow-hidden rounded-full text-xs ${preset.selected ? 'bg-accent/20 text-text-dark shadow-[inset_0_0_0_1px_rgb(var(--accent-rgb)/0.5)]' : 'bg-[var(--tile-bg)] text-text-muted shadow-[inset_0_0_0_1px_var(--line)]'}`}>
                      <button type="button" onClick={() => props.onAction(preset.value)} className="max-w-36 truncate pl-2.5 pr-1 hover:text-text-dark">{preset.value}</button>
                      <button type="button" onClick={() => props.onDeleteActionPreset(preset.value)} className="grid h-full w-6 place-items-center text-text-subtle opacity-60 hover:text-danger group-hover/chip:opacity-100" aria-label={t('directorStudio.inspector.deleteActionPreset', { name: preset.value })} data-director-tooltip={t('directorStudio.inspector.deleteActionPreset', { name: preset.value })}>
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="flex items-center gap-1.5">
                <UiInput
                  value={text.action}
                  onChange={(event) => props.onTextChange('action', event.target.value)}
                  onBlur={props.onTextCommit}
                  onKeyDown={commitOnEnter}
                  className="h-8 min-w-0 flex-1 px-2.5 text-xs"
                  placeholder={t('directorStudio.inspector.actionPlaceholder')}
                  aria-label={t('directorStudio.inspector.action')}
                />
                <UiIconButton size="sm" variant="secondary" onClick={props.onSaveActionPreset} disabled={!text.action.trim()} aria-label={t('directorStudio.inspector.saveActionPreset')} data-director-tooltip={t('directorStudio.inspector.saveActionPreset')}>
                  <Save className="h-3.5 w-3.5" />
                </UiIconButton>
              </div>
            </>
          ) : null}
        </StageSection>
      ) : null}

      {body ? (
        <StageSection title={t('directorStudio.inspector.body')} icon={<Shirt className="h-3 w-3" />} defaultOpen={false}>
          <UiSegmented
            value={body.style}
            options={DIRECTOR_STUDIO_BODY_STYLES.map((style) => ({ value: style.value as BlueprintBodyStyle, label: t(style.labelKey) }))}
            onChange={(style) => props.onBodyControls({ style })}
            aria-label={t('directorStudio.inspector.body')}
            size="sm"
            className="w-full"
          />
          <label className="flex items-center justify-between text-xs text-text-muted">
            <span>{t('directorStudio.inspector.showControls')}</span>
            <UiSwitch aria-label={t('directorStudio.inspector.showControls')} checked={body.showControls} onCheckedChange={(checked) => props.onBodyControls({ showControls: checked })} />
          </label>
          {(Object.keys(BODY_FIELDS) as BodySection[]).map((section) => (
            <div key={section} className="space-y-1.5 pt-1">
              <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-text-subtle">{t(`directorStudio.inspector.${BODY_SECTION_LABEL[section]}`)}</div>
              {BODY_FIELDS[section].map(([field, labelKey, min, max, step, suffix]) => (
                <SliderField
                  key={field}
                  label={t(`directorStudio.inspector.${labelKey}`)}
                  value={Number((body[section] as Record<string, number>)[field])}
                  min={min}
                  max={max}
                  step={step}
                  suffix={suffix}
                  onChange={(value) => props.onBodySection(section, { [field]: value })}
                />
              ))}
            </div>
          ))}
        </StageSection>
      ) : null}

      <StageSection title={t('directorStudio.linkedImage.title')} icon={<ImagePlus className="h-3 w-3" />} defaultOpen={Boolean(item.refImageUrl)}>
        {item.refImageUrl ? (
          <div className="flex items-center gap-2.5 rounded-xl bg-[var(--tile-bg)] p-2 shadow-[inset_0_0_0_1px_var(--line)]">
            <img src={resolveImageDisplayUrl(item.refImageUrl) ?? item.refImageUrl} alt={item.refImageName ?? item.label} className="h-12 w-12 rounded-lg object-cover" draggable={false} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs text-text-dark">{item.refImageName}</div>
              <div className="text-[10px] text-text-subtle">{t('directorStudio.linkedImage.associated')}</div>
            </div>
            <UiIconButton size="sm" onClick={props.onClearImage} className="text-danger" aria-label={t('directorStudio.linkedImage.clear')} data-director-tooltip={t('directorStudio.linkedImage.clear')}><Unlink className="h-3.5 w-3.5" /></UiIconButton>
          </div>
        ) : (
          <p className="text-[11px] leading-5 text-text-subtle">{t('directorStudio.linkedImage.empty')}</p>
        )}
        <UiButton size="sm" variant="secondary" onClick={props.onLinkImage} className="w-full">
          <Link2 className="h-3.5 w-3.5" />{t(item.refImageUrl ? 'directorStudio.linkedImage.change' : 'directorStudio.linkedImage.choose')}
        </UiButton>
      </StageSection>

      <StageSection title={t('directorStudio.inspector.notes')} icon={<FileText className="h-3 w-3" />} defaultOpen={Boolean(text.relation || text.note)}>
        <label className="block space-y-1">
          <span className="text-[11px] text-text-muted">{t('directorStudio.inspector.relation')}</span>
          <UiTextArea value={text.relation} onChange={(event) => props.onTextChange('relation', event.target.value)} onBlur={props.onTextCommit} rows={3} className="w-full resize-none px-2.5 py-2 text-xs leading-5" placeholder={t('directorStudio.inspector.relationPlaceholder')} />
        </label>
        <label className="block space-y-1">
          <span className="text-[11px] text-text-muted">{t('directorStudio.inspector.note')}</span>
          <UiTextArea value={text.note} onChange={(event) => props.onTextChange('note', event.target.value)} onBlur={props.onTextCommit} rows={3} className="w-full resize-none px-2.5 py-2 text-xs leading-5" placeholder={t('directorStudio.inspector.notePlaceholder')} />
        </label>
      </StageSection>

      <div className="px-3.5 pt-3">
        <UiButton size="sm" variant="ghost" onClick={props.onDelete} className="w-full text-danger hover:text-danger">
          <Trash2 className="h-3.5 w-3.5" />{t('directorStudio.previs.deleteObject')}
        </UiButton>
      </div>
    </div>
  );
}
