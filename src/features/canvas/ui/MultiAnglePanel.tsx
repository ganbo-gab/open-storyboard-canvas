import { memo, useState, useCallback, useEffect } from 'react';
import { X, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { UiButton, UiChipButton, UiIconButton, UiSegmented, UiSlider, UiSwitch, UiTextArea } from '@/components/ui';
import {
  buildMultiAnglePromptFromTemplate,
} from '@/features/canvas/application/panelPromptBuilders';
import {
  DEFAULT_MULTI_ANGLE_PROMPT_TEMPLATE,
  useSettingsStore,
} from '@/stores/settingsStore';
import { CameraSphereControl, type CameraSphericalPosition } from './CameraSphereControl';
import { PromptTemplateDialog } from './PromptTemplateDialog';
import { ModelConfigPicker } from './ModelConfigPicker';

export interface MultiAngleControlOptions {
  enabled: boolean;
  horizontal: number;
  vertical: number;
  shotSize: string;
  promptEnabled: boolean;
}

export type ShotSizeType =
  | 'extreme close-up'
  | 'close-up'
  | 'medium close-up'
  | 'medium shot'
  | 'medium full shot'
  | 'full shot'
  | 'long shot';

export type MultiAnglePromptMode = 'universal' | 'singlePerson' | 'action' | 'multiPerson';

const PROMPT_MODES: { id: MultiAnglePromptMode; label: string; hint: string }[] = [
  { id: 'universal', label: '通用', hint: '大多数图先试这个，整体最稳' },
  { id: 'singlePerson', label: '单人', hint: '单人图更稳住身份、脸和朝向' },
  { id: 'action', label: '动作', hint: '动作图更稳住姿势、手势和肢体' },
  { id: 'multiPerson', label: '多人', hint: '双人/多人图更稳住人数和关系' },
];

function resolveModePrompt(mode: MultiAnglePromptMode): string {
  switch (mode) {
    case 'singlePerson':
      return 'single person only, preserve the same face identity, facial structure, hairstyle, clothing silhouette, and portrait likeness';
    case 'action':
      return 'preserve the original action moment, gesture silhouette, body pose, limb placement, hand structure, and shoulder-arm connection, no missing limbs or fused hands';
    case 'multiPerson':
      return 'keep exactly the same number of people as the reference image, and when the source is a two-person confrontation preserve exactly one left subject and one right subject only, preserve each character as a separate individual with stable identity, preserve left-right order, relative distance, facing direction, eyeline relationship, and confrontation geometry, no extra people, no duplicated people, no cloned faces or bodies, no mirrored extra pair, no repeated confrontation pair, no duplicated opponent, no identity swapping between subjects, no merged characters, and no collapsed two-person scene into one person';
    default:
      return 'preserve the main subject, overall scene identity, and composition logic from the input image';
  }
}

function resolveModeCameraConstraint(mode: MultiAnglePromptMode): string {
  switch (mode) {
    case 'singlePerson':
      return 'prioritize facial identity and correct head rotation for the requested camera angle';
    case 'action':
      return 'prioritize body action fidelity and anatomically correct pose changes over stylized reinterpretation';
    case 'multiPerson':
      return 'prioritize exact subject count, stable per-subject identity, clear per-person separation, and confrontation relationship fidelity over stylized composition changes';
    default:
      return 'balance identity, scene continuity, and camera-angle fidelity';
  }
}

function resolveModeShotPrompt(mode: MultiAnglePromptMode): string {
  switch (mode) {
    case 'singlePerson':
      return 'do not accidentally convert the image into a generic ID photo or beauty portrait';
    case 'action':
      return 'do not collapse the image into a static portrait study';
    case 'multiPerson':
      return 'do not collapse the scene into a single-person portrait, do not duplicate the group, and do not replace a confrontation pair with mirrored, cloned, identity-swapped, or overlapping fused subjects';
    default:
      return 'do not replace the scene with a generic restaged portrait';
  }
}

function resolveCameraMeta(horizontal: number, vertical: number, mode: MultiAnglePromptMode): string {
  return `[camera H:${horizontal}° V:${vertical}° mode:${mode}]`;
}

function resolvePromptSegments(
  horizontal: number,
  vertical: number,
  shotSize: ShotSizeType,
  mode: MultiAnglePromptMode,
  selectedPreset: string
) {
  const presetPrompt = ANGLE_PRESETS.find((p) => p.id === selectedPreset)?.id === 'custom'
    ? ''
    : (ANGLE_PRESETS.find((p) => p.id === selectedPreset)?.prompt ?? '');

  return {
    presetPrompt,
    consistencyPrompt: resolveConsistencyPrompt(horizontal, vertical, mode),
    horizontalPrompt: resolveHorizontalPrompt(horizontal),
    verticalPrompt: resolveVerticalPrompt(vertical),
    shotSizePrompt: SHOT_SIZES.find((s) => s.id === shotSize)?.prompt ?? '',
    cameraMeta: resolveCameraMeta(horizontal, vertical, mode),
  };
}

function buildPromptFromState(
  horizontal: number,
  vertical: number,
  shotSize: ShotSizeType,
  mode: MultiAnglePromptMode,
  selectedPreset: string,
  template: string,
  promptEnabled: boolean,
  extraPrompt: string
): string {
  const segments = resolvePromptSegments(horizontal, vertical, shotSize, mode, selectedPreset);
  const basePrompt = buildMultiAnglePromptFromTemplate({
    template,
    consistencyPrompt: segments.consistencyPrompt,
    presetPrompt: segments.presetPrompt,
    horizontalPrompt: segments.horizontalPrompt,
    verticalPrompt: segments.verticalPrompt,
    shotSizePrompt: segments.shotSizePrompt,
    cameraMeta: segments.cameraMeta,
  });

  if (promptEnabled && extraPrompt.trim()) {
    return [basePrompt, extraPrompt.trim()].filter(Boolean).join(', ');
  }

  return basePrompt;
}

// Shot size display labels and prompts
const SHOT_SIZES: { id: ShotSizeType; label: string; prompt: string }[] = [
  { id: 'extreme close-up', label: '特写', prompt: 'extreme close-up, ECU, detail shot, intimate framing' },
  { id: 'close-up', label: '近景', prompt: 'close-up, CU, headshot, emotional portrait, tight framing' },
  { id: 'medium close-up', label: '中近景', prompt: 'medium close-up, MCU, chest up framing, conversational shot' },
  { id: 'medium shot', label: '中景', prompt: 'medium shot, MS, waist up framing, standard coverage' },
  { id: 'medium full shot', label: '中全景', prompt: 'medium full shot, MFS, three-quarter length, knees up framing' },
  { id: 'full shot', label: '全景', prompt: 'full shot, FS, full body in frame, environmental context' },
  { id: 'long shot', label: '远景', prompt: 'long shot, LS, establishing shot, wide establishing, extreme wide' },
];

// Slider display value for shot size
const SHOT_SIZE_VALUES: Record<ShotSizeType, number> = {
  'extreme close-up': 0,
  'close-up': 1,
  'medium close-up': 2,
  'medium shot': 3,
  'medium full shot': 4,
  'full shot': 5,
  'long shot': 6,
};

const SHOT_SIZE_FROM_VALUE: ShotSizeType[] = [
  'extreme close-up',
  'close-up',
  'medium close-up',
  'medium shot',
  'medium full shot',
  'full shot',
  'long shot',
];

const HORIZONTAL_TICKS = [0, 45, 90, 135, 180, 225, 270, 315, 360];
const VERTICAL_TICKS = [-90, -60, -30, 0, 30, 60, 90];
const SNAP_THRESHOLD = 6;

// Camera angle presets (matching libtv: 自定义, 鱼眼视角, 倾斜视角, 正面俯拍, 正面仰拍, 全景俯拍, 背面视角)
const ANGLE_PRESETS: {
  id: string;
  label: string;
  position: CameraSphericalPosition;
  shotSize: ShotSizeType;
  prompt: string;
  extraPromptDefault: string;
}[] = [
  { id: 'custom', label: '自定义', position: { horizontal: 0, vertical: 0 }, shotSize: 'medium shot', prompt: '', extraPromptDefault: '' },
  { id: 'fishEye', label: '鱼眼视角', position: { horizontal: 0, vertical: 30 }, shotSize: 'extreme close-up', prompt: 'fisheye lens, ultra wide 180 degree barrel distortion, exaggerated perspective, curved edge distortion, immersive close portrait', extraPromptDefault: '极度特写镜头，广角镜头，边缘带有鱼眼畸变效果' },
  { id: 'tilted', label: '倾斜视角', position: { horizontal: 45, vertical: -30 }, shotSize: 'medium shot', prompt: 'Dutch angle, canted frame, tilted horizon, diagonal composition, slight low angle portrait', extraPromptDefault: 'dutch angle, tilted frame, diagonal composition' },
  { id: 'frontOverhead', label: '正面俯拍', position: { horizontal: 0, vertical: 60 }, shotSize: 'medium shot', prompt: 'front overhead shot, high angle portrait, camera above subject, downward perspective, looking down at subject', extraPromptDefault: '' },
  { id: 'lowAngle', label: '正面仰拍', position: { horizontal: 0, vertical: -30 }, shotSize: 'medium shot', prompt: 'front low angle shot, camera below subject, upward perspective, heroic portrait, looking up at subject', extraPromptDefault: '' },
  { id: 'panorama', label: '全景俯拍', position: { horizontal: 45, vertical: 30 }, shotSize: 'full shot', prompt: 'wide high angle shot, full shot framing, more environment visible, slight overhead perspective, cinematic wide portrait', extraPromptDefault: '' },
  { id: 'backView', label: '背面视角', position: { horizontal: 180, vertical: 0 }, shotSize: 'medium shot', prompt: 'rear view portrait, subject facing away from camera, back of head and shoulders visible, camera behind subject', extraPromptDefault: '' },
];

const SHOT_SIZE_IMAGE_SCALE: Record<ShotSizeType, number> = {
  'extreme close-up': 1.5,
  'close-up': 1.32,
  'medium close-up': 1.14,
  'medium shot': 1,
  'medium full shot': 0.88,
  'full shot': 0.74,
  'long shot': 0.62,
};

// Angle prompts based on spherical position
function resolveConsistencyPrompt(horizontal: number, vertical: number, mode: MultiAnglePromptMode): string {
  const normalizedHorizontal = ((horizontal % 360) + 360) % 360;
  const horizontalAllowancePrompt = normalizedHorizontal >= 165 && normalizedHorizontal <= 195
    ? 'rotate the subject into a real back-facing composition, head and torso turned away together, no frontal face visible, no cheating eye contact'
    : normalizedHorizontal >= 105 && normalizedHorizontal < 165
      ? 'allow natural rotation into a rear three-quarter composition, with facial features mostly hidden from camera'
      : normalizedHorizontal >= 75 && normalizedHorizontal <= 105
        ? 'rotate the subject into a true profile side view, head and torso aligned, only one side of the face visible, not looking toward camera'
        : normalizedHorizontal > 195 && normalizedHorizontal < 255
          ? 'allow natural rotation into a rear three-quarter composition from the opposite side, with facial features mostly hidden from camera'
          : normalizedHorizontal > 15 && normalizedHorizontal < 345
            ? 'allow subtle pose and head-turn changes for the requested camera orbit while keeping the same subject and scene'
            : 'keep the pose close to the source image while changing camera angle';

  const verticalAllowancePrompt = vertical >= 45
    ? 'viewer is clearly above the subject, keep the subject seen from above, eyes should not look into the camera, gaze should stay downward or away, do not lift the chin or tilt the face up to fake a frontal view'
    : vertical <= -25
      ? 'viewer is clearly below the subject, allow natural low-angle perspective while keeping body orientation consistent'
      : 'keep the perspective close to the source image';

  return [
    'this is a camera-angle edit of the reference image: the same scene, same people, same action, viewed from a different viewer angle',
    'the following instructions describe only where the viewer is looking from, they are not new objects to add to the scene',
    'do not add any camera, lens, tripod, viewfinder, screen, or photography equipment into the image',
    'your job is to preserve the original people, action, scene, and relationship structure and only change the viewer angle and shot framing',
    'the output must stay in the same world and same moment as the reference image, not a different person, not a different place',
    'preserve identity, outfit, hairstyle, and the overall scene from the input image',
    resolveModePrompt(mode),
    'preserve body pose, hand gesture, limb placement, and action from the input image',
    'preserve complete anatomy, especially hands, arms, shoulders, and body connections, with no missing limbs, fused hands, or malformed gesture silhouettes',
    'if multiple people are present, preserve the same number of people, keep each person as a clearly separate individual, preserve their left-right order, relative spacing, facing direction, eyeline relationship, confrontation geometry, and subject-to-subject separation, do not merge characters, do not replace one subject with another, do not duplicate or clone any subject, do not create an extra mirrored or repeated opponent, and do not collapse a two-person confrontation into a single dominant subject',
    'keep background, lighting, and color mood broadly consistent while changing viewer angle and framing',
    resolveModeCameraConstraint(mode),
    'interpret the requested horizontal angle, vertical angle, shot size, and preset as instructions for where the viewer is looking from, not as objects inside the image',
    resolveModeShotPrompt(mode),
    horizontalAllowancePrompt,
    verticalAllowancePrompt,
  ].join(', ');
}


function resolveHorizontalPrompt(horizontal: number): string {
  const normalizedHorizontal = ((horizontal % 360) + 360) % 360;
  if (normalizedHorizontal >= 345 || normalizedHorizontal <= 15) return 'frontal portrait view, straight-on viewer angle';
  if (normalizedHorizontal > 15 && normalizedHorizontal < 75) return 'front three-quarter portrait view, partial side rotation, head and torso turning together';
  if (normalizedHorizontal >= 75 && normalizedHorizontal <= 105) return 'true side-profile portrait view, 90 degree profile angle, only one side of the face visible';
  if (normalizedHorizontal > 105 && normalizedHorizontal < 165) return 'rear three-quarter portrait view, viewer positioned behind the subject, face mostly hidden';
  if (normalizedHorizontal >= 165 && normalizedHorizontal <= 195) return 'back-view portrait, viewer positioned directly behind the subject, zero facial features visible';
  if (normalizedHorizontal > 195 && normalizedHorizontal < 255) return 'rear three-quarter portrait view from the opposite side, face mostly hidden';
  if (normalizedHorizontal >= 255 && normalizedHorizontal <= 285) return 'true side-profile portrait view from the opposite side, 90 degree profile angle';
  return 'front three-quarter portrait view from the opposite side, head and torso turning together';
}

function resolveVerticalPrompt(vertical: number): string {
  if (vertical >= 60) return 'strong overhead perspective, steep high angle, subject seen from above, eyes looking downward or away, no direct eye contact with the viewer';
  if (vertical >= 30) return 'high-angle perspective, viewer positioned above the subject, gaze lowered or turned away, avoid direct eye contact';
  if (vertical <= -45) return 'strong low-angle perspective, viewer looking up from below';
  if (vertical <= -15) return 'low-angle perspective, viewer slightly below the subject';
  return 'eye-level perspective';
}

function snapToTicks(value: number, ticks: number[], threshold: number): number {
  const nearest = ticks.reduce((prev, current) =>
    Math.abs(current - value) < Math.abs(prev - value) ? current : prev
  );
  return Math.abs(nearest - value) <= threshold ? nearest : value;
}

interface MultiAnglePanelProps {
  isOpen: boolean;
  onClose: () => void;
  onApply: (options: MultiAngleControlOptions, prompt: string) => void;
  onCopyPrompt?: (prompt: string) => void;
  buttonRect: DOMRect;
  previewImageUrl?: string | null;
}

export const MultiAnglePanel = memo(
  ({ isOpen, onClose, onApply, onCopyPrompt, buttonRect, previewImageUrl }: MultiAnglePanelProps) => {
    useTranslation();

    const [horizontal, setHorizontal] = useState(0);
    const [vertical, setVertical] = useState(0);
    const [shotSize, setShotSize] = useState<ShotSizeType>('medium shot');
    const [promptMode, setPromptMode] = useState<MultiAnglePromptMode>('universal');
    const [promptEnabled, setPromptEnabled] = useState(false);
    const [selectedPreset, setSelectedPreset] = useState('custom');
    const [extraPrompt, setExtraPrompt] = useState('');
    const [isTemplateDialogOpen, setIsTemplateDialogOpen] = useState(false);
    const multiAnglePromptTemplate = useSettingsStore((state) => state.multiAnglePromptTemplate);
    const setMultiAnglePromptTemplate = useSettingsStore((state) => state.setMultiAnglePromptTemplate);
    const resetMultiAnglePromptTemplate = useSettingsStore((state) => state.resetMultiAnglePromptTemplate);

    useEffect(() => {
      if (isOpen) {
        setHorizontal(0);
        setVertical(0);
        setShotSize('medium shot');
        setPromptMode('universal');
        setPromptEnabled(false);
        setSelectedPreset('custom');
        setExtraPrompt('');
      }
    }, [isOpen]);

    const handlePositionChange = useCallback((h: number, v: number) => {
      setHorizontal(h);
      setVertical(v);
      setSelectedPreset('custom');
    }, []);

    const handlePresetClick = useCallback((presetId: string) => {
      const preset = ANGLE_PRESETS.find((p) => p.id === presetId);
      if (preset) {
        setHorizontal(preset.position.horizontal);
        setVertical(preset.position.vertical);
        setShotSize(preset.shotSize);
        setSelectedPreset(presetId);
        setExtraPrompt(preset.extraPromptDefault);
      }
    }, []);

    const buildPrompt = useCallback(() => {
      return buildPromptFromState(
        horizontal,
        vertical,
        shotSize,
        promptMode,
        selectedPreset,
        multiAnglePromptTemplate,
        promptEnabled,
        extraPrompt
      );
    }, [horizontal, vertical, shotSize, promptMode, selectedPreset, promptEnabled, extraPrompt, multiAnglePromptTemplate]);

    const activeImageScale = SHOT_SIZE_IMAGE_SCALE[shotSize] ?? 1;

    const handleApply = useCallback(() => {
      const options: MultiAngleControlOptions = {
        enabled: true,
        horizontal,
        vertical,
        shotSize,
        promptEnabled,
      };
      onApply(options, buildPrompt());
    }, [horizontal, vertical, shotSize, promptEnabled, onApply, buildPrompt]);

    const handleReset = useCallback(() => {
      setHorizontal(0);
      setVertical(0);
      setShotSize('medium shot');
      setPromptMode('universal');
      setPromptEnabled(false);
      setSelectedPreset('custom');
      setExtraPrompt('');
    }, []);

    // Resolve panel position: below button, clamp to viewport
    const panelWidth = 860; // closer to reference screenshot width/proportion for left sphere + right controls layout

    const panelLeft = Math.min(
      Math.max(8, buttonRect.left),
      window.innerWidth - panelWidth - 8
    );
    const panelTop = buttonRect.bottom + 6;

    if (!isOpen) return null;

    return (
      <div
        className="fixed z-200 rounded-xl border border-[var(--line)] bg-elevated shadow-[var(--shadow-pop)]"
        style={{ left: panelLeft, top: panelTop, width: panelWidth }}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--line)]">
          <span className="text-sm font-semibold text-text-dark">多角度编辑器</span>
          <UiIconButton onClick={onClose} aria-label="关闭">
            <X className="w-4 h-4" />
          </UiIconButton>
        </div>

        {/* Preset tabs */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--line)] overflow-x-auto">
          {ANGLE_PRESETS.map((preset) => (
            <UiChipButton
              key={preset.id}
              active={selectedPreset === preset.id}
              aria-pressed={selectedPreset === preset.id}
              onClick={() => handlePresetClick(preset.id)}
              className="shrink-0 rounded-lg text-xs whitespace-nowrap"
            >
              {preset.label}
            </UiChipButton>
          ))}
        </div>

        {/* Main content */}
        <div className="flex gap-7 p-4 pt-5 pb-5 items-start">
          {/* Left: Sphere */}
          <div className="shrink-0 w-[360px]">
            <CameraSphereControl
              horizontal={horizontal}
              vertical={vertical}
              onPositionChange={handlePositionChange}
              previewImageUrl={previewImageUrl}
              imageScale={activeImageScale}
            />
          </div>

          {/* Right: Controls */}
          <div className="flex-1 flex flex-col gap-6 pt-4 pr-2">
            <div className="flex items-start gap-3">
              <span className="text-xs text-text-muted w-14 shrink-0 pt-2">模式</span>
              <div className="flex-1 flex flex-wrap gap-2">
                <UiSegmented
                  value={promptMode}
                  onChange={setPromptMode}
                  options={PROMPT_MODES.map((mode) => ({ value: mode.id, label: <span title={mode.hint}>{mode.label}</span> }))}
                  size="sm"
                  aria-label="模式"
                />
                <div className="w-full text-[11px] text-text-subtle leading-5">
                  建议：{PROMPT_MODES.find((mode) => mode.id === promptMode)?.hint}
                </div>
              </div>
            </div>

            {/* 水平环绕 slider */}
            <div className="flex items-center gap-3">
              <span className="text-xs text-text-muted w-14 shrink-0">水平环绕</span>
              <div className="flex-1 relative">
                <UiSlider
                  min={0}
                  max={360}
                  value={horizontal}
                  onChange={(value) => handlePositionChange(snapToTicks(value, HORIZONTAL_TICKS, SNAP_THRESHOLD), vertical)}
                  aria-label="水平环绕"
                />
                <div className="pointer-events-none absolute left-0 right-0 top-1/2 -translate-y-1/2 flex justify-between px-[2px]">
                  {HORIZONTAL_TICKS.map((tick) => (
                    <span
                      key={tick}
                      className={`rounded-full ${tick % 90 === 0 ? 'h-2.5 w-2.5 bg-text-subtle' : 'h-2 w-2 bg-text-subtle/60'}`}
                    />
                  ))}
                </div>
              </div>
              <span className="text-xs text-text-subtle w-8 text-right">{horizontal}°</span>
            </div>

            {/* 垂直俯仰 slider */}
            <div className="flex items-center gap-3">
              <span className="text-xs text-text-muted w-14 shrink-0">垂直俯仰</span>
              <div className="flex-1 relative">
                <UiSlider
                  min={-90}
                  max={90}
                  value={vertical}
                  onChange={(value) => handlePositionChange(horizontal, snapToTicks(value, VERTICAL_TICKS, SNAP_THRESHOLD))}
                  aria-label="垂直俯仰"
                />
                <div className="pointer-events-none absolute left-0 right-0 top-1/2 -translate-y-1/2 flex justify-between px-[2px]">
                  {VERTICAL_TICKS.map((tick) => (
                    <span
                      key={tick}
                      className={`rounded-full ${tick === 0 ? 'h-2.5 w-2.5 bg-text-muted' : 'h-2 w-2 bg-text-subtle'}`}
                    />
                  ))}
                </div>
                <div className="pointer-events-none absolute left-0 right-0 top-[calc(50%+10px)] flex justify-between px-[2px] text-[9px] text-text-subtle">
                  {VERTICAL_TICKS.map((tick) => (
                    <span key={`label-${tick}`} className="-translate-x-1/2 first:translate-x-0 last:-translate-x-full">
                      {tick}
                    </span>
                  ))}
                </div>
              </div>
              <span className="text-xs text-text-subtle w-8 text-right">{vertical}°</span>
            </div>

            {/* 景别缩放 slider (shot size) */}
            <div className="flex items-center gap-3">
              <span className="text-xs text-text-muted w-14 shrink-0">景别缩放</span>
              <div className="flex-1 relative">
                <UiSlider
                  min={0}
                  max={6}
                  step={1}
                  value={SHOT_SIZE_VALUES[shotSize]}
                  onChange={(value) => setShotSize(SHOT_SIZE_FROM_VALUE[value])}
                  aria-label="景别缩放"
                />
              </div>
              <span className="text-xs text-text-subtle w-8 text-right">
                {SHOT_SIZES.find(s => s.id === shotSize)?.label ?? '中景'}
              </span>
            </div>

            {/* 提示词 toggle */}
            <div className="flex items-center gap-3">
              <span className="text-xs text-text-muted w-14 shrink-0">提示词</span>
              <UiSwitch checked={promptEnabled} onCheckedChange={setPromptEnabled} aria-label="提示词" />
            </div>

            {promptEnabled && (
              <UiTextArea
                value={extraPrompt}
                onChange={(e) => setExtraPrompt(e.target.value)}
                placeholder="输入你自己的附加提示词，会叠加到系统多角度提示词后面"
                className="h-24 w-full resize-none text-sm leading-6"
              />
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-[var(--line)]">
          <UiButton variant="ghost" size="sm" onClick={handleReset} icon={<RotateCcw className="w-3.5 h-3.5" />}>
            重置参数
          </UiButton>

          {/* Model / provider / ratio picker — persisted per panel under
              lastModelConfigByPanel.multiAngle. Sits between 重置参数 and 复制提示词. */}
          <ModelConfigPicker panelKey="multiAngle" />

          <div className="flex items-center gap-2">
            <UiButton size="sm" onClick={() => onCopyPrompt?.(buildPrompt())}>
              复制提示词
            </UiButton>
            <UiButton size="sm" onClick={() => setIsTemplateDialogOpen(true)}>
              设置提示词
            </UiButton>
            <UiButton variant="primary" onClick={handleApply} className="w-9 h-9 rounded-full p-0" aria-label="应用多角度效果">
              <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none">
                <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </UiButton>
          </div>
        </div>

        <PromptTemplateDialog
          isOpen={isTemplateDialogOpen}
          title="设置多角度默认提示词"
          description="这里修改的是系统每次自动附加的默认多角度描述骨架，不包含你当前滑杆选择出来的参数值。滑杆参数会自动替换进去；你在面板里手动输入的附加提示词，也会单独叠加。"
          value={multiAnglePromptTemplate}
          defaultValue={DEFAULT_MULTI_ANGLE_PROMPT_TEMPLATE}
          placeholders={['{{consistencyPrompt}}', '{{presetPrompt}}', '{{horizontalPrompt}}', '{{verticalPrompt}}', '{{shotSizePrompt}}', '{{cameraMeta}}']}
          onClose={() => setIsTemplateDialogOpen(false)}
          onChange={setMultiAnglePromptTemplate}
          onSave={() => undefined}
          onResetDefault={resetMultiAnglePromptTemplate}
        />
      </div>
    );
  }
);

MultiAnglePanel.displayName = 'MultiAnglePanel';
