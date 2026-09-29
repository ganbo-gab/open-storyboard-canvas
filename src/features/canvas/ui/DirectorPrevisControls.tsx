import { useState } from 'react';
import { Box, Camera, Check, Clapperboard, Crosshair, Eye, EyeOff, Lightbulb, Maximize2, MousePointer2, Move3d, Pencil, Rotate3d, RotateCcw, Route, Scaling, Sparkles, UserRound, X, HelpCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BlueprintItem, DirectorStudioTransformMode } from '@/features/canvas/domain/canvasNodes';
import { DIRECTOR_CAMERA_PRESETS, type DirectorCameraPresetId } from '@/features/canvas/application/directorMotion';
import type { DirectorMotionRouteDraft } from './BlueprintScene';
import { DirectorPrevisButton } from './DirectorPrevisButton';
import { useModalFocus } from '@/components/ui/useModalFocus';

type Props = {
  selectedItem: BlueprintItem | null;
  transformMode: DirectorStudioTransformMode | null;
  routeDraft: DirectorMotionRouteDraft | null;
  routeTargetLabel: string;
  previewMode: 'route' | 'shot';
  showRoutes: boolean;
  pilotActive: boolean;
  hasPersonRoute: boolean;
  onTransformMode: (mode: DirectorStudioTransformMode | null) => void;
  onStartRoute: (draft: DirectorMotionRouteDraft) => void;
  onFinishRoute: () => void;
  onCancelRoute: () => void;
  onAddPerson: () => void;
  onOpenModels: () => void;
  onSelectCamera: () => void;
  onOpenActions: () => void;
  onOpenLighting: () => void;
  onPreviewMode: (mode: 'route' | 'shot') => void;
  onShowRoutes: (show: boolean) => void;
  onResetView: () => void;
  onFitView: () => void;
  onFocusItem: () => void;
  onTogglePilot: () => void;
  onCameraPreset: (preset: DirectorCameraPresetId, targetItemId?: string | null) => void;
};

