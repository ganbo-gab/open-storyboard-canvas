import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronUp, ChevronDown, Save, FolderOpen, Camera as CameraIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tooltip, UiButton, UiIconButton, UiModal, UiSwitch } from '@/components/ui';
import { type CameraControlOptions } from '@/features/canvas/domain/canvasNodes';
import {
  APERTURES,
  APERTURE_META,
  CAMERA_PROFILES,
  FOCAL_LENGTHS,
  FOCAL_LENGTH_META,
  LENS_PROFILES,
  buildCameraPrompt,
  type CameraProfile,
  type LensProfile,
} from '@/features/canvas/application/cameraPromptLibrary';
import { CameraPresetsPanel } from './CameraPresetsPanel';
import { useSettingsStore } from '@/stores/settingsStore';

interface CameraControlPanelProps {
  isOpen: boolean;
  onClose: () => void;
  cameraControl: CameraControlOptions | undefined;
  onApply: (cameraControl: CameraControlOptions, cameraPrompt: string) => void;
}

/** Per-body SVG renderer. We give each camera a unique silhouette/color so
 *  the user can visually tell them apart at a glance. */
function CameraBodySvg({ profile, className }: { profile: CameraProfile; className?: string }) {
  const body = profile.bodyColor;
  const accent = profile.accentColor;
  // A library of device silhouettes keyed by id; falls back to a generic look.
  const type = profile.id.split('_')[0];
  switch (profile.id) {
    case 'panavision_dxl2':
      // Boxy cinema body + matte box
      return (
        <svg viewBox="0 0 72 52" className={className} xmlns="http://www.w3.org/2000/svg" aria-hidden>
          <rect x="18" y="8" width="30" height="32" rx="3" fill={body} stroke={accent} strokeWidth="1.2" />
          <rect x="10" y="12" width="12" height="24" rx="2" fill="#1b1b1b" stroke={accent} />
          <rect x="48" y="14" width="16" height="20" rx="2" fill="#222" stroke={accent} />
          <circle cx="56" cy="24" r="6" fill="#0a0a0a" stroke={accent} />
          <rect x="26" y="3" width="14" height="6" rx="1" fill={body} />
          <rect x="20" y="42" width="26" height="4" rx="1" fill={accent} opacity="0.6" />
        </svg>
      );
    case 'arri_alexa_mini_lf':
      return (
        <svg viewBox="0 0 72 52" className={className} xmlns="http://www.w3.org/2000/svg" aria-hidden>
          <rect x="14" y="12" width="38" height="28" rx="4" fill={body} stroke={accent} />
          <circle cx="52" cy="26" r="10" fill="#111" stroke={accent} strokeWidth="1.2" />
          <circle cx="52" cy="26" r="6" fill="#2b2b2b" stroke="#666" />
          <rect x="20" y="6" width="18" height="8" rx="1.5" fill={body} />
          <rect x="18" y="18" width="8" height="6" rx="1" fill={accent} opacity="0.3" />
        </svg>
      );
    case 'red_komodo_6k':
    case 'red_v_raptor_8k': {
      const isRaptor = profile.id === 'red_v_raptor_8k';
      return (
        <svg viewBox="0 0 72 52" className={className} xmlns="http://www.w3.org/2000/svg" aria-hidden>
          <rect x="18" y="14" width={isRaptor ? '32' : '28'} height="26" rx="2" fill={body} stroke={accent} />
          <circle cx={isRaptor ? '50' : '46'} cy="27" r="9" fill="#050505" stroke={accent} />
          <circle cx={isRaptor ? '50' : '46'} cy="27" r="5" fill="#1a1a1a" stroke="#666" />
          <rect x="20" y="8" width="8" height="7" rx="1" fill={accent} opacity="0.85" />
          <text x={isRaptor ? '22' : '22'} y="36" fontSize="6" fill="#fff" fontWeight="bold">RED</text>
        </svg>
      );
    }
    case 'sony_venice_2':
    case 'sony_fx6':
      return (
        <svg viewBox="0 0 72 52" className={className} xmlns="http://www.w3.org/2000/svg" aria-hidden>
          <rect x="14" y="14" width="36" height="26" rx="3" fill={body} stroke={accent} />
          <circle cx="52" cy="27" r="9" fill="#050505" stroke={accent} />
          <rect x="16" y="18" width="6" height="6" rx="1" fill={accent} opacity="0.5" />
          <rect x="22" y="8" width="16" height="8" rx="1.5" fill={body} />
          <text x="22" y="36" fontSize="5.5" fill="#ccc">SONY</text>
        </svg>
      );
    case 'blackmagic_ursa_12k':
      return (
        <svg viewBox="0 0 72 52" className={className} xmlns="http://www.w3.org/2000/svg" aria-hidden>
          <rect x="16" y="12" width="32" height="28" rx="2" fill={body} stroke={accent} />
          <circle cx="50" cy="26" r="10" fill="#050505" stroke={accent} />
          <circle cx="50" cy="26" r="6" fill="#1a1a1a" stroke="#666" />
          <rect x="24" y="5" width="12" height="8" rx="1" fill={body} />
          <text x="18" y="35" fontSize="5" fill={accent} fontWeight="bold">URSA</text>
        </svg>
      );
    case 'canon_c500_mk2':
      return (
        <svg viewBox="0 0 72 52" className={className} xmlns="http://www.w3.org/2000/svg" aria-hidden>
          <rect x="16" y="12" width="34" height="28" rx="3" fill={body} stroke={accent} />
          <circle cx="50" cy="26" r="9" fill="#050505" stroke={accent} />
          <rect x="18" y="16" width="10" height="5" rx="1" fill={accent} opacity="0.7" />
          <text x="20" y="36" fontSize="5.5" fill="#eee">Canon</text>
        </svg>
      );
    default:
      // Generic placeholder — should not hit in practice.
      return (
        <svg viewBox="0 0 72 52" className={className} xmlns="http://www.w3.org/2000/svg" aria-hidden>
          <rect x="16" y="14" width="36" height="26" rx="3" fill={body} stroke={accent} />
          <circle cx="52" cy="27" r="9" fill="#0a0a0a" stroke={accent} />
          <text x="30" y="31" fontSize="6" fill="#888">{type}</text>
        </svg>
      );
  }
}

