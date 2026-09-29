import { memo } from 'react';
import { ArrowLeft, Box, Camera, ChevronRight, DiamondPlus, Film, Layers3, Route, Trash2, UserRound, UserRoundPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { BlueprintBodyControls, BlueprintItem, DirectorMotionProjectV1 } from '@/features/canvas/domain/canvasNodes';
import { DIRECTOR_STUDIO_BODY_STYLES, normalizeBlueprintBodyControls } from '@/features/canvas/domain/directorStudioBodyControls';
import { ensurePos3d, pos3dToLegacy } from './blueprintCoordinates';
import {
  DirectorInspectorVectorFields,
  DirectorInspectorNumberField,
  DirectorMotionInspector,
  getSelectedDirectorKeyframe,
  type DirectorKeyframePatch,
  type DirectorKeyframeSelection,
} from './DirectorMotionInspector';

export interface DirectorPrevisSidebarProps {
  items: BlueprintItem[];
  project: DirectorMotionProjectV1;
  selectedItemId: string | null;
  selection: DirectorKeyframeSelection | null;
  onSelectItem: (id: string | null) => void;
  onSelectionChange: (selection: DirectorKeyframeSelection | null) => void;
  onTimeChange: (time: number) => void;
  onRetimeTrack: (kind: 'camera' | 'object', trackId: string, start: number, end: number) => void;
  onPatchKeyframe: (selection: DirectorKeyframeSelection, patch: DirectorKeyframePatch) => void;
  onDuplicateKeyframe: (selection: DirectorKeyframeSelection) => void;
  onDeleteKeyframe: (selection: DirectorKeyframeSelection) => void;
  onUpdateItem: (id: string, patch: Partial<BlueprintItem>) => void;
  onAddPerson: () => void;
  onAddCameraKeyframe: () => void;
  onOpenModels: () => void;
  onOpenActions: () => void;
  onDeleteItem?: (id: string) => void;
  className?: string;
}

const BUTTON_CLASS = 'inline-flex min-h-8 items-center justify-center gap-1.5 rounded border border-white/15 bg-white/5 px-2.5 text-xs text-white/80 transition-colors hover:border-teal-300/40 hover:bg-white/10 active:bg-teal-400/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/60';
const FIELD_CLASS = 'h-8 w-full min-w-0 rounded border border-white/15 bg-[#171a1f] px-2 text-xs text-white outline-none transition-colors hover:border-white/30 focus:border-teal-400/70 focus:ring-1 focus:ring-teal-400/30';

export const DirectorPrevisSidebar = memo(function DirectorPrevisSidebar({
  items,
  project,
  selectedItemId,
  selection,
  onSelectItem,
  onSelectionChange,
  onTimeChange,
  onRetimeTrack,
  onPatchKeyframe,
  onDuplicateKeyframe,
  onDeleteKeyframe,
  onUpdateItem,
  onAddPerson,
  onAddCameraKeyframe,
  onOpenModels,
  onOpenActions,
  onDeleteItem,
  className = '',
}: DirectorPrevisSidebarProps) {
  const { t } = useTranslation();
  const selectedFrame = getSelectedDirectorKeyframe(project, selection);
  const motionSelection = selectedFrame ? selection : null;
  const activeItemId = motionSelection?.kind === 'camera' ? null : motionSelection?.trackId ?? selectedItemId;
  const selectedItem = items.find((item) => item.id === activeItemId) ?? null;
  const cameraSelected = !selectedItem;
  const objectTrack = selectedItem ? project.objectTracks[selectedItem.id] ?? [] : [];
  const actionTrack = selectedItem ? project.actionTracks[selectedItem.id] ?? [] : [];
  const showMotionInspector = cameraSelected || Boolean(motionSelection);

  const selectItem = (id: string | null) => {
    onSelectionChange(null);
    onSelectItem(id);
  };
  const selectFirstKeyframe = (kind: 'object' | 'action') => {
    if (!selectedItem) return;
    const frame = (kind === 'object' ? objectTrack : actionTrack)[0];
    if (!frame) return;
    onSelectionChange({ kind, trackId: selectedItem.id, keyframeId: frame.id });
    onTimeChange(frame.time);
  };

  return (
    <aside
      className={`flex h-full min-h-0 w-full shrink-0 flex-col bg-[#171a1f] text-xs text-white ${className}`}
      aria-label={t('directorStudio.previs.sceneAndProperties')}
      data-director-previs-sidebar="true"
      onWheel={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
    >
      <section className="flex max-h-[36%] min-h-[150px] shrink-0 flex-col border-b border-white/10">
        <header className="flex h-10 shrink-0 items-center justify-between px-3">
          <h2 className="flex items-center gap-2 font-semibold text-white/90"><Layers3 className="h-3.5 w-3.5 text-white/50" />{t('directorStudio.previs.sceneObjects')}</h2>
          <span className="font-mono text-white/45">{items.length + 1}</span>
        </header>
        <div className="flex shrink-0 gap-2 px-3 pb-2">
          <button
            type="button"
            onClick={onAddPerson}
            className={`${BUTTON_CLASS} flex-1 border-teal-300/25 bg-teal-400/10 text-teal-100 hover:bg-teal-400/20`}
            title={t('directorStudio.previs.addPersonHelp')}
            data-director-tooltip={t('directorStudio.previs.addPersonHelp')}
          ><UserRoundPlus className="h-3.5 w-3.5 shrink-0" />{t('directorStudio.motion.guide.addPerson')}</button>
          <button
            type="button"
            onClick={onOpenModels}
            className={`${BUTTON_CLASS} flex-1`}
            title={t('directorStudio.previs.openModelsHelp')}
            data-director-tooltip={t('directorStudio.previs.openModelsHelp')}
          ><Box className="h-3.5 w-3.5 shrink-0" />{t('directorStudio.previs.models')}</button>
        </div>
        <div className="ui-scrollbar min-h-0 overflow-y-auto px-2 pb-2" aria-label={t('directorStudio.previs.sceneObjects')}>
          <button
            type="button"
            onClick={() => selectItem(null)}
            aria-pressed={cameraSelected}
            className={`mb-1 flex h-9 w-full items-center gap-2 rounded px-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/60 ${cameraSelected ? 'bg-teal-400/15 text-teal-100 ring-1 ring-inset ring-teal-400/30' : 'text-white/75 hover:bg-white/10 active:bg-white/15'}`}
            title={t('directorStudio.previs.selectCameraHelp')}
            data-director-tooltip={t('directorStudio.previs.selectCameraHelp')}
          >
            <Camera className="h-4 w-4 shrink-0 text-teal-200/80" />
            <span className="min-w-0 flex-1 truncate">{t('directorStudio.motion.timeline.camera')}</span>
            <span className="font-mono text-white/45">{project.cameraTrack.length}</span>
          </button>
          {items.map((item) => {
            const Icon = item.category === 'person' ? UserRound : item.category === 'scene' ? Layers3 : Box;
            const selected = item.id === selectedItem?.id;
            const frameCount = (project.objectTracks[item.id]?.length ?? 0) + (project.actionTracks[item.id]?.length ?? 0);
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => selectItem(item.id)}
                aria-pressed={selected}
                className={`mt-1 flex h-9 w-full items-center gap-2 rounded px-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/60 ${selected ? 'bg-teal-400/15 text-teal-100 ring-1 ring-inset ring-teal-400/30' : 'text-white/75 hover:bg-white/10 active:bg-white/15'}`}
                title={t('directorStudio.previs.selectObjectHelp', { name: item.label })}
                data-director-tooltip={t('directorStudio.previs.selectObjectHelp', { name: item.label })}
              >
                <Icon className="h-4 w-4 shrink-0" style={{ color: item.color }} />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {frameCount ? <span className="font-mono text-white/45">{frameCount}</span> : null}
              </button>
            );
          })}
        </div>
      </section>
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-white/10 bg-[#20242a] px-3">
        <h2 className="font-semibold text-white/90">{t(showMotionInspector ? 'directorStudio.motion.inspector.title' : 'directorStudio.inspector.title')}</h2>
        {motionSelection && selectedItem ? (
          <button
            type="button"
            onClick={() => selectItem(selectedItem.id)}
            className="flex h-7 items-center gap-1 rounded px-1.5 text-xs text-teal-200 transition-colors hover:bg-white/10 active:bg-teal-400/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/60"
            title={t('directorStudio.previs.backToObjectHelp')}
            data-director-tooltip={t('directorStudio.previs.backToObjectHelp')}
          ><ArrowLeft className="h-3.5 w-3.5" />{t('directorStudio.previs.objectProperties')}</button>
        ) : null}
      </header>
      <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
        {showMotionInspector ? (
          <div className="space-y-4">
            {cameraSelected ? (
              <div className="space-y-2">
                {!project.cameraTrack.length ? <p className="leading-5 text-white/60">{t('directorStudio.previs.cameraEmpty')}</p> : null}
                <button
                  type="button"
                  onClick={onAddCameraKeyframe}
                  className={`${BUTTON_CLASS} w-full border-teal-300/25 bg-teal-400/10 text-teal-100 hover:bg-teal-400/20`}
                  title={t('directorStudio.previs.addCameraKeyHelp')}
                  data-director-tooltip={t('directorStudio.previs.addCameraKeyHelp')}
                ><DiamondPlus className="h-3.5 w-3.5" />{t('directorStudio.previs.addCameraKey')}</button>
              </div>
            ) : null}
            {!cameraSelected || project.cameraTrack.length > 0 ? <DirectorMotionInspector
              project={project}
              items={items}
              selectedItemId={selectedItem?.id ?? null}
              selection={motionSelection}
              onSelectionChange={onSelectionChange}
              onTimeChange={onTimeChange}
              onRetimeTrack={onRetimeTrack}
              onPatch={onPatchKeyframe}
              onDuplicate={onDuplicateKeyframe}
              onDelete={onDeleteKeyframe}
            /> : null}
            {selectedItem?.category === 'person' ? (
              <button type="button" onClick={onOpenActions} className={`${BUTTON_CLASS} w-full`} title={t('directorStudio.previs.openActionsHelp')} data-director-tooltip={t('directorStudio.previs.openActionsHelp')}>
                <Film className="h-3.5 w-3.5" />{t('directorStudio.motion.library.title')}
              </button>
            ) : null}
          </div>
        ) : selectedItem ? (
          <div key={selectedItem.id} className="space-y-4">
            <div className="space-y-3 rounded-md border border-white/10 bg-[#20242a] p-3">
              <label className="block text-white/60">
                <span className="mb-1.5 block">{t('directorStudio.inspector.name')}</span>
                <input
                  key={selectedItem.label}
                  type="text"
                  defaultValue={selectedItem.label}
                  className={FIELD_CLASS}
                  onBlur={(event) => {
                    const label = event.currentTarget.value.trim();
                    if (label && label !== selectedItem.label) onUpdateItem(selectedItem.id, { label });
                    else event.currentTarget.value = selectedItem.label;
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') event.currentTarget.value = selectedItem.label;
                    if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur();
                  }}
                />
              </label>
              <div className="flex items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-white/65">
                  <input
                    key={selectedItem.color}
                    type="color"
                    defaultValue={selectedItem.color || '#9ca3af'}
                    onBlur={(event) => {
                      if (event.currentTarget.value !== selectedItem.color) onUpdateItem(selectedItem.id, { color: event.currentTarget.value });
                    }}
                    className="h-7 w-8 cursor-pointer rounded border border-white/20 bg-[#171a1f] focus-visible:outline-teal-400"
                  />
                  {t('directorStudio.inspector.color')}
                </label>
                <label className="flex items-center gap-2 text-white/65">
                  <input type="checkbox" checked={selectedItem.showLabel !== false} onChange={(event) => onUpdateItem(selectedItem.id, { showLabel: event.target.checked })} className="h-3.5 w-3.5 accent-teal-400" />
                  {t('directorStudio.inspector.showLabel')}
                </label>
              </div>
            </div>
            <div className="space-y-2 border-t border-white/10 pt-3">
              {objectTrack.length ? (
                <button type="button" onClick={() => selectFirstKeyframe('object')} className={`${BUTTON_CLASS} w-full justify-between`} title={t('directorStudio.previs.editRouteHelp')} data-director-tooltip={t('directorStudio.previs.editRouteHelp')}>
                  <span className="flex items-center gap-2"><Route className="h-3.5 w-3.5" />{t('directorStudio.previs.editRoute')}</span>
                  <span className="flex items-center gap-1 text-white/50">{objectTrack.length}<ChevronRight className="h-3.5 w-3.5" /></span>
                </button>
              ) : selectedItem.category === 'person' ? <p className="leading-5 text-white/50">{t('directorStudio.previs.objectRouteEmpty')}</p> : null}
              {selectedItem.category === 'person' ? (
                <>
                  <button type="button" onClick={onOpenActions} className={`${BUTTON_CLASS} w-full border-teal-300/25 bg-teal-400/10 text-teal-100 hover:bg-teal-400/20`} title={t('directorStudio.previs.openActionsHelp')} data-director-tooltip={t('directorStudio.previs.openActionsHelp')}>
                    <Film className="h-3.5 w-3.5" />{t('directorStudio.motion.guide.addAction')}
                  </button>
                  {actionTrack.length ? (
                    <button type="button" onClick={() => selectFirstKeyframe('action')} className={`${BUTTON_CLASS} w-full justify-between`} title={t('directorStudio.previs.editActionsHelp')} data-director-tooltip={t('directorStudio.previs.editActionsHelp')}>
                      <span>{t('directorStudio.previs.editActions')}</span><span className="flex items-center gap-1 text-white/50">{actionTrack.length}<ChevronRight className="h-3.5 w-3.5" /></span>
                    </button>
                  ) : null}
                </>
              ) : null}
            </div>
            <DirectorInspectorVectorFields
              label={t('directorStudio.inspector.position')}
              value={ensurePos3d(selectedItem)}
              min={-20}
              max={20}
              onCommit={(axis, value) => {
                const pos3d = { ...ensurePos3d(selectedItem), [axis]: value };
                onUpdateItem(selectedItem.id, { pos3d, ...pos3dToLegacy(pos3d) });
              }}
            />
            <DirectorInspectorVectorFields
              label={t('directorStudio.inspector.rotation')}
              value={{
                x: (selectedItem.rotation3d?.x ?? 0) * 180 / Math.PI,
                y: (selectedItem.rotation3d?.y ?? 0) * 180 / Math.PI,
                z: (selectedItem.rotation3d?.z ?? 0) * 180 / Math.PI,
              }}
              min={-180}
              max={180}
              step={1}
              suffix="°"
              onCommit={(axis, value) => onUpdateItem(selectedItem.id, { rotation3d: { ...(selectedItem.rotation3d ?? { x: 0, y: 0, z: 0 }), [axis]: value * Math.PI / 180 } })}
            />
            <DirectorInspectorVectorFields
              label={t('directorStudio.inspector.scale')}
              value={selectedItem.scale3d ?? { x: 1, y: 1, z: 1 }}
              min={0.1}
              max={5}
              step={0.05}
              onCommit={(axis, value) => onUpdateItem(selectedItem.id, { scale3d: { ...(selectedItem.scale3d ?? { x: 1, y: 1, z: 1 }), [axis]: value } })}
            />
            {selectedItem.category === 'person' ? <PersonBodyProperties item={selectedItem} onUpdateItem={onUpdateItem} /> : null}
            {onDeleteItem ? (
              <button type="button" onClick={() => onDeleteItem(selectedItem.id)} className={`${BUTTON_CLASS} w-full text-red-200 hover:border-red-300/40 hover:bg-red-500/15 active:bg-red-500/25`} title={t('directorStudio.previs.deleteObjectHelp')} data-director-tooltip={t('directorStudio.previs.deleteObjectHelp')}>
                <Trash2 className="h-3.5 w-3.5" />{t('directorStudio.previs.deleteObject')}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </aside>
  );
});

function PersonBodyProperties({ item, onUpdateItem }: {
  item: BlueprintItem;
  onUpdateItem: (id: string, patch: Partial<BlueprintItem>) => void;
}) {
  const { t } = useTranslation();
  const controls = normalizeBlueprintBodyControls(item.bodyControls);
  const update = (patch: Partial<BlueprintBodyControls>) => onUpdateItem(item.id, { bodyControls: { ...item.bodyControls, ...patch } });
  return (
    <details className="group rounded-md border border-white/10 bg-[#20242a]">
      <summary className="flex cursor-pointer list-none items-center justify-between p-3 font-medium text-white/80 transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/60">
        {t('directorStudio.inspector.body')}<ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
      </summary>
      <div className="space-y-4 border-t border-white/10 p-3">
        <label className="block text-white/60">
          <span className="mb-1.5 block">{t('directorStudio.inspector.bodyStyle')}</span>
          <select value={controls.style} onChange={(event) => {
            const style = DIRECTOR_STUDIO_BODY_STYLES.find((entry) => entry.value === event.target.value);
            if (style) update({ style: style.value });
          }} className={FIELD_CLASS}>
            {DIRECTOR_STUDIO_BODY_STYLES.map((style) => <option key={style.value} value={style.value}>{t(style.labelKey)}</option>)}
          </select>
        </label>
        <label className="flex items-center justify-between gap-2 text-white/65">
          {t('directorStudio.inspector.showControls')}
          <input type="checkbox" checked={controls.showControls} onChange={(event) => update({ showControls: event.target.checked })} className="h-3.5 w-3.5 accent-teal-400" />
        </label>
        <fieldset>
          <legend className="mb-2 font-medium text-white/80">{t('directorStudio.inspector.bodyCore')}</legend>
          <div className="grid grid-cols-2 gap-2">
            {([
              ['height', 'bodyHeight', 0.45, 1.8, 0.01],
              ['torsoWidth', 'torsoWidth', 0.45, 2.2, 0.01],
              ['headScale', 'headScale', 0.55, 1.8, 0.01],
              ['torsoLeanDeg', 'torsoLean', -45, 45, 1],
            ] as const).map(([field, label, min, max, step]) => (
              <DirectorInspectorNumberField key={field} label={t(`directorStudio.inspector.${label}`)} value={controls.core[field]} min={min} max={max} step={step} onCommit={(value) => update({ core: { ...item.bodyControls?.core, [field]: value } })} />
            ))}
          </div>
        </fieldset>
        {(['arms', 'legs'] as const).map((section) => (
          <fieldset key={section}>
            <legend className="mb-2 font-medium text-white/80">{t(section === 'arms' ? 'directorStudio.inspector.bodyArms' : 'directorStudio.inspector.bodyLegs')}</legend>
            <div className="grid grid-cols-2 gap-2">
              {([
                ['length', section === 'arms' ? 'armLength' : 'legLength', 0.45, 1.8, 0.01],
                ['thickness', section === 'arms' ? 'armThickness' : 'legThickness', 0.45, 2, 0.01],
                ['spreadDeg', section === 'arms' ? 'armSpread' : 'legSpread', section === 'arms' ? -35 : -25, 35, 1],
              ] as const).map(([field, label, min, max, step]) => (
                <DirectorInspectorNumberField key={field} label={t(`directorStudio.inspector.${label}`)} value={controls[section][field]} min={min} max={max} step={step} onCommit={(value) => update({ [section]: { ...item.bodyControls?.[section], [field]: value } })} />
              ))}
            </div>
          </fieldset>
        ))}
      </div>
    </details>
  );
}
