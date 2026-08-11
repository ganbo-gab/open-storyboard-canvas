import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronUp, ChevronDown, Save, FolderOpen, Camera as CameraIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

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

/** A 900ms delayed tooltip shown on hover. Rendered into a portal with fixed
 *  positioning so it can escape ancestor `overflow: hidden` (the outer panel
 *  has rounded corners + overflow-hidden, which would otherwise clip the
 *  tooltip's top edge when cards near the panel's top-left spawn an upward tip). */
interface HoverTipProps {
  title: string;
  description?: string;
  useCase?: string;
  children: React.ReactNode;
}
const HoverTip = memo(({ title, description, useCase, children }: HoverTipProps) => {
  const [coords, setCoords] = useState<
    | { left: number; top: number; placement: 'top' | 'bottom' }
    | null
  >(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);

  // Pick placement by where the anchor sits vertically in the viewport:
  // upper half → tooltip goes BELOW (more room); lower half → goes ABOVE.
  // This avoids the case where a tooltip anchored high in the panel overflows
  // past the viewport top and gets hidden behind the panel header.
  const computePlacement = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const tooltipWidth = 260;
    const margin = 10;
    let left = rect.left + rect.width / 2 - tooltipWidth / 2;
    left = Math.max(margin, Math.min(window.innerWidth - tooltipWidth - margin, left));
    const anchorCenter = rect.top + rect.height / 2;
    const placement: 'top' | 'bottom' = anchorCenter > window.innerHeight * 0.55 ? 'top' : 'bottom';
    const top = placement === 'top' ? rect.top - margin : rect.bottom + margin;
    return { left, top, placement };
  }, []);

  // After mount, re-measure real tooltip height and if the chosen placement
  // overshoots a viewport edge, flip to the opposite side and re-clamp.
  useEffect(() => {
    if (!coords) return;
    const tip = tipRef.current;
    const anchor = anchorRef.current;
    if (!tip || !anchor) return;
    const tipH = tip.getBoundingClientRect().height;
    const rect = anchor.getBoundingClientRect();
    const margin = 10;
    let placement = coords.placement;
    if (placement === 'top' && rect.top - tipH - margin < 0) placement = 'bottom';
    else if (placement === 'bottom' && rect.bottom + tipH + margin > window.innerHeight) placement = 'top';
    if (placement !== coords.placement) {
      const top = placement === 'top' ? rect.top - margin : rect.bottom + margin;
      setCoords((c) => (c ? { ...c, placement, top } : c));
    }
  }, [coords]);

  const handleEnter = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      const c = computePlacement();
      if (c) setCoords(c);
    }, 900);
  };
  const handleLeave = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setCoords(null);
  };

  return (
    <div ref={anchorRef} className="relative" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      {children}
      {coords &&
        createPortal(
          <div
            ref={tipRef}
            className="pointer-events-none fixed z-[20000] w-[260px] rounded-lg border border-white/15 bg-[#1a1a1a]/98 p-3 shadow-2xl"
            style={{
              left: `${coords.left}px`,
              top: coords.placement === 'bottom' ? `${coords.top}px` : undefined,
              bottom:
                coords.placement === 'top'
                  ? `${window.innerHeight - coords.top}px`
                  : undefined,
            }}
          >
            <div className="text-[12px] font-semibold text-white/95">{title}</div>
            {description && (
              <div className="mt-1 text-[11px] text-white/70 leading-5">{description}</div>
            )}
            {useCase && (
              <div className="mt-2 rounded bg-white/5 px-2 py-1 text-[10px] text-white/55">
                使用场景：{useCase}
              </div>
            )}
          </div>,
          document.body
        )}
    </div>
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
      <button
        type="button"
        onClick={onPrev}
        className="flex h-5 w-full items-center justify-center rounded-md text-white/35 hover:bg-white/5 hover:text-white/80 transition-colors"
        title="上一项"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <HoverTip title={tooltipTitle} description={tooltipDesc} useCase={tooltipUseCase}>
        <div className="relative flex h-[140px] w-[140px] flex-col items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-3 pt-2 pb-2 hover:border-white/25 hover:bg-white/[0.06] transition-colors cursor-help">
          <span className="text-[11px] font-medium tracking-wide text-white/55">{label}</span>
          <div className="flex flex-1 items-center justify-center w-full">{visual}</div>
          {cornerBadge && (
            <div className="absolute top-1.5 right-1.5 rounded-md bg-black/50 px-1.5 py-0.5 text-[10px] font-medium text-white/80">
              {cornerBadge}
            </div>
          )}
        </div>
      </HoverTip>
      <button
        type="button"
        onClick={onNext}
        className="flex h-5 w-full items-center justify-center rounded-md text-white/35 hover:bg-white/5 hover:text-white/80 transition-colors"
        title="下一项"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <span className="max-w-full truncate text-[11px] text-white/70 text-center leading-4">{captionBelow}</span>
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

  useEffect(() => {
    if (!isOpen) return;
    const nextCameraIdx = CAMERA_PROFILES.findIndex((c) => c.id === cameraControl?.camera);
    const nextLensIdx = LENS_PROFILES.findIndex((l) => l.id === cameraControl?.lens);
    setEnabled(cameraControl?.enabled === true);
    setCameraIdx(nextCameraIdx >= 0 ? nextCameraIdx : 0);
    setLensIdx(nextLensIdx >= 0 ? nextLensIdx : 0);
    setFocal(cameraControl?.focalLength ?? 50);
    setAperture(cameraControl?.aperture ?? 4);
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

  return (
    <div
      className="absolute bottom-full left-0 z-50 mb-2 w-[760px] overflow-hidden rounded-2xl border border-white/10 bg-[#151515]/96 shadow-2xl backdrop-blur-md"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between border-b border-white/8 px-5 py-3">
        <h2 className="text-sm font-semibold text-white/95">{t('cameraControl.title')}</h2>
        <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-md text-white/50 hover:bg-white/10 hover:text-white/90" title="关闭">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex gap-3 px-5 py-5 justify-center">
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
              <div className="text-[40px] font-light leading-none text-white/95">{focal}</div>
              <div className="mt-1 text-[10px] tracking-wider text-white/40">mm</div>
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
              <div className="text-[30px] font-light leading-none text-white/95">
                <span className="text-white/50 text-[18px]">f/</span>{aperture}
              </div>
              <div className="mt-1 text-[10px] tracking-wider text-white/40">aperture</div>
            </div>
          }
          cornerBadge={apertureMeta?.zhName}
          captionBelow={`${apertureMeta?.zhName ?? ''}`}
          onPrev={() => cycleAperture(-1)}
          onNext={() => cycleAperture(1)}
        />
      </div>

      <div className="mx-5 mb-3 rounded-lg border border-white/8 bg-white/[0.03] px-3.5 py-2.5">
        <div className="text-[10px] uppercase tracking-wide text-white/40">当前配置</div>
        <div className="mt-0.5 text-xs text-white/90">{summary}</div>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-white/8 bg-black/20 px-5 py-3">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setShowPresets(true)}
            className="flex items-center gap-1 rounded-md bg-white/8 px-3 py-1.5 text-xs text-white/80 hover:bg-white/14"
            title="保存当前配置为预设"
          >
            <Save className="h-3 w-3" /> {t('cameraControl.preset.saveAs')}
          </button>
          <button
            type="button"
            onClick={() => setShowPresets(true)}
            className="flex items-center gap-1 rounded-md bg-white/8 px-3 py-1.5 text-xs text-white/80 hover:bg-white/14"
            title="载入已保存的预设"
          >
            <FolderOpen className="h-3 w-3" /> {t('cameraControl.preset.myPresets')}
          </button>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2" title={enabled ? '当前启用摄像机控制' : '当前关闭摄像机控制'}>
            <span className={`text-xs transition-colors ${enabled ? 'text-emerald-400 font-medium' : 'text-white/45'}`}>
              {enabled ? '开启' : '关闭'}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={() => setEnabled((v) => !v)}
              className={`relative inline-flex h-6 w-11 cursor-pointer items-center rounded-full transition-colors ${enabled ? 'bg-emerald-500/95' : 'bg-white/15'}`}
            >
              <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
            </button>
          </div>

          <button
            type="button"
            onClick={handleApply}
            className="rounded-md bg-white px-4 py-1.5 text-xs font-medium text-black transition-[background-color,transform] duration-150 hover:bg-white/95 active:scale-95"
          >
            <CameraIcon className="mr-1 inline h-3 w-3" />
            {t('cameraControl.apply')}
          </button>
        </div>
      </div>

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
        openWithSaveDialog={false}
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
    </div>
  );
});

CameraControlPanel.displayName = 'CameraControlPanel';