function LensBodySvg({ profile, className }: { profile: LensProfile; className?: string }) {
  const body = profile.lensColor;
  const ring = profile.ringColor;
  const rings = profile.id.startsWith('anamorphic') ? 4 : 3;
  return (
    <svg viewBox="0 0 72 44" className={className} xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <rect x="6" y="14" width="56" height="18" rx="3" fill={body} stroke="#444" />
      {Array.from({ length: rings }).map((_, i) => (
        <rect key={i} x={12 + i * 12} y="14" width="4" height="18" fill={ring} opacity="0.6" />
      ))}
      <circle cx="58" cy="23" r="7" fill="#050505" stroke={ring} strokeWidth="1.5" />
      <circle cx="58" cy="23" r="3.5" fill="#222" stroke="#888" />
      {profile.id.startsWith('anamorphic') && (
        <ellipse cx="58" cy="23" rx="7" ry="3" fill="none" stroke={ring} strokeWidth="0.8" opacity="0.7" />
      )}
    </svg>
  );
}

/** Shared tooltip owns delayed display, overlay cancellation and timer cleanup. */
interface HoverTipProps {
  title: string;
  description?: string;
  useCase?: string;
  children: React.ReactNode;
}
const HoverTip = memo(({ title, description, useCase, children }: HoverTipProps) => {
  return (
    <Tooltip delay={900} side="top" label={<span className="block max-w-64 whitespace-normal text-left">
      <span className="block text-xs font-semibold">{title}</span>
      {description && <span className="mt-1 block text-[11px] leading-5 text-text-muted">{description}</span>}
      {useCase && <span className="mt-2 block text-[11px] leading-5 text-text-muted">使用场景：{useCase}</span>}
    </span>}>
      {children}
    </Tooltip>
  );
});
HoverTip.displayName = 'HoverTip';

/** One interactive card column (camera/lens/focal/aperture). */
interface CardColumnProps {
  label: string;
  tooltipTitle: string;
  tooltipDesc?: string;
  tooltipUseCase?: string;
  visual: React.ReactNode;
  cornerBadge?: React.ReactNode;
  captionBelow: string;
  onPrev: () => void;
  onNext: () => void;
}
const CardColumn = memo(({ label, tooltipTitle, tooltipDesc, tooltipUseCase, visual, cornerBadge, captionBelow, onPrev, onNext }: CardColumnProps) => {
  return (
    <div className="flex flex-1 flex-col items-center gap-1.5">
      <UiIconButton
        size="sm"
        onClick={onPrev}
        className="h-5 w-full"
        title="上一项"
        aria-label="上一项"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </UiIconButton>
      <HoverTip title={tooltipTitle} description={tooltipDesc} useCase={tooltipUseCase}>
        <div className="relative flex h-[140px] w-[140px] flex-col items-center justify-between rounded-xl border border-[var(--line)] bg-[var(--field-bg)] px-3 pt-2 pb-2 hover:border-[var(--line-strong)] hover:bg-[var(--hover)] transition-colors duration-[var(--dur-1)] cursor-help">
          <span className="text-[11px] font-medium tracking-wide text-text-muted">{label}</span>
          <div className="flex flex-1 items-center justify-center w-full">{visual}</div>
          {cornerBadge && (
            <div className="absolute top-1.5 right-1.5 rounded-md bg-[var(--press)] px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
              {cornerBadge}
            </div>
          )}
        </div>
      </HoverTip>
      <UiIconButton
        size="sm"
        onClick={onNext}
        className="h-5 w-full"
        title="下一项"
        aria-label="下一项"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </UiIconButton>
      <span className="max-w-full truncate text-[11px] text-text-muted text-center leading-4">{captionBelow}</span>
    </div>
  );
});
CardColumn.displayName = 'CardColumn';