export function DirectorPrevisControls(props: Props) {
  const { t } = useTranslation();
  const [helpOpen, setHelpOpen] = useState(false);
  const [cameraMenuOpen, setCameraMenuOpen] = useState(false);
  const [cameraSubject, setCameraSubject] = useState<{ id: string | null; hasRoute: boolean }>({ id: null, hasRoute: false });
  const helpFocus = useModalFocus({ isOpen: helpOpen, onClose: () => setHelpOpen(false) });
  const person = props.selectedItem?.category === 'person' ? props.selectedItem : null;
  const targetLabel = person?.label ?? t('directorStudio.motion.timeline.camera');
  const routeAllowed = !props.selectedItem || Boolean(person);
  const selectFirst = t('directorStudio.previs.selectFirst');
  const startRoute = (method: 'points' | 'draw') => {
    props.onTransformMode(null);
    props.onStartRoute({ kind: person ? 'object' : 'camera', trackId: person?.id ?? 'camera', method });
    setCameraMenuOpen(false);
  };
  const cancelTools = () => {
    props.onCancelRoute();
    props.onTransformMode(null);
  };
  const chooseTransform = (mode: DirectorStudioTransformMode) => {
    props.onCancelRoute();
    props.onTransformMode(props.transformMode === mode ? null : mode);
  };
  const toolClass = 'h-[52px] w-full flex-col !gap-1 !px-1 !py-1.5';
  return (
    <div className="pointer-events-none absolute inset-0 z-30" aria-label={t('directorStudio.previs.tools')} onKeyDown={(event) => {
      if (event.key === 'Escape' && cameraMenuOpen) {
        event.preventDefault();
        event.stopPropagation();
        setCameraMenuOpen(false);
      }
    }}>
      <nav className="pointer-events-auto ui-scrollbar absolute left-3 top-3 max-h-[calc(100%-60px)] w-[112px] overflow-y-auto rounded-xl border border-white/10 bg-[#202329]/95 p-1.5 shadow-xl" aria-label={t('directorStudio.previs.tools')}>
        <div className="grid grid-cols-2 gap-1">
          <DirectorPrevisButton className={toolClass} label={t('directorStudio.previs.select')} description={t('directorStudio.previs.selectHelp')} icon={<MousePointer2 size={18} />} active={!props.transformMode && !props.routeDraft} onClick={cancelTools} />
          <DirectorPrevisButton className={toolClass} label={t('directorStudio.previs.move')} description={t('directorStudio.previs.moveHelp')} icon={<Move3d size={18} />} shortcut="1" disabled={!props.selectedItem} disabledReason={selectFirst} active={props.transformMode === 'move'} onClick={() => chooseTransform('move')} />
          <DirectorPrevisButton className={toolClass} label={t('directorStudio.previs.rotate')} description={t('directorStudio.previs.rotateHelp')} icon={<Rotate3d size={18} />} shortcut="2" disabled={!props.selectedItem} disabledReason={selectFirst} active={props.transformMode === 'rotate'} onClick={() => chooseTransform('rotate')} />
          <DirectorPrevisButton className={toolClass} label={t('directorStudio.previs.scale')} description={t('directorStudio.previs.scaleHelp')} icon={<Scaling size={18} />} shortcut="3" disabled={!props.selectedItem} disabledReason={selectFirst} active={props.transformMode === 'scale'} onClick={() => chooseTransform('scale')} />
        </div>
        <div className="my-2 border-t border-white/10" />
        <div className="grid grid-cols-2 gap-1">
          <DirectorPrevisButton className={toolClass} label={t('directorStudio.previs.draw')} description={t('directorStudio.previs.drawHelp', { name: targetLabel })} icon={<Pencil size={18} />} active={props.routeDraft?.method === 'draw'} disabled={!routeAllowed} disabledReason={t('directorStudio.previs.routePersonOnly')} onClick={() => startRoute('draw')} />
          <DirectorPrevisButton className={toolClass} label={t('directorStudio.previs.points')} description={t('directorStudio.previs.pointsHelp', { name: targetLabel })} icon={<Route size={18} />} active={props.routeDraft?.method === 'points'} disabled={!routeAllowed} disabledReason={t('directorStudio.previs.routePersonOnly')} onClick={() => startRoute('points')} />
        </div>
        <div className="my-2 border-t border-white/10" />
        <div className="grid grid-cols-2 gap-1">
          <DirectorPrevisButton className={toolClass} label={t('directorStudio.previs.person')} description={t('directorStudio.previs.personHelp')} icon={<UserRound size={18} />} onClick={props.onAddPerson} />
          <DirectorPrevisButton className={toolClass} label={t('directorStudio.previs.models')} description={t('directorStudio.previs.modelsHelp')} icon={<Box size={18} />} onClick={props.onOpenModels} />
          <DirectorPrevisButton className={toolClass} label={t('directorStudio.previs.camera')} description={t('directorStudio.previs.cameraHelp')} icon={<Camera size={18} />} active={!props.selectedItem} onClick={() => { setCameraSubject({ id: props.selectedItem?.id ?? null, hasRoute: props.hasPersonRoute }); cancelTools(); props.onSelectCamera(); setCameraMenuOpen(true); }} />
          <DirectorPrevisButton className={toolClass} label={t('directorStudio.previs.actions')} description={t('directorStudio.previs.actionsHelp')} icon={<Sparkles size={18} />} disabled={!person} disabledReason={t('directorStudio.motion.library.selectPerson')} onClick={props.onOpenActions} />
          <DirectorPrevisButton className={toolClass} label={t('directorStudio.previs.lighting')} description={t('directorStudio.previs.lightingHelp')} icon={<Lightbulb size={18} />} onClick={props.onOpenLighting} />
          <DirectorPrevisButton className={toolClass} label={t('directorStudio.previs.help')} description={t('directorStudio.previs.helpDescription')} icon={<HelpCircle size={18} />} active={helpOpen} onClick={() => setHelpOpen(!helpOpen)} />
        </div>
      </nav>
      <div className="pointer-events-auto absolute right-3 top-3 flex max-w-[calc(100%-150px)] flex-wrap justify-end gap-1.5 rounded-lg border border-white/10 bg-[#202329]/95 p-1.5 shadow-lg">
        <DirectorPrevisButton compact label={t('directorStudio.motion.timeline.routePreview')} description={t('directorStudio.previs.routeViewHelp')} icon={<Route size={15} />} active={props.previewMode === 'route'} onClick={() => props.onPreviewMode('route')} />
        <DirectorPrevisButton compact label={t('directorStudio.motion.timeline.shotPreview')} description={t('directorStudio.previs.shotViewHelp')} icon={<Clapperboard size={15} />} active={props.previewMode === 'shot'} onClick={() => props.onPreviewMode('shot')} />
        <DirectorPrevisButton compact showLabel={false} label={t(props.showRoutes ? 'directorStudio.motion.timeline.hideRoutes' : 'directorStudio.motion.timeline.showRoutes')} icon={props.showRoutes ? <Eye size={16} /> : <EyeOff size={16} />} onClick={() => props.onShowRoutes(!props.showRoutes)} />
        <DirectorPrevisButton compact showLabel={false} label={t('directorStudio.scene.fitAll')} description={t('directorStudio.scene.fitAllTitle')} icon={<Maximize2 size={16} />} onClick={props.onFitView} />
        <DirectorPrevisButton compact showLabel={false} label={t('directorStudio.scene.reset')} description={t('directorStudio.scene.resetView')} icon={<RotateCcw size={16} />} onClick={props.onResetView} />
        {props.selectedItem ? <DirectorPrevisButton compact showLabel={false} label={t('directorStudio.previs.focus')} icon={<Crosshair size={16} />} onClick={props.onFocusItem} /> : null}
        {props.hasPersonRoute ? <DirectorPrevisButton compact label={t('directorStudio.previs.follow')} description={t('directorStudio.motion.cameraPresets.followActorRoute')} icon={<Camera size={15} />} onClick={() => props.onCameraPreset('follow-actor-route')} /> : null}
      </div>
      {cameraMenuOpen ? (
        <section className="pointer-events-auto absolute bottom-12 left-[138px] top-16 flex w-[240px] flex-col rounded-lg border border-white/15 bg-[#202329] p-3 shadow-2xl" aria-label={t('directorStudio.motion.cameraPresets.title')}>
          <div className="mb-3 flex items-center justify-between text-xs font-medium">
            {t('directorStudio.motion.cameraPresets.title')}
            <DirectorPrevisButton compact showLabel={false} label={t('common.close')} icon={<X size={15} />} onClick={() => setCameraMenuOpen(false)} />
          </div>
          <div className="ui-scrollbar min-h-0 space-y-1 overflow-y-auto">
            {DIRECTOR_CAMERA_PRESETS.map((preset) => <DirectorPrevisButton key={preset.id} wrapperClassName="w-full" className="w-full justify-start" label={t(preset.labelKey)} icon={<Camera size={15} />} disabled={preset.id === 'follow-actor-route' && !cameraSubject.hasRoute} disabledReason={t('directorStudio.previs.followHelp')} onClick={() => { props.onCameraPreset(preset.id as DirectorCameraPresetId, cameraSubject.id); setCameraMenuOpen(false); }} />)}
          </div>
          <div className="mt-2 border-t border-white/10 pt-2">
            <DirectorPrevisButton wrapperClassName="w-full" className="w-full" label={t(props.pilotActive ? 'directorStudio.motion.pilot.exit' : 'directorStudio.motion.pilot.enter')} description={t('directorStudio.motion.pilot.help')} icon={<Crosshair size={16} />} active={props.pilotActive} onClick={props.onTogglePilot} />
          </div>
        </section>
      ) : null}
      {props.routeDraft ? (
        <div className="pointer-events-auto absolute bottom-11 left-[138px] right-3 flex items-center gap-3 rounded-lg border border-amber-300/35 bg-[#302b20]/95 p-3 shadow-lg" role="status">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-amber-100">{t('directorStudio.previs.drawingFor', { name: props.routeTargetLabel })}</p>
            <p className="mt-1 text-xs leading-5 text-white/70">{t(props.routeDraft.method === 'points' ? 'directorStudio.motion.route.hintPoints' : 'directorStudio.motion.route.hintDraw')}</p>
          </div>
          {props.routeDraft.method === 'points' ? <DirectorPrevisButton label={t('directorStudio.motion.route.finish')} icon={<Check size={16} />} onClick={props.onFinishRoute} /> : null}
          <DirectorPrevisButton compact showLabel={false} label={t('directorStudio.motion.route.cancel')} icon={<X size={16} />} onClick={props.onCancelRoute} />
        </div>
      ) : null}
      <div className="absolute inset-x-0 bottom-0 flex h-9 items-center justify-between gap-2 border-t border-white/8 bg-[#171a1f]/95 px-4 text-[11px] text-white/55">
        <span>{t('directorStudio.previs.navigationHint')}</span>
        <span className="truncate text-white/75">{t('directorStudio.previs.currentTarget', { name: targetLabel })}</span>
      </div>
      {helpOpen ? (
        <div className="pointer-events-auto absolute inset-0 z-50 flex items-center justify-center bg-black/55 p-5" onPointerDown={(event) => event.stopPropagation()}>
          <div ref={helpFocus.dialogRef} onKeyDown={helpFocus.onKeyDown} data-previs-help role="dialog" aria-modal="true" aria-label={t('directorStudio.previs.help')} className="max-h-full w-[480px] overflow-y-auto rounded-xl border border-white/15 bg-[#202329] p-5 shadow-2xl">
            <div className="mb-5 flex items-center justify-between"><h2 className="text-base font-semibold">{t('directorStudio.previs.helpTitle')}</h2><DirectorPrevisButton compact showLabel={false} label={t('common.close')} icon={<X size={18} />} onClick={() => setHelpOpen(false)} /></div>
            {['helpStep1', 'helpStep2', 'helpStep3', 'helpStep4'].map((key, index) => <div key={key} className="mb-4 flex gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/20 text-xs text-accent">{index + 1}</span><p className="text-sm leading-6 text-white/80">{t(`directorStudio.previs.${key}`)}</p></div>)}
          </div>
        </div>
      ) : null}
    </div>
  );
}