export const CameraControlPanel = memo(({ isOpen, onClose, cameraControl, onApply }: CameraControlPanelProps) => {
  const { t } = useTranslation();

  const [enabled, setEnabled] = useState<boolean>(cameraControl?.enabled === true);
  const [cameraIdx, setCameraIdx] = useState<number>(() => {
    const i = CAMERA_PROFILES.findIndex((c) => c.id === cameraControl?.camera);
    return i >= 0 ? i : 0;
  });
  const [lensIdx, setLensIdx] = useState<number>(() => {
    const i = LENS_PROFILES.findIndex((l) => l.id === cameraControl?.lens);
    return i >= 0 ? i : 0;
  });
  const [focal, setFocal] = useState<number>(cameraControl?.focalLength ?? 50);
  const [aperture, setAperture] = useState<number>(cameraControl?.aperture ?? 4);
  const [showPresets, setShowPresets] = useState(false);
  const [savePresetOnOpen, setSavePresetOnOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const nextCameraIdx = CAMERA_PROFILES.findIndex((c) => c.id === cameraControl?.camera);
    const nextLensIdx = LENS_PROFILES.findIndex((l) => l.id === cameraControl?.lens);
    setEnabled(cameraControl?.enabled === true);
    setCameraIdx(nextCameraIdx >= 0 ? nextCameraIdx : 0);
    setLensIdx(nextLensIdx >= 0 ? nextLensIdx : 0);
    setFocal(cameraControl?.focalLength ?? 50);
    setAperture(cameraControl?.aperture ?? 4);
    setShowPresets(false);
  }, [cameraControl, isOpen]);

  const currentCamera = CAMERA_PROFILES[cameraIdx];
  const currentLens = LENS_PROFILES[lensIdx];
  const focalMeta = FOCAL_LENGTH_META[focal];
  const apertureMeta = APERTURE_META[aperture];

  const summary = useMemo(() =>
    `${currentCamera.zhName} · ${currentLens.zhName} · ${focal}mm · f/${aperture}`,
  [currentCamera, currentLens, focal, aperture]);

  const cycleCamera = (dir: 1 | -1) => setCameraIdx((i) => (i + dir + CAMERA_PROFILES.length) % CAMERA_PROFILES.length);
  const cycleLens = (dir: 1 | -1) => setLensIdx((i) => (i + dir + LENS_PROFILES.length) % LENS_PROFILES.length);
  const cycleFocal = (dir: 1 | -1) => setFocal((f) => {
    const idx = FOCAL_LENGTHS.indexOf(f as typeof FOCAL_LENGTHS[number]);
    const nextIdx = (idx + dir + FOCAL_LENGTHS.length) % FOCAL_LENGTHS.length;
    return FOCAL_LENGTHS[nextIdx];
  });
  const cycleAperture = (dir: 1 | -1) => setAperture((a) => {
    const idx = APERTURES.indexOf(a as typeof APERTURES[number]);
    const nextIdx = (idx + dir + APERTURES.length) % APERTURES.length;
    return APERTURES[nextIdx];
  });

  const handleApply = useCallback(() => {
    const options: CameraControlOptions = {
      enabled,
      camera: currentCamera.id,
      lens: currentLens.id,
      focalLength: focal,
      aperture,
    };
    const prompt = enabled
      ? buildCameraPrompt({
          cameraId: options.camera,
          lensId: options.lens,
          focalLengthMm: options.focalLength,
          apertureF: options.aperture,
        }, useSettingsStore.getState())
      : '';
    onApply(options, prompt);
    onClose();
  }, [enabled, currentCamera, currentLens, focal, aperture, onApply, onClose]);

  if (!isOpen) return null;

  return <>
    <UiModal isOpen={isOpen} title={t('cameraControl.title')} onClose={onClose} widthClassName="w-[760px]"
      description="开启后，这些摄影设置会在生成时追加为提示词，用于引导机身质感、镜头、焦距和景深。"
      footer={<div className="flex w-full flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2">
          <UiButton size="sm" icon={<Save className="h-3.5 w-3.5" />} onClick={() => { setSavePresetOnOpen(true); setShowPresets(true); }}>{t('cameraControl.preset.saveAs')}</UiButton>
          <UiButton size="sm" icon={<FolderOpen className="h-3.5 w-3.5" />} onClick={() => { setSavePresetOnOpen(false); setShowPresets(true); }}>{t('cameraControl.preset.myPresets')}</UiButton>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-text-muted"><span>{enabled ? '开启' : '关闭'}</span><UiSwitch aria-label="启用摄像机控制" checked={enabled} onCheckedChange={setEnabled} /></label>
          <UiButton size="sm" variant="ghost" onClick={onClose}>{t('common.cancel')}</UiButton>
          <UiButton variant="primary" size="sm" icon={<CameraIcon className="h-3.5 w-3.5" />} onClick={handleApply}>{t('cameraControl.apply')}</UiButton>
        </div>
      </div>}>
      <div className="flex gap-3 overflow-x-auto py-4 justify-start sm:justify-center">
        <CardColumn
          label="相机"
          tooltipTitle={`${currentCamera.zhName} · ${currentCamera.label}`}
          tooltipDesc={currentCamera.description}
          tooltipUseCase={currentCamera.useCase}
          visual={<CameraBodySvg profile={currentCamera} className="h-16" />}
          captionBelow={`${currentCamera.zhName}`}
          onPrev={() => cycleCamera(-1)}
          onNext={() => cycleCamera(1)}
        />
        <CardColumn
          label="镜头"
          tooltipTitle={`${currentLens.zhName} · ${currentLens.label}`}
          tooltipDesc={currentLens.description}
          tooltipUseCase={currentLens.useCase}
          visual={<LensBodySvg profile={currentLens} className="h-14" />}
          captionBelow={`${currentLens.zhName}`}
          onPrev={() => cycleLens(-1)}
          onNext={() => cycleLens(1)}
        />
        <CardColumn
          label="焦距"
          tooltipTitle={`${focal}mm · ${focalMeta?.zhName ?? ''}`}
          tooltipDesc={focalMeta?.description}
          tooltipUseCase={focalMeta?.useCase}
          visual={
            <div className="flex flex-col items-center">
              <div className="text-[40px] font-light leading-none text-text-dark">{focal}</div>
              <div className="mt-1 text-[10px] tracking-wider text-text-subtle">mm</div>
            </div>
          }
          cornerBadge={focalMeta?.zhName}
          captionBelow={`${focalMeta?.zhName ?? ''}`}
          onPrev={() => cycleFocal(-1)}
          onNext={() => cycleFocal(1)}
        />
        <CardColumn
          label="光圈"
          tooltipTitle={`f/${aperture} · ${apertureMeta?.zhName ?? ''}`}
          tooltipDesc={apertureMeta?.description}
          tooltipUseCase={apertureMeta?.useCase}
          visual={
            <div className="flex flex-col items-center">
              <div className="text-[30px] font-light leading-none text-text-dark">
                <span className="text-text-subtle text-[18px]">f/</span>{aperture}
              </div>
              <div className="mt-1 text-[10px] tracking-wider text-text-subtle">aperture</div>
            </div>
          }
          cornerBadge={apertureMeta?.zhName}
          captionBelow={`${apertureMeta?.zhName ?? ''}`}
          onPrev={() => cycleAperture(-1)}
          onNext={() => cycleAperture(1)}
        />
      </div>

      <div className="mb-3 rounded-lg border border-[var(--line)] bg-[var(--field-bg)] px-3.5 py-2.5">
        <div className="text-[10px] uppercase tracking-wide text-text-subtle">当前配置</div>
        <div className="mt-0.5 text-xs text-text-dark">{summary}</div>
      </div>

    </UiModal>
      <CameraPresetsPanel
        isOpen={showPresets}
        onClose={() => setShowPresets(false)}
        currentCameraControl={{
          enabled,
          camera: currentCamera.id,
          lens: currentLens.id,
          focalLength: focal,
          aperture,
        }}
        openWithSaveDialog={savePresetOnOpen}
        onApply={(cc) => {
          const ci = CAMERA_PROFILES.findIndex((c) => c.id === cc.camera);
          const li = LENS_PROFILES.findIndex((l) => l.id === cc.lens);
          if (ci >= 0) setCameraIdx(ci);
          if (li >= 0) setLensIdx(li);
          setFocal(cc.focalLength);
          setAperture(cc.aperture);
          setEnabled(cc.enabled === true);
        }}
      />
  </>;
});

CameraControlPanel.displayName = 'CameraControlPanel';
