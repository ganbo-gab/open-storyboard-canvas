import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  Aperture,
  Box,
  Camera,
  Check,
  Crop,
  Crosshair,
  Eraser,
  Eye,
  EyeOff,
  FileText,
  FolderOpen,
  Focus,
  Grid3x3,
  Image,
  ImagePlus,
  Keyboard,
  Link2,
  Lightbulb,
  Monitor,
  Move3d,
  Plus,
  PanelBottom,
  RotateCcw,
  Rotate3d,
  Save,
  Scale3d,
  SlidersHorizontal,
  Trash2,
  Unlink,
  Upload,
  UserPlus,
  Users,
  Video,
  X,
  type LucideIcon,
} from 'lucide-react';

import {
  CANVAS_NODE_TYPES,
  type BlueprintActionPose,
  type BlueprintBodyControls,
  type BlueprintBodyStyle,
  type BlueprintItem,
  type BlueprintNodeData,
  type BlueprintReferenceImageItem,
  type DirectorStudioAspectFrame,
  type DirectorStudioCameraSettings,
  type DirectorStudioGridSettings,
  type DirectorStudioLightingSettings,
  type DirectorStudioProjectRecord,
  type DirectorStudioProjectSnapshot,
  type DirectorStudioScreenshotResolution,
  type DirectorStudioShortcutBindings,
  type DirectorStudioShortcutId,
  type DirectorStudioTransformMode,
  type DirectorStudioViewSettings,
} from '@/features/canvas/domain/canvasNodes';
import type { DirectorRecordedVideo } from '@/features/canvas/application/directorVideoRecording';
import { normalizeDirectorMotionProject } from '@/features/canvas/application/directorMotion';
import {
  DIRECTOR_STUDIO_BODY_STYLES,
  normalizeBlueprintBodyControls,
} from '@/features/canvas/domain/directorStudioBodyControls';
import {
  DIRECTOR_STUDIO_MODEL_CATALOG,
  DIRECTOR_STUDIO_MODEL_CATEGORIES,
  type DirectorStudioModelCatalogItem,
  type DirectorStudioModelCategoryId,
} from '@/features/canvas/domain/directorStudioModelCatalog';
import type { BlueprintSceneExportOptions, BlueprintSceneHandle } from '@/features/canvas/ui/BlueprintScene';
import { DirectorStudioModelThumbnail } from '@/features/canvas/ui/DirectorStudioModelThumbnail';
import { prepareNodeImageFromFile, resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { persistImageSource } from '@/commands/image';
import {
  importDirectorStudioPanorama,
  type DirectorStudioPanoramaImportStage,
} from '@/features/canvas/application/directorStudioPanoramaImport';
import type { BlueprintReferenceImage } from '@/features/canvas/application/blueprintPrompt';
import { showErrorDialog } from '@/features/canvas/application/errorDialog';
import { BlueprintCustomActionModal } from '@/features/canvas/ui/BlueprintCustomActionModal';
import { DirectorActionLibrary } from '@/features/canvas/ui/DirectorActionLibrary';
import { DirectorCameraPilotHud } from '@/features/canvas/ui/DirectorCameraPilotHud';
import {
  DirectorSceneErrorBoundary,
  isDirectorSceneModuleLoadError,
} from '@/features/canvas/ui/DirectorSceneErrorBoundary';
import { DirectorTimeline } from '@/features/canvas/ui/DirectorTimeline';
import { DirectorVideoExportDialog } from '@/features/canvas/ui/DirectorVideoExportDialog';
import { useDirectorStudioMotion } from '@/features/canvas/ui/useDirectorStudioMotion';
import type { CanvasEventMap } from '@/features/canvas/application/ports';
import { ensurePos3d, genBlueprintItemId, pos3dToLegacy } from '@/features/canvas/ui/blueprintCoordinates';
import { useCanvasStore } from '@/stores/canvasStore';

const loadBlueprintScene = () =>
  import('@/features/canvas/ui/BlueprintScene').then((m) => ({ default: m.BlueprintScene }));

type PanelMode = 'projects' | 'elements';
type ToolFloatingPanel = 'camera' | 'lighting' | 'grid' | 'frame' | 'resolution' | 'prompt';
type FloatingPanel = ToolFloatingPanel | null;
type SidePanel = 'inspector' | 'snapshot' | null;
type FloatingSurface = 'tool' | 'side';
type DirectorStudioDialog = 'modelLibrary' | 'pedestrians' | 'shortcuts' | null;
type PedestrianMode = 'direct' | 'array' | 'random';
type VectorAxis = 'x' | 'y' | 'z';
type InspectorTextField = 'label' | 'relation' | 'note' | 'action';
type InspectorTextDraft = {
  itemId: string | null;
  label: string;
  relation: string;
  note: string;
  action: string;
};

const TEXT_DRAFT_COMMIT_DELAY_MS = 800;

const TRANSFORM_MODE_OPTIONS: Array<{
  mode: DirectorStudioTransformMode;
  shortcutId: DirectorStudioShortcutId;
  labelKey: string;
  titleKey: string;
  icon: LucideIcon;
}> = [
  { mode: 'move', shortcutId: 'transformMove', labelKey: 'directorStudio.transform.move', titleKey: 'directorStudio.transform.moveTitle', icon: Move3d },
  { mode: 'rotate', shortcutId: 'transformRotate', labelKey: 'directorStudio.transform.rotate', titleKey: 'directorStudio.transform.rotateTitle', icon: Rotate3d },
  { mode: 'scale', shortcutId: 'transformScale', labelKey: 'directorStudio.transform.scale', titleKey: 'directorStudio.transform.scaleTitle', icon: Scale3d },
];

const CAMERA_PRESETS = [
  { id: 'standard', fov: 39.6, labelKey: 'directorStudio.cameraPresets.standard' },
  { id: 'wide', fov: 73.7, labelKey: 'directorStudio.cameraPresets.wide' },
  { id: 'ultraWide', fov: 96.7, labelKey: 'directorStudio.cameraPresets.ultraWide' },
  { id: 'portrait', fov: 23.9, labelKey: 'directorStudio.cameraPresets.portrait' },
  { id: 'telephoto', fov: 15.2, labelKey: 'directorStudio.cameraPresets.telephoto' },
  { id: 'superTelephoto', fov: 10.3, labelKey: 'directorStudio.cameraPresets.superTelephoto' },
  { id: 'fisheye', fov: 150, labelKey: 'directorStudio.cameraPresets.fisheye' },
] as const;

const ASPECT_FRAMES: Array<{ value: DirectorStudioAspectFrame; labelKey: string; ratio: number | null }> = [
  { value: 'panorama', labelKey: 'directorStudio.aspectFrames.panorama', ratio: null },
  { value: '1:1', labelKey: 'directorStudio.aspectFrames.square', ratio: 1 },
  { value: '4:3', labelKey: 'directorStudio.aspectFrames.fourThree', ratio: 4 / 3 },
  { value: '3:4', labelKey: 'directorStudio.aspectFrames.threeFour', ratio: 3 / 4 },
  { value: '16:9', labelKey: 'directorStudio.aspectFrames.sixteenNine', ratio: 16 / 9 },
  { value: '9:16', labelKey: 'directorStudio.aspectFrames.nineSixteen', ratio: 9 / 16 },
  { value: '3:2', labelKey: 'directorStudio.aspectFrames.threeTwo', ratio: 3 / 2 },
  { value: '2:3', labelKey: 'directorStudio.aspectFrames.twoThree', ratio: 2 / 3 },
  { value: '21:9', labelKey: 'directorStudio.aspectFrames.twentyOneNine', ratio: 21 / 9 },
];

const SCREENSHOT_RESOLUTIONS: Array<{ value: DirectorStudioScreenshotResolution; labelKey: string; base: number }> = [
  { value: '1080p', labelKey: 'directorStudio.resolutions.p1080', base: 1080 },
  { value: '1440p', labelKey: 'directorStudio.resolutions.p1440', base: 1440 },
  { value: '4k', labelKey: 'directorStudio.resolutions.k4', base: 2160 },
];

const DEFAULT_CAMERA: DirectorStudioCameraSettings = {
  fov: 39.6,
  lensDistance: 8,
  activePreset: 'standard',
};

const DEFAULT_LIGHTING: DirectorStudioLightingSettings = {
  enabled: true,
  mainIntensity: 0.65,
  mainYaw: 35,
  mainPitch: 50,
  mainColor: '#ffffff',
  ambientIntensity: 0.55,
  ambientColor: '#ffffff',
};

const DEFAULT_GRID: DirectorStudioGridSettings = {
  visible: true,
  height: 0,
};

const DEFAULT_VIEW_SETTINGS: DirectorStudioViewSettings = {
  wheelZoomEnabled: true,
  reverseWheelZoom: false,
  showAdvancedPedestrianTags: false,
};

const DEFAULT_INSERT_POSITION = { x: 0, y: 0, z: 0 };
const MAX_SNAPSHOT_HISTORY = 10;

const PEDESTRIAN_COLORS = [
  '#d1d5db',
  '#9ca3af',
  '#64748b',
  '#a3a3a3',
  '#cbd5e1',
  '#94a3b8',
  '#78716c',
  '#e5e7eb',
] as const;

const DIRECTOR_FIELD_CLASS =
  'director-studio-field rounded border border-white/12 bg-[#090d10]/78 text-white outline-none placeholder:text-white/30 focus:border-accent/60 focus:bg-[#0c1115]';
const DIRECTOR_EDITABLE_NAME_CLASS =
  'rounded border border-white/10 bg-white/[0.045] px-1.5 py-1 transition-colors hover:border-white/24 hover:bg-white/[0.075]';

const INSPECTOR_ACTION_PRESETS = [
  { id: 'stand', valueKey: 'directorStudio.actionValues.stand', labelKey: 'directorStudio.actionPresets.stand', legacyValues: ['站立', 'Stand'] },
  { id: 'walk', valueKey: 'directorStudio.actionValues.walk', labelKey: 'directorStudio.actionPresets.walk', legacyValues: ['行走', 'Walk'] },
  { id: 'talk', valueKey: 'directorStudio.actionValues.talk', labelKey: 'directorStudio.actionPresets.talk', legacyValues: ['对话', 'Talk'] },
  { id: 'point', valueKey: 'directorStudio.actionValues.point', labelKey: 'directorStudio.actionPresets.point', legacyValues: ['伸手指向', '指向', 'Point'] },
  { id: 'halfSquat', valueKey: 'directorStudio.actionValues.halfSquat', labelKey: 'directorStudio.actionPresets.halfSquat', legacyValues: ['半蹲', 'Half Squat'] },
  { id: 'sit', valueKey: 'directorStudio.actionValues.sit', labelKey: 'directorStudio.actionPresets.sit', legacyValues: ['坐姿', 'Sit'] },
  { id: 'lie', valueKey: 'directorStudio.actionValues.lie', labelKey: 'directorStudio.actionPresets.lie', legacyValues: ['躺下', 'Lie Down'] },
] as const;

const PEDESTRIAN_LABEL_ALIASES = ['路人', 'Pedestrian'] as const;

type DirectorStudioDisplayCategory = NonNullable<BlueprintItem['category']>;

interface DirectorStudioDisplayItem {
  item: BlueprintItem;
  originalIndex: number;
  displayCategory: DirectorStudioDisplayCategory;
  typeRank: number;
}

const DIRECTOR_STUDIO_CATEGORY_RANK: Record<DirectorStudioDisplayCategory, number> = {
  person: 1,
  object: 2,
  scene: 3,
};

const DIRECTOR_STUDIO_DISPLAY_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

const DEFAULT_DIRECTOR_STUDIO_SHORTCUTS: Record<DirectorStudioShortcutId, string> = {
  transformMove: '1',
  transformRotate: '2',
  transformScale: '3',
  focus: 'F',
  fit: 'Z',
  reset: 'R',
  screenshot: 'C',
  model: 'M',
  lighting: 'L',
  grid: 'G',
  prompt: 'P',
  shortcuts: 'H',
  save: 'Cmd/Ctrl+S',
  delete: 'Delete',
  copy: 'Cmd/Ctrl+C',
  paste: 'Cmd/Ctrl+V',
  undo: 'Cmd/Ctrl+Z',
  redo: 'Cmd/Ctrl+Shift+Z',
  advancedPedestrianTags: 'T',
};

const SHORTCUT_GROUPS: Array<{
  titleKey: string;
  entries: Array<{
    shortcutId?: DirectorStudioShortcutId;
    defaultKeys?: string;
    labelKey: string;
  }>;
}> = [
  {
    titleKey: 'directorStudio.shortcuts.sections.move',
    entries: [
      { defaultKeys: 'W/A/S/D / Arrow Keys', labelKey: 'directorStudio.shortcuts.rows.moveWasd' },
      { defaultKeys: 'Q / E', labelKey: 'directorStudio.shortcuts.rows.moveVertical' },
      { defaultKeys: 'Shift', labelKey: 'directorStudio.shortcuts.rows.moveFast' },
    ],
  },
  {
    titleKey: 'directorStudio.shortcuts.sections.view',
    entries: [
      { defaultKeys: 'Mouse Left', labelKey: 'directorStudio.shortcuts.rows.viewOrbit' },
      { defaultKeys: 'Mouse Middle / Right / Shift Drag', labelKey: 'directorStudio.shortcuts.rows.viewPan' },
      { defaultKeys: 'Wheel', labelKey: 'directorStudio.shortcuts.rows.viewZoom' },
      { shortcutId: 'focus', labelKey: 'directorStudio.shortcuts.rows.focus' },
      { shortcutId: 'fit', labelKey: 'directorStudio.shortcuts.rows.fit' },
      { shortcutId: 'reset', labelKey: 'directorStudio.shortcuts.rows.reset' },
    ],
  },
  {
    titleKey: 'directorStudio.shortcuts.sections.camera',
    entries: [
      { defaultKeys: 'Wheel', labelKey: 'directorStudio.shortcuts.rows.cameraWheelZoom' },
      { defaultKeys: 'Setting', labelKey: 'directorStudio.shortcuts.rows.cameraWheelToggle' },
      { defaultKeys: 'Setting', labelKey: 'directorStudio.shortcuts.rows.cameraReverseWheel' },
    ],
  },
  {
    titleKey: 'directorStudio.shortcuts.sections.transform',
    entries: [
      { shortcutId: 'transformMove', labelKey: 'directorStudio.shortcuts.rows.transformMove' },
      { shortcutId: 'transformRotate', labelKey: 'directorStudio.shortcuts.rows.transformRotate' },
      { shortcutId: 'transformScale', labelKey: 'directorStudio.shortcuts.rows.transformScale' },
      { defaultKeys: 'Esc', labelKey: 'directorStudio.shortcuts.rows.escape' },
      { shortcutId: 'delete', labelKey: 'directorStudio.shortcuts.rows.delete' },
      { shortcutId: 'copy', labelKey: 'directorStudio.shortcuts.rows.copy' },
      { shortcutId: 'paste', labelKey: 'directorStudio.shortcuts.rows.paste' },
      { shortcutId: 'undo', labelKey: 'directorStudio.shortcuts.rows.undo' },
      { shortcutId: 'redo', labelKey: 'directorStudio.shortcuts.rows.redo' },
    ],
  },
  {
    titleKey: 'directorStudio.shortcuts.sections.workflow',
    entries: [
      { shortcutId: 'save', labelKey: 'directorStudio.shortcuts.rows.save' },
      { shortcutId: 'screenshot', labelKey: 'directorStudio.shortcuts.rows.screenshot' },
      { shortcutId: 'model', labelKey: 'directorStudio.shortcuts.rows.model' },
      { shortcutId: 'lighting', labelKey: 'directorStudio.shortcuts.rows.lighting' },
      { shortcutId: 'grid', labelKey: 'directorStudio.shortcuts.rows.grid' },
      { shortcutId: 'prompt', labelKey: 'directorStudio.shortcuts.rows.prompt' },
      { shortcutId: 'shortcuts', labelKey: 'directorStudio.shortcuts.rows.shortcuts' },
      { shortcutId: 'advancedPedestrianTags', labelKey: 'directorStudio.shortcuts.rows.advancedPedestrianTags' },
    ],
  },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isPedestrianDisplayItem(item: BlueprintItem): boolean {
  if (item.directorStudioRole === 'pedestrian') return true;
  const label = item.label.trim();
  if (!label) return false;
  return PEDESTRIAN_LABEL_ALIASES.some((alias) => {
    const normalizedAlias = alias.trim();
    if (!normalizedAlias) return false;
    if (label.toLowerCase() === normalizedAlias.toLowerCase()) return true;
    return new RegExp(`^${escapeRegExp(normalizedAlias)}\\s*\\d+$`, 'i').test(label);
  });
}

function getDirectorStudioDisplayCategory(item: BlueprintItem): DirectorStudioDisplayCategory {
  if (isPedestrianDisplayItem(item)) return 'person';
  if (item.category === 'person' || item.category === 'scene') return item.category;
  return 'object';
}

function getDirectorStudioTypeRank(item: BlueprintItem): number {
  if (isPedestrianDisplayItem(item)) return 0;
  return DIRECTOR_STUDIO_CATEGORY_RANK[getDirectorStudioDisplayCategory(item)];
}

function compareDirectorStudioText(a: string | null | undefined, b: string | null | undefined): number {
  const normalizedA = (a ?? '').trim();
  const normalizedB = (b ?? '').trim();
  if (!normalizedA && normalizedB) return 1;
  if (normalizedA && !normalizedB) return -1;
  return DIRECTOR_STUDIO_DISPLAY_COLLATOR.compare(normalizedA, normalizedB);
}

function getDirectorStudioDisplayItems(items: BlueprintItem[]): DirectorStudioDisplayItem[] {
  return items
    .map((item, originalIndex) => ({
      item,
      originalIndex,
      displayCategory: getDirectorStudioDisplayCategory(item),
      typeRank: getDirectorStudioTypeRank(item),
    }))
    .sort((a, b) => {
      if (a.typeRank !== b.typeRank) return a.typeRank - b.typeRank;
      const labelCompare = compareDirectorStudioText(a.item.label, b.item.label);
      if (labelCompare !== 0) return labelCompare;
      const presetCompare = compareDirectorStudioText(a.item.presetId, b.item.presetId);
      if (presetCompare !== 0) return presetCompare;
      return a.originalIndex - b.originalIndex;
    });
}

function getNextLabelIndex(items: BlueprintItem[], labelBase: string, aliases: readonly string[] = []): number {
  const labelBases = Array.from(new Map(
    [labelBase, ...aliases]
      .map((base) => base.trim())
      .filter(Boolean)
      .map((base) => [base.toLowerCase(), base])
  ).values());
  const numberedLabelPatterns = labelBases.map((base) => new RegExp(`^${escapeRegExp(base)}\\s*(\\d+)$`, 'i'));
  const highestExistingIndex = items.reduce((highest, item) => {
    const label = item.label.trim();
    if (labelBases.some((base) => label.toLowerCase() === base.toLowerCase())) return Math.max(highest, 1);
    const match = numberedLabelPatterns
      .map((pattern) => label.match(pattern))
      .find(Boolean);
    if (!match) return highest;
    return Math.max(highest, Number(match[1]) || 0);
  }, 0);
  return highestExistingIndex + 1;
}

function getCopyLabelBase(label: string, fallbackBase: string, copySuffix: string): string {
  const trimmed = label.trim();
  if (!trimmed) return fallbackBase;
  const match = trimmed.match(/^(.*?)(\d+)$/);
  return match?.[1]?.trim() || `${trimmed}${copySuffix}`;
}

function getModelNameKey(model: DirectorStudioModelCatalogItem): string {
  return `directorStudio.modelLibrary.models.${model.id}.name`;
}

function getModelLabelBaseKey(model: DirectorStudioModelCatalogItem): string {
  return `directorStudio.modelLibrary.models.${model.id}.labelBase`;
}

function cloneBlueprintBodyControls(controls?: BlueprintBodyControls): BlueprintBodyControls | undefined {
  if (!controls) return undefined;
  return {
    ...controls,
    core: controls.core ? { ...controls.core } : undefined,
    arms: controls.arms ? { ...controls.arms } : undefined,
    legs: controls.legs ? { ...controls.legs } : undefined,
  };
}

function normalizeActionValue(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function getUniqueActionPresets(presets: readonly string[] | null | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  (presets ?? []).forEach((preset) => {
    const trimmed = preset.trim();
    const normalized = normalizeActionValue(trimmed);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    result.push(trimmed);
  });
  return result;
}

function isInspectorActionPresetSelected(
  action: string | null | undefined,
  preset: { value: string; legacyValues: readonly string[] },
): boolean {
  const normalizedAction = normalizeActionValue(action);
  if (!normalizedAction) return false;
  return [preset.value, ...preset.legacyValues].some((value) => normalizeActionValue(value) === normalizedAction);
}

function createBlueprintItemFromPreset(args: {
  label: string;
  color: string;
  category: NonNullable<BlueprintItem['category']>;
  presetId: string;
  pos3d?: { x: number; y: number; z: number };
  directorStudioRole?: BlueprintItem['directorStudioRole'];
  directorStudioNumber?: number;
  defaultPersonAction?: string;
  bodyControls?: BlueprintBodyControls;
}): BlueprintItem {
  const pos3d = args.pos3d ?? DEFAULT_INSERT_POSITION;
  const legacy = pos3dToLegacy(pos3d);
  return {
    id: genBlueprintItemId(),
    label: args.label,
    x: legacy.x,
    y: legacy.y,
    color: args.color,
    showLabel: true,
    pos3d: { ...pos3d },
    rotation3d: { x: 0, y: 0, z: 0 },
    scale3d: { x: 1, y: 1, z: 1 },
    category: args.category,
    presetId: args.presetId,
    action: args.category === 'person' ? args.defaultPersonAction : undefined,
    directorStudioRole: args.directorStudioRole,
    directorStudioNumber: args.directorStudioNumber,
    bodyControls: args.category === 'person' ? cloneBlueprintBodyControls(args.bodyControls) : undefined,
  };
}

interface DirectorStudioShellProps {
  sourceNodeId: string;
  data: BlueprintNodeData;
  referenceImages: BlueprintReferenceImageItem[];
  panoramaAssets?: BlueprintReferenceImage[];
  imageAssets?: BlueprintReferenceImage[];
  selectedItemId: string | null;
  onSelectedItemChange: (itemId: string | null) => void;
  onItemsChange: (items: BlueprintItem[]) => void;
  onUpdateNodeData: (patch: Partial<BlueprintNodeData>) => void;
  onAddSnapshotToCanvas?: (snapshotUrl: string) => Promise<boolean | void> | boolean | void;
  onAddVideoToCanvas?: (video: DirectorRecordedVideo) => Promise<boolean | void> | boolean | void;
  getLastRecordedVideoNodeId?: () => string | null;
  recordRequest?: CanvasEventMap['director-studio/record'] | null;
  onRecordRequestResult?: (result: CanvasEventMap['director-studio/record-result']) => void;
  onClose: () => void;
}

function cloneJson<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function normalizeCamera(camera: Partial<DirectorStudioCameraSettings> | null | undefined): DirectorStudioCameraSettings {
  return {
    fov: clampNumber(camera?.fov, DEFAULT_CAMERA.fov, 10, 150),
    lensDistance: clampNumber(camera?.lensDistance, DEFAULT_CAMERA.lensDistance, 2, 80),
    activePreset: typeof camera?.activePreset === 'string' ? camera.activePreset : DEFAULT_CAMERA.activePreset,
  };
}

function normalizeLighting(lighting: Partial<DirectorStudioLightingSettings> | null | undefined): DirectorStudioLightingSettings {
  return {
    enabled: typeof lighting?.enabled === 'boolean' ? lighting.enabled : DEFAULT_LIGHTING.enabled,
    mainIntensity: clampNumber(lighting?.mainIntensity, DEFAULT_LIGHTING.mainIntensity, 0, 4),
    mainYaw: clampNumber(lighting?.mainYaw, DEFAULT_LIGHTING.mainYaw, -180, 180),
    mainPitch: clampNumber(lighting?.mainPitch, DEFAULT_LIGHTING.mainPitch, -20, 89),
    mainColor: typeof lighting?.mainColor === 'string' ? lighting.mainColor : DEFAULT_LIGHTING.mainColor,
    ambientIntensity: clampNumber(lighting?.ambientIntensity, DEFAULT_LIGHTING.ambientIntensity, 0, 3),
    ambientColor: typeof lighting?.ambientColor === 'string' ? lighting.ambientColor : DEFAULT_LIGHTING.ambientColor,
  };
}

function normalizeGrid(grid: Partial<DirectorStudioGridSettings> | null | undefined): DirectorStudioGridSettings {
  return {
    visible: typeof grid?.visible === 'boolean' ? grid.visible : DEFAULT_GRID.visible,
    height: clampNumber(grid?.height, DEFAULT_GRID.height, -5, 10),
  };
}

function normalizeViewSettings(
  viewSettings: Partial<DirectorStudioViewSettings> | null | undefined
): DirectorStudioViewSettings {
  return {
    wheelZoomEnabled:
      typeof viewSettings?.wheelZoomEnabled === 'boolean'
        ? viewSettings.wheelZoomEnabled
        : DEFAULT_VIEW_SETTINGS.wheelZoomEnabled,
    reverseWheelZoom:
      typeof viewSettings?.reverseWheelZoom === 'boolean'
        ? viewSettings.reverseWheelZoom
        : DEFAULT_VIEW_SETTINGS.reverseWheelZoom,
    showAdvancedPedestrianTags:
      typeof viewSettings?.showAdvancedPedestrianTags === 'boolean'
        ? viewSettings.showAdvancedPedestrianTags
        : DEFAULT_VIEW_SETTINGS.showAdvancedPedestrianTags,
  };
}

function normalizeAspectFrame(value: unknown, fallback = '16:9'): DirectorStudioAspectFrame {
  const fallbackFrame = ASPECT_FRAMES.some((frame) => frame.value === fallback) ? fallback : '16:9';
  return ASPECT_FRAMES.some((frame) => frame.value === value)
    ? value as DirectorStudioAspectFrame
    : fallbackFrame as DirectorStudioAspectFrame;
}

function normalizeScreenshotResolution(value: unknown): DirectorStudioScreenshotResolution {
  return SCREENSHOT_RESOLUTIONS.some((resolution) => resolution.value === value)
    ? value as DirectorStudioScreenshotResolution
    : '1080p';
}

function normalizeSnapshotHistory(
  snapshotUrl: string | null | undefined,
  snapshotHistory: unknown,
): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  const append = (url: unknown) => {
    if (typeof url !== 'string' || url.length === 0 || seen.has(url)) return;
    seen.add(url);
    urls.push(url);
  };

  if (Array.isArray(snapshotHistory)) {
    snapshotHistory.forEach(append);
  }
  append(snapshotUrl);
  return urls.slice(-MAX_SNAPSHOT_HISTORY);
}

function appendSnapshotHistory(
  snapshotHistory: unknown,
  snapshotUrl: string | null | undefined,
): string[] {
  const previous = normalizeSnapshotHistory(null, snapshotHistory).filter((url) => url !== snapshotUrl);
  if (!snapshotUrl) return previous.slice(-MAX_SNAPSHOT_HISTORY);
  return [...previous, snapshotUrl].slice(-MAX_SNAPSHOT_HISTORY);
}

function normalizeDirectorSnapshot(
  snapshot: Partial<DirectorStudioProjectSnapshot> | null | undefined
): DirectorStudioProjectSnapshot {
  if (!snapshot || typeof snapshot !== 'object') {
    return createBlankSnapshot();
  }

  const customActionPoses = snapshot.customActionPoses;

  return {
    mode: snapshot.mode === 'panorama' ? 'panorama' : 'flat',
    backgroundImageUrl: snapshot.backgroundImageUrl ?? null,
    backgroundPanoramaUrl: snapshot.backgroundPanoramaUrl ?? null,
    items: Array.isArray(snapshot.items) ? cloneJson(snapshot.items) : [],
    referenceImages: Array.isArray(snapshot.referenceImages) ? cloneJson(snapshot.referenceImages) : [],
    customActionPresets: Array.isArray(snapshot.customActionPresets)
      ? cloneJson(snapshot.customActionPresets)
      : [],
    customActionPoses:
      customActionPoses && typeof customActionPoses === 'object' && !Array.isArray(customActionPoses)
        ? cloneJson(customActionPoses)
        : {},
    basePrompt: typeof snapshot.basePrompt === 'string' ? snapshot.basePrompt : '',
    aspectRatio: typeof snapshot.aspectRatio === 'string' && snapshot.aspectRatio.trim()
      ? snapshot.aspectRatio
      : '16:9',
    camera: normalizeCamera(snapshot.camera),
    lighting: normalizeLighting(snapshot.lighting),
    grid: normalizeGrid(snapshot.grid),
    viewSettings: normalizeViewSettings(snapshot.viewSettings),
    directorStudioShortcuts: normalizeDirectorStudioShortcuts(snapshot.directorStudioShortcuts),
    aspectFrame: normalizeAspectFrame(snapshot.aspectFrame, snapshot.aspectRatio ?? '16:9'),
    screenshotResolution: normalizeScreenshotResolution(snapshot.screenshotResolution),
    snapshotUrl: snapshot.snapshotUrl ?? null,
    snapshotHistory: normalizeSnapshotHistory(snapshot.snapshotUrl ?? null, snapshot.snapshotHistory),
    motionProject: snapshot.motionProject === undefined
      ? undefined
      : normalizeDirectorMotionProject(snapshot.motionProject),
  };
}

function isEditableEventTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) {
    return false;
  }
  return target.isContentEditable || target.matches('input, textarea, select');
}

function normalizeDirectorStudioShortcuts(
  shortcuts: DirectorStudioShortcutBindings | null | undefined,
): Record<DirectorStudioShortcutId, string> {
  return {
    ...DEFAULT_DIRECTOR_STUDIO_SHORTCUTS,
    ...(shortcuts ?? {}),
  };
}

function normalizeShortcutKeyName(key: string): string {
  if (key.length === 1) return key.toUpperCase();
  if (key === ' ') return 'Space';
  if (key === 'Esc') return 'Escape';
  return key;
}

function eventToShortcutBinding(event: KeyboardEvent): string | null {
  if (['Meta', 'Control', 'Shift', 'Alt'].includes(event.key)) return null;
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push('Cmd/Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey && event.key !== 'Shift') parts.push('Shift');
  parts.push(normalizeShortcutKeyName(event.key));
  return parts.join('+');
}

function parseShortcutBinding(binding: string): {
  key: string;
  primary: boolean;
  shift: boolean;
  alt: boolean;
} | null {
  const parts = binding.split('+').map((part) => part.trim()).filter(Boolean);
  const key = parts[parts.length - 1];
  if (!key) return null;
  const modifiers = parts.slice(0, -1).map((part) => part.toLowerCase());
  return {
    key: key.toLowerCase(),
    primary: modifiers.includes('cmd/ctrl') || modifiers.includes('cmd') || modifiers.includes('ctrl'),
    shift: modifiers.includes('shift'),
    alt: modifiers.includes('alt'),
  };
}

function shortcutMatchesEvent(event: KeyboardEvent, binding: string | null | undefined): boolean {
  if (!binding) return false;
  const parsed = parseShortcutBinding(binding);
  if (!parsed) return false;
  const eventKey = normalizeShortcutKeyName(event.key).toLowerCase();
  const primaryPressed = event.metaKey || event.ctrlKey;
  return (
    eventKey === parsed.key &&
    primaryPressed === parsed.primary &&
    event.shiftKey === parsed.shift &&
    event.altKey === parsed.alt
  );
}

function captureDirectorSnapshot(
  data: BlueprintNodeData,
  snapshotUrl: string | null | undefined
): DirectorStudioProjectSnapshot {
  const existingHistory = normalizeSnapshotHistory(data.snapshotUrl ?? null, data.snapshotHistory);
  return {
    mode: data.mode === 'panorama' ? 'panorama' : 'flat',
    backgroundImageUrl: data.backgroundImageUrl ?? null,
    backgroundPanoramaUrl: data.backgroundPanoramaUrl ?? null,
    items: cloneJson(data.items ?? []),
    referenceImages: cloneJson(data.referenceImages ?? []),
    customActionPresets: cloneJson(data.customActionPresets ?? []),
    customActionPoses: cloneJson(data.customActionPoses ?? {}),
    basePrompt: data.basePrompt ?? '',
    aspectRatio: data.aspectRatio ?? '16:9',
    camera: normalizeCamera(data.camera),
    lighting: normalizeLighting(data.lighting),
    grid: normalizeGrid(data.grid),
    viewSettings: normalizeViewSettings(data.viewSettings),
    directorStudioShortcuts: normalizeDirectorStudioShortcuts(data.directorStudioShortcuts),
    aspectFrame: normalizeAspectFrame(data.aspectFrame, data.aspectRatio ?? '16:9'),
    screenshotResolution: normalizeScreenshotResolution(data.screenshotResolution),
    snapshotUrl: snapshotUrl ?? data.snapshotUrl ?? null,
    snapshotHistory: appendSnapshotHistory(existingHistory, snapshotUrl ?? data.snapshotUrl ?? null),
    motionProject: data.motionProject === undefined
      ? undefined
      : normalizeDirectorMotionProject(data.motionProject),
  };
}

function createBlankSnapshot(): DirectorStudioProjectSnapshot {
  return {
    mode: 'flat',
    backgroundImageUrl: null,
    backgroundPanoramaUrl: null,
    items: [],
    referenceImages: [],
    customActionPresets: [],
    customActionPoses: {},
    basePrompt: '',
    aspectRatio: '16:9',
    camera: DEFAULT_CAMERA,
    lighting: DEFAULT_LIGHTING,
    grid: DEFAULT_GRID,
    viewSettings: DEFAULT_VIEW_SETTINGS,
    directorStudioShortcuts: DEFAULT_DIRECTOR_STUDIO_SHORTCUTS,
    aspectFrame: '16:9',
    screenshotResolution: '1080p',
    snapshotUrl: null,
    snapshotHistory: [],
    motionProject: undefined,
  };
}

function snapshotKey(snapshot: DirectorStudioProjectSnapshot): string {
  return JSON.stringify({
    mode: snapshot.mode,
    backgroundImageUrl: snapshot.backgroundImageUrl ?? null,
    backgroundPanoramaUrl: snapshot.backgroundPanoramaUrl ?? null,
    items: snapshot.items ?? [],
    referenceImages: snapshot.referenceImages ?? [],
    customActionPresets: snapshot.customActionPresets ?? [],
    customActionPoses: snapshot.customActionPoses ?? {},
    basePrompt: snapshot.basePrompt ?? '',
    aspectRatio: snapshot.aspectRatio ?? '16:9',
    camera: normalizeCamera(snapshot.camera),
    lighting: normalizeLighting(snapshot.lighting),
    grid: normalizeGrid(snapshot.grid),
    viewSettings: normalizeViewSettings(snapshot.viewSettings),
    directorStudioShortcuts: normalizeDirectorStudioShortcuts(snapshot.directorStudioShortcuts),
    aspectFrame: normalizeAspectFrame(snapshot.aspectFrame, snapshot.aspectRatio ?? '16:9'),
    screenshotResolution: normalizeScreenshotResolution(snapshot.screenshotResolution),
    snapshotUrl: snapshot.snapshotUrl ?? null,
    snapshotHistory: normalizeSnapshotHistory(snapshot.snapshotUrl ?? null, snapshot.snapshotHistory),
    motionProject: snapshot.motionProject === undefined
      ? undefined
      : normalizeDirectorMotionProject(snapshot.motionProject),
  });
}

function createProjectId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `director-project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getProjectCover(project: DirectorStudioProjectRecord): string | null {
  const snapshot = normalizeDirectorSnapshot(project.snapshot);
  const snapshotHistory = snapshot.snapshotHistory ?? [];
  const latestHistoryUrl = snapshotHistory[snapshotHistory.length - 1] ?? null;
  return project.coverUrl ?? snapshot.snapshotUrl ?? latestHistoryUrl;
}

function createInspectorTextDraft(item: BlueprintItem | null | undefined): InspectorTextDraft {
  return {
    itemId: item?.id ?? null,
    label: item?.label ?? '',
    relation: item?.relation ?? '',
    note: item?.note ?? '',
    action: item?.action ?? '',
  };
}

function buildInspectorTextPatch(
  item: BlueprintItem,
  draft: InspectorTextDraft
): Partial<BlueprintItem> {
  const patch: Partial<BlueprintItem> = {};
  if (item.label !== draft.label) patch.label = draft.label;
  if ((item.relation ?? '') !== draft.relation) patch.relation = draft.relation;
  if ((item.note ?? '') !== draft.note) patch.note = draft.note;
  if ((item.action ?? '') !== draft.action) patch.action = draft.action;
  return patch;
}

function hasObjectKeys(value: object): boolean {
  return Object.keys(value).length > 0;
}

function isDataImageUrl(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^data:image\//i.test(value);
}

async function persistDirectorStudioImageSource(source: string): Promise<string> {
  return isDataImageUrl(source) ? persistImageSource(source) : source;
}

async function waitForNextFrame(): Promise<void> {
  if (typeof window === 'undefined') return;
  await new Promise<void>((resolve) => {
    const timeoutId = window.setTimeout(resolve, 50);
    window.requestAnimationFrame(() => {
      window.clearTimeout(timeoutId);
      resolve();
    });
  });
}

function formatProjectTime(value: number): string {
  if (!Number.isFinite(value)) return '';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

interface ToolButtonSpec {
  key: string;
  label: string;
  title: string;
  icon: LucideIcon;
  disabled?: boolean;
  active?: boolean;
  onClick?: () => void;
}

interface TransformVectorBlockProps {
  title: string;
  values: { x: number; y: number; z: number };
  step: number;
  min: number;
  max: number;
  suffix?: string;
  onChange: (axis: VectorAxis, value: number) => void;
}

function TransformVectorBlock({ title, values, step, min, max, suffix = '', onChange }: TransformVectorBlockProps) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/18 p-3">
      <div className="mb-3 text-[11px] font-medium uppercase tracking-wide text-white/42">{title}</div>
      <div className="space-y-2">
        {(['x', 'y', 'z'] as const).map((axis) => (
          <label key={axis} className="grid grid-cols-[18px_minmax(0,1fr)_72px] items-center gap-2 text-xs text-white/70">
            <span className="font-mono uppercase text-white/50">{axis}</span>
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={values[axis]}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (Number.isFinite(next)) onChange(axis, next);
              }}
              className="min-w-0 accent-white"
            />
            <input
              type="number"
              min={min}
              max={max}
              step={step}
              value={Number(values[axis].toFixed(step < 1 ? 2 : 0))}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (Number.isFinite(next)) onChange(axis, next);
              }}
              className="h-8 rounded border border-white/12 bg-white/6 px-1.5 text-right font-mono text-[11px] text-white outline-none focus:border-white/30"
              aria-label={`${axis.toUpperCase()} ${title}${suffix}`}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

interface BodyScalarControlProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (value: number) => void;
}

function BodyScalarControl({ label, value, min, max, step, suffix = '', onChange }: BodyScalarControlProps) {
  return (
    <label className="grid grid-cols-[82px_minmax(0,1fr)_62px] items-center gap-2 text-xs text-white/70">
      <span className="truncate text-white/58">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
        className="min-w-0 accent-white"
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number(value.toFixed(step < 1 ? 2 : 0))}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
        className="h-7 rounded border border-white/12 bg-white/6 px-1.5 text-right font-mono text-[10px] text-white outline-none focus:border-white/30"
        aria-label={`${label}${suffix}`}
      />
    </label>
  );
}

interface DirectorSettingToggleProps {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

function DirectorSettingToggle({ label, description, checked, onChange }: DirectorSettingToggleProps) {
  return (
    <label className="flex items-start justify-between gap-3 rounded-md border border-white/10 bg-white/6 px-3 py-2 text-xs text-white/78">
      <span className="min-w-0">
        <span className="block text-white/82">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-[10px] leading-4 text-white/42">{description}</span>
        ) : null}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-white"
      />
    </label>
  );
}

export const DirectorStudioShell = memo(function DirectorStudioShell(props: DirectorStudioShellProps) {
  const {
    sourceNodeId,
    data,
    referenceImages,
    panoramaAssets = [],
    imageAssets = [],
    selectedItemId,
    onSelectedItemChange,
    onItemsChange,
    onUpdateNodeData,
    onAddSnapshotToCanvas,
    onAddVideoToCanvas,
    getLastRecordedVideoNodeId,
    recordRequest,
    onRecordRequestResult,
    onClose,
  } = props;
  const { t } = useTranslation();
  const defaultElementLabelBase = t('directorStudio.defaultLabels.element');
  const copyLabelSuffix = t('directorStudio.defaultLabels.copySuffix');
  const defaultPersonAction = t('directorStudio.actionValues.stand');
  const pedestrianLabelBase = t('directorStudio.defaultLabels.pedestrian');
  const inspectorActionPresets = useMemo(() => (
    INSPECTOR_ACTION_PRESETS.map((preset) => ({
      ...preset,
      value: t(preset.valueKey),
    }))
  ), [t]);
  const undoCanvas = useCanvasStore((s) => s.undo);
  const redoCanvas = useCanvasStore((s) => s.redo);
  const addCanvasNode = useCanvasStore((s) => s.addNode);
  const findCanvasNodePosition = useCanvasStore((s) => s.findNodePosition);
  const editorRef = useRef<BlueprintSceneHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const elementImageInputRef = useRef<HTMLInputElement | null>(null);
  const copiedItemRef = useRef<BlueprintItem | null>(null);
  const toolbarAnchorRefs = useRef<Record<string, HTMLElement | null>>({});
  const [panelMode, setPanelMode] = useState<PanelMode>('projects');
  const [floatingPanel, setFloatingPanel] = useState<FloatingPanel>(null);
  const [topFloatingSurface, setTopFloatingSurface] = useState<FloatingSurface>('side');
  const [activeDialog, setActiveDialog] = useState<DirectorStudioDialog>(null);
  const [activeModelCategory, setActiveModelCategory] = useState<DirectorStudioModelCategoryId>('basic');
  const [pedestrianMode, setPedestrianMode] = useState<PedestrianMode>('direct');
  const [pedestrianCount, setPedestrianCount] = useState(8);
  const [pedestrianColumns, setPedestrianColumns] = useState(4);
  const [pedestrianXSpacing, setPedestrianXSpacing] = useState(1.2);
  const [pedestrianZSpacing, setPedestrianZSpacing] = useState(1.2);
  const [pedestrianRadius, setPedestrianRadius] = useState(4);
  const [importOpen, setImportOpen] = useState(false);
  const [sidePanel, setSidePanel] = useState<SidePanel>(null);
  const [lightboxSnapshotUrl, setLightboxSnapshotUrl] = useState<string | null>(null);
  const [isUploadingPanorama, setIsUploadingPanorama] = useState(false);
  const [isUploadingElementImage, setIsUploadingElementImage] = useState(false);
  const [panoramaImportStage, setPanoramaImportStage] = useState<DirectorStudioPanoramaImportStage | null>(null);
  const [isAddingSnapshotToCanvas, setIsAddingSnapshotToCanvas] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editingProjectName, setEditingProjectName] = useState('');
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingItemName, setEditingItemName] = useState('');
  const [assetPickerItemId, setAssetPickerItemId] = useState<string | null>(null);
  const [assetQuery, setAssetQuery] = useState('');
  const [followSelectedItem, setFollowSelectedItem] = useState(false);
  const [activeTransformMode, setActiveTransformMode] = useState<DirectorStudioTransformMode | null>(null);
  const [editingShortcutId, setEditingShortcutId] = useState<DirectorStudioShortcutId | null>(null);
  const [customActionModalOpen, setCustomActionModalOpen] = useState(false);
  const [customActionName, setCustomActionName] = useState('');
  const [customActionPose, setCustomActionPose] = useState<BlueprintActionPose>({});
  const [viewportSize, setViewportSize] = useState(() => ({
    width: typeof window === 'undefined' ? 1440 : window.innerWidth,
    height: typeof window === 'undefined' ? 900 : window.innerHeight,
  }));
  const compactLayout = viewportSize.width < 1100;
  const mobileLayout = viewportSize.width < 640;
  const lowHeightLayout = viewportSize.height < 520;
  const [toolbarLayoutVersion, setToolbarLayoutVersion] = useState(0);
  const [sceneLoadAttempt, setSceneLoadAttempt] = useState(0);
  const BlueprintSceneComponent = useMemo(() => lazy(loadBlueprintScene), [sceneLoadAttempt]);
  const retryBlueprintScene = useCallback((error: Error) => {
    if (isDirectorSceneModuleLoadError(error)) {
      window.location.reload();
      return;
    }
    setSceneLoadAttempt((attempt) => attempt + 1);
  }, []);
  const [basePromptDraft, setBasePromptDraft] = useState(data.basePrompt ?? '');
  const [inspectorTextDraft, setInspectorTextDraft] = useState<InspectorTextDraft>(() =>
    createInspectorTextDraft(data.items.find((item) => item.id === selectedItemId) ?? null)
  );
  const latestDataRef = useRef(data);
  const latestItemsRef = useRef(data.items);
  const latestBasePromptRef = useRef(data.basePrompt ?? '');
  const onItemsChangeRef = useRef(onItemsChange);
  const onUpdateNodeDataRef = useRef(onUpdateNodeData);
  const onAddSnapshotToCanvasRef = useRef(onAddSnapshotToCanvas);
  const onCloseRef = useRef(onClose);
  const basePromptDraftRef = useRef(basePromptDraft);
  const basePromptDirtyRef = useRef(false);
  const basePromptCommitTimerRef = useRef<number | null>(null);
  const inspectorTextDraftRef = useRef(inspectorTextDraft);
  const inspectorTextDraftDirtyRef = useRef(false);
  const inspectorTextCommitTimerRef = useRef<number | null>(null);
  const commitPendingTextDraftsRef = useRef<() => boolean>(() => false);

  useEffect(() => {
    latestDataRef.current = data;
    latestItemsRef.current = data.items;
  }, [data]);

  useEffect(() => {
    onItemsChangeRef.current = onItemsChange;
  }, [onItemsChange]);

  useEffect(() => {
    onUpdateNodeDataRef.current = onUpdateNodeData;
  }, [onUpdateNodeData]);

  useEffect(() => {
    onAddSnapshotToCanvasRef.current = onAddSnapshotToCanvas;
  }, [onAddSnapshotToCanvas]);


  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const nextBasePrompt = data.basePrompt ?? '';
    latestBasePromptRef.current = nextBasePrompt;
    if (!basePromptDirtyRef.current) {
      basePromptDraftRef.current = nextBasePrompt;
      setBasePromptDraft(nextBasePrompt);
    }
  }, [data.basePrompt]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    const handleResize = () => setViewportSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const projects = useMemo(
    () => [...(data.directorStudioProjects ?? [])].sort((a, b) => b.updatedAt - a.updatedAt),
    [data.directorStudioProjects],
  );

  const activeProject = useMemo(
    () => projects.find((project) => project.id === data.activeDirectorStudioProjectId) ?? null,
    [data.activeDirectorStudioProjectId, projects],
  );

  const currentSnapshot = useMemo(
    () => captureDirectorSnapshot(data, data.snapshotUrl ?? null),
    [data],
  );

  const snapshotHistory = useMemo(
    () => normalizeSnapshotHistory(data.snapshotUrl ?? null, data.snapshotHistory),
    [data.snapshotHistory, data.snapshotUrl],
  );

  const hasUnsavedChanges = useMemo(() => {
    if (activeProject) {
      return snapshotKey(normalizeDirectorSnapshot(activeProject.snapshot)) !== snapshotKey(currentSnapshot);
    }
    return snapshotKey(currentSnapshot) !== snapshotKey(createBlankSnapshot());
  }, [activeProject, currentSnapshot]);

  const selectedItem = useMemo(
    () => data.items.find((item) => item.id === selectedItemId) ?? null,
    [data.items, selectedItemId],
  );
  const customActionPresets = useMemo(
    () => getUniqueActionPresets(data.customActionPresets),
    [data.customActionPresets],
  );

  const updateItem = useCallback((itemId: string, patch: Partial<BlueprintItem>) => {
    const nextItems = latestItemsRef.current.map((item) =>
      item.id === itemId ? { ...item, ...patch } : item
    );
    latestItemsRef.current = nextItems;
    latestDataRef.current = { ...latestDataRef.current, items: nextItems };
    onItemsChangeRef.current(nextItems);
  }, []);

  const updateItemActionImmediately = useCallback((item: BlueprintItem, action: string) => {
    const hadPendingTextDraft =
      inspectorTextDraftDirtyRef.current && inspectorTextDraftRef.current.itemId === item.id;
    if (!hadPendingTextDraft && inspectorTextCommitTimerRef.current !== null) {
      window.clearTimeout(inspectorTextCommitTimerRef.current);
      inspectorTextCommitTimerRef.current = null;
    }
    const baseDraft = inspectorTextDraftRef.current.itemId === item.id
      ? inspectorTextDraftRef.current
      : createInspectorTextDraft(item);
    const nextDraft = {
      ...baseDraft,
      action,
    };
    inspectorTextDraftRef.current = nextDraft;
    inspectorTextDraftDirtyRef.current = hadPendingTextDraft;
    setInspectorTextDraft(nextDraft);
    updateItem(item.id, { action });
  }, [updateItem]);

  const {
    motionProject,
    motionTimeSource,
    playbackSource,
    timelineOpen,
    setTimelineOpen,
    setMotionPlaying,
    motionSelection,
    setMotionSelection,
    motionShowRoutes,
    setMotionShowRoutes,
    motionPreviewMode,
    pilotActive,
    setPilotActive,
    pilotTargetId,
    setPilotTargetId,
    actionLibraryOpen,
    setActionLibraryOpen,
    videoExportOpen,
    setVideoExportOpen,
    videoExportResolution,
    setVideoExportResolution,
    videoExportFps,
    setVideoExportFps,
    videoExportRecording,
    videoExportProgress,
    videoExportError,
    videoExportResult,
    availableVideoFormat,
    updateMotionProject,
    patchMotionKeyframe,
    moveMotionKeyframe,
    duplicateMotionKeyframe,
    deleteMotionKeyframe,
    addCameraMotionKeyframe,
    recordPilotCamera,
    addObjectMotionKeyframe,
    addActionMotionKeyframe,
    updateMotionDuration,
    applyMotionActionState,
    saveMotionClip,
    updateMotionClip,
    duplicateMotionClip,
    deleteMotionClip,
    applyCameraPreset,
    setMotionTimeAndApply,
    selectMotionRouteKeyframe,
    moveMotionRouteKeyframe,
    insertMotionRouteKeyframe,
    setPreviewModeAndApply,
    toggleCameraPilot,
    openVideoExport,
    startVideoExport,
    cancelVideoExport,
    saveVideoExport,
    addVideoExportToCanvas,
    stopMotionActivity,
  } = useDirectorStudioMotion({
    data,
    selectedItem,
    editorRef,
    onUpdateNodeData,
    onUpdateItemAction: updateItemActionImmediately,
    onAddVideoToCanvas,
  });

  const handledRecordRequestIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!recordRequest || recordRequest.nodeId !== sourceNodeId) return;
    if (handledRecordRequestIdRef.current === recordRequest.requestId) return;
    handledRecordRequestIdRef.current = recordRequest.requestId;
    void startVideoExport(recordRequest).then((result) => {
      if (!result) {
        throw new Error(t('directorStudio.motion.export.failed'));
      }
      onRecordRequestResult?.({
        requestId: recordRequest.requestId,
        nodeId: sourceNodeId,
        resultNodeId: result && recordRequest.addToCanvas
          ? getLastRecordedVideoNodeId?.() ?? undefined
          : undefined,
      });
    }).catch((error) => {
      onRecordRequestResult?.({
        requestId: recordRequest.requestId,
        nodeId: sourceNodeId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, [getLastRecordedVideoNodeId, onRecordRequestResult, recordRequest, sourceNodeId, startVideoExport, t]);

  const commitInspectorTextDraft = useCallback(() => {
    if (inspectorTextCommitTimerRef.current !== null) {
      window.clearTimeout(inspectorTextCommitTimerRef.current);
      inspectorTextCommitTimerRef.current = null;
    }

    const draft = inspectorTextDraftRef.current;
    if (!draft.itemId || !inspectorTextDraftDirtyRef.current) return false;

    const currentItems = latestItemsRef.current;
    const currentItem = currentItems.find((item) => item.id === draft.itemId);
    if (!currentItem) {
      inspectorTextDraftDirtyRef.current = false;
      return false;
    }

    const patch = buildInspectorTextPatch(currentItem, draft);
    inspectorTextDraftDirtyRef.current = false;
    if (!hasObjectKeys(patch)) return false;

    const nextItems = currentItems.map((item) =>
      item.id === draft.itemId ? { ...item, ...patch } : item
    );
    latestItemsRef.current = nextItems;
    latestDataRef.current = { ...latestDataRef.current, items: nextItems };
    onItemsChangeRef.current(nextItems);
    return true;
  }, []);

  const commitBasePromptDraft = useCallback(() => {
    if (basePromptCommitTimerRef.current !== null) {
      window.clearTimeout(basePromptCommitTimerRef.current);
      basePromptCommitTimerRef.current = null;
    }

    if (!basePromptDirtyRef.current) return false;
    const nextBasePrompt = basePromptDraftRef.current;
    basePromptDirtyRef.current = false;
    if ((latestBasePromptRef.current ?? '') === nextBasePrompt) return false;

    latestBasePromptRef.current = nextBasePrompt;
    latestDataRef.current = { ...latestDataRef.current, basePrompt: nextBasePrompt };
    onUpdateNodeDataRef.current({ basePrompt: nextBasePrompt });
    return true;
  }, []);

  const commitPendingTextDrafts = useCallback(() => {
    const committedInspector = commitInspectorTextDraft();
    const committedPrompt = commitBasePromptDraft();
    return committedInspector || committedPrompt;
  }, [commitBasePromptDraft, commitInspectorTextDraft]);

  useEffect(() => {
    commitPendingTextDraftsRef.current = commitPendingTextDrafts;
  }, [commitPendingTextDrafts]);

  const getDirectorDataWithTextDrafts = useCallback((): BlueprintNodeData => {
    const sourceData = latestDataRef.current;
    let nextData = sourceData;

    if (basePromptDirtyRef.current && (sourceData.basePrompt ?? '') !== basePromptDraftRef.current) {
      nextData = { ...nextData, basePrompt: basePromptDraftRef.current };
    }

    const draft = inspectorTextDraftRef.current;
    if (draft.itemId && inspectorTextDraftDirtyRef.current) {
      const currentItem = (nextData.items ?? []).find((item) => item.id === draft.itemId);
      if (currentItem) {
        const patch = buildInspectorTextPatch(currentItem, draft);
        if (hasObjectKeys(patch)) {
          nextData = {
            ...nextData,
            items: nextData.items.map((item) =>
              item.id === draft.itemId ? { ...item, ...patch } : item
            ),
          };
        }
      }
    }

    return nextData;
  }, []);

  const scheduleInspectorTextDraftCommit = useCallback(() => {
    if (inspectorTextCommitTimerRef.current !== null) {
      window.clearTimeout(inspectorTextCommitTimerRef.current);
    }
    inspectorTextCommitTimerRef.current = window.setTimeout(() => {
      commitInspectorTextDraft();
    }, TEXT_DRAFT_COMMIT_DELAY_MS);
  }, [commitInspectorTextDraft]);

  const scheduleBasePromptDraftCommit = useCallback(() => {
    if (basePromptCommitTimerRef.current !== null) {
      window.clearTimeout(basePromptCommitTimerRef.current);
    }
    basePromptCommitTimerRef.current = window.setTimeout(() => {
      commitBasePromptDraft();
    }, TEXT_DRAFT_COMMIT_DELAY_MS);
  }, [commitBasePromptDraft]);

  const updateInspectorTextDraft = useCallback((field: InspectorTextField, value: string) => {
    if (!selectedItem) return;
    const baseDraft = inspectorTextDraftRef.current.itemId === selectedItem.id
      ? inspectorTextDraftRef.current
      : createInspectorTextDraft(selectedItem);
    const nextDraft = { ...baseDraft, [field]: value };
    inspectorTextDraftRef.current = nextDraft;
    inspectorTextDraftDirtyRef.current = true;
    setInspectorTextDraft(nextDraft);
    scheduleInspectorTextDraftCommit();
  }, [scheduleInspectorTextDraftCommit, selectedItem]);

  const updateBasePromptDraft = useCallback((value: string) => {
    basePromptDraftRef.current = value;
    basePromptDirtyRef.current = true;
    setBasePromptDraft(value);
    scheduleBasePromptDraftCommit();
  }, [scheduleBasePromptDraftCommit]);

  useEffect(() => {
    const nextDraft = createInspectorTextDraft(selectedItem);
    const currentDraft = inspectorTextDraftRef.current;

    if (currentDraft.itemId !== nextDraft.itemId) {
      if (inspectorTextDraftDirtyRef.current) {
        commitInspectorTextDraft();
      }
      if (inspectorTextCommitTimerRef.current !== null) {
        window.clearTimeout(inspectorTextCommitTimerRef.current);
        inspectorTextCommitTimerRef.current = null;
      }
      inspectorTextDraftDirtyRef.current = false;
      inspectorTextDraftRef.current = nextDraft;
      setInspectorTextDraft(nextDraft);
      return;
    }

    if (!inspectorTextDraftDirtyRef.current) {
      inspectorTextDraftRef.current = nextDraft;
      setInspectorTextDraft(nextDraft);
    }
  }, [
    commitInspectorTextDraft,
    selectedItem,
    selectedItem?.action,
    selectedItem?.id,
    selectedItem?.label,
    selectedItem?.note,
    selectedItem?.relation,
  ]);

  useEffect(() => () => {
    commitPendingTextDraftsRef.current();
    if (inspectorTextCommitTimerRef.current !== null) {
      window.clearTimeout(inspectorTextCommitTimerRef.current);
    }
    if (basePromptCommitTimerRef.current !== null) {
      window.clearTimeout(basePromptCommitTimerRef.current);
    }
  }, []);

  const selectedActionValue = inspectorTextDraft.itemId === selectedItem?.id
    ? inspectorTextDraft.action.trim()
    : (selectedItem?.action?.trim() ?? '');

  const displayItems = useMemo(
    () => getDirectorStudioDisplayItems(data.items),
    [data.items],
  );

  const bringFloatingSurfaceToFront = useCallback((surface: FloatingSurface) => {
    setTopFloatingSurface(surface);
  }, []);

  const showSidePanel = useCallback((panel: SidePanel) => {
    setTopFloatingSurface('side');
    setSidePanel(panel);
    if (compactLayout && panel) setPanelOpen(false);
  }, [compactLayout]);

  const toggleSidePanel = useCallback((panel: Exclude<SidePanel, null>) => {
    setTopFloatingSurface('side');
    const nextPanel = sidePanel === panel ? null : panel;
    setSidePanel(nextPanel);
    if (compactLayout && nextPanel) setPanelOpen(false);
  }, [compactLayout, sidePanel]);

  useEffect(() => {
    if (compactLayout && sidePanel) setPanelOpen(false);
  }, [compactLayout, sidePanel]);

  useEffect(() => {
    if (compactLayout) setPanelOpen(false);
  }, [compactLayout]);

  useLayoutEffect(() => {
    if (lowHeightLayout) setTimelineOpen(false);
  }, [lowHeightLayout, setTimelineOpen]);

  const selectItemForEditing = useCallback((itemId: string | null) => {
    commitPendingTextDrafts();
    setMotionSelection(null);
    onSelectedItemChange(itemId);
    setFollowSelectedItem(false);
    if (!itemId) {
      setActiveTransformMode(null);
      return;
    }
    setActiveTransformMode('move');
    showSidePanel('inspector');
    setPanelMode('elements');
  }, [commitPendingTextDrafts, onSelectedItemChange, setMotionSelection, showSidePanel]);

  const handleClose = useCallback(() => {
    commitPendingTextDrafts();
    stopMotionActivity();
    onCloseRef.current();
  }, [commitPendingTextDrafts, stopMotionActivity]);

  useEffect(() => {
    if (!selectedItem && activeTransformMode) {
      setActiveTransformMode(null);
    }
  }, [activeTransformMode, selectedItem]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableEventTarget(event.target)) return;
      if (event.key !== 'Escape') return;
      if (pilotActive || actionLibraryOpen || videoExportOpen || customActionModalOpen) return;
      if (activeTransformMode) {
        setActiveTransformMode(null);
        event.preventDefault();
        return;
      }
      if (activeDialog) {
        setActiveDialog(null);
        event.preventDefault();
        return;
      }
      if (importOpen) {
        setImportOpen(false);
        event.preventDefault();
        return;
      }
      if (assetPickerItemId) {
        setAssetPickerItemId(null);
        event.preventDefault();
        return;
      }
      if (lightboxSnapshotUrl) {
        setLightboxSnapshotUrl(null);
        event.preventDefault();
        return;
      }
      if (sidePanel) {
        setSidePanel(null);
        event.preventDefault();
        return;
      }
      handleClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [actionLibraryOpen, activeDialog, activeTransformMode, assetPickerItemId, customActionModalOpen, handleClose, importOpen, lightboxSnapshotUrl, pilotActive, sidePanel, videoExportOpen]);

  const camera = useMemo(() => normalizeCamera(data.camera), [data.camera]);
  const lighting = useMemo(() => normalizeLighting(data.lighting), [data.lighting]);
  const grid = useMemo(() => normalizeGrid(data.grid), [data.grid]);
  const viewSettings = useMemo(() => normalizeViewSettings(data.viewSettings), [data.viewSettings]);
  const shortcuts = useMemo(
    () => normalizeDirectorStudioShortcuts(data.directorStudioShortcuts),
    [data.directorStudioShortcuts],
  );
  const aspectFrame = useMemo(
    () => normalizeAspectFrame(data.aspectFrame, data.aspectRatio ?? '16:9'),
    [data.aspectFrame, data.aspectRatio],
  );
  const screenshotResolution = useMemo(
    () => normalizeScreenshotResolution(data.screenshotResolution),
    [data.screenshotResolution],
  );

  const selectedAspect = useMemo(
    () => ASPECT_FRAMES.find((frame) => frame.value === aspectFrame) ?? ASPECT_FRAMES[4],
    [aspectFrame],
  );

  const panoramaImportAssets = useMemo(() => {
    const byUrl = new Map<string, BlueprintReferenceImage>();
    panoramaAssets.forEach((image, index) => {
      if (!image?.url || byUrl.has(image.url)) return;
      byUrl.set(image.url, {
        id: image.id ?? `asset-${index}`,
        url: image.url,
        label: image.label || t('directorStudio.panoramaAssetFallbackName', { count: index + 1 }),
        color: image.color,
      });
    });
    return Array.from(byUrl.values());
  }, [panoramaAssets, t]);

  const elementReferenceAssets = useMemo(() => {
    const byUrl = new Map<string, BlueprintReferenceImage>();
    [...imageAssets, ...referenceImages, ...panoramaAssets].forEach((image, index) => {
      if (!image?.url || byUrl.has(image.url)) return;
      byUrl.set(image.url, {
        id: image.id ?? `asset-${index}`,
        url: image.url,
        label: image.label || t('directorStudio.assetFallbackName', { count: index + 1 }),
        color: image.color,
      });
    });
    return Array.from(byUrl.values());
  }, [imageAssets, panoramaAssets, referenceImages, t]);

  const elementAssetOptions = useMemo(() => {
    const query = assetQuery.trim().toLowerCase();
    if (!query) return elementReferenceAssets;
    return elementReferenceAssets.filter((image) =>
      image.label.toLowerCase().includes(query) || image.id.toLowerCase().includes(query)
    );
  }, [assetQuery, elementReferenceAssets]);

  const assetPickerItem = useMemo(
    () => data.items.find((item) => item.id === assetPickerItemId) ?? null,
    [assetPickerItemId, data.items],
  );

  const modelCards = useMemo(
    () => DIRECTOR_STUDIO_MODEL_CATALOG.filter((item) => item.categoryId === activeModelCategory),
    [activeModelCategory],
  );

  const computeScreenshotExportOptions = useCallback((): BlueprintSceneExportOptions => {
    const ratio = selectedAspect.ratio;
    const resolution = SCREENSHOT_RESOLUTIONS.find((item) => item.value === screenshotResolution)
      ?? SCREENSHOT_RESOLUTIONS[0];
    const base = resolution.base;
    if (!ratio) {
      const viewportWidth = Math.max(320, viewportSize.width);
      const viewportHeight = Math.max(320, viewportSize.height);
      const sceneRatio = viewportWidth / viewportHeight;
      return {
        targetWidth: Math.max(1, Math.round(base * sceneRatio)),
        targetHeight: base,
      };
    }
    const targetWidth = ratio >= 1 ? Math.round(base * ratio) : base;
    const targetHeight = ratio >= 1 ? base : Math.round(base / ratio);
    return {
      frameAspect: ratio,
      targetWidth,
      targetHeight,
    };
  }, [screenshotResolution, selectedAspect.ratio, viewportSize.height, viewportSize.width]);

  const persistSnapshotHistory = useCallback(async (history: string[]) => {
    return await Promise.all(history.map((snapshotUrl) => persistDirectorStudioImageSource(snapshotUrl)));
  }, []);

  const capturePersistedSceneSnapshot = useCallback(async (fallbackUrl: string | null | undefined) => {
    const rawSnapshotUrl = editorRef.current?.exportPng(computeScreenshotExportOptions()) ?? fallbackUrl ?? null;
    if (!rawSnapshotUrl) return null;
    return await persistDirectorStudioImageSource(rawSnapshotUrl);
  }, [computeScreenshotExportOptions]);

  const saveProject = useCallback(async () => {
    const hadDraftWrites = commitPendingTextDrafts();
    if (hadDraftWrites) {
      await waitForNextFrame();
    }

    try {
      const effectiveData = getDirectorDataWithTextDrafts();
      const now = Date.now();
      const currentCapture = await capturePersistedSceneSnapshot(
        effectiveData.snapshotUrl ?? activeProject?.coverUrl ?? null
      );
      const persistedHistory = await persistSnapshotHistory(
        normalizeSnapshotHistory(effectiveData.snapshotUrl ?? null, effectiveData.snapshotHistory)
      );
      const dataForSnapshot = {
        ...effectiveData,
        snapshotUrl: currentCapture,
        snapshotHistory: persistedHistory,
      };
      const snapshot = captureDirectorSnapshot(dataForSnapshot, currentCapture);
      const currentProjects = effectiveData.directorStudioProjects ?? [];
      const activeId = effectiveData.activeDirectorStudioProjectId;
      const activeIndex = activeId ? currentProjects.findIndex((project) => project.id === activeId) : -1;
      const nextProject: DirectorStudioProjectRecord = activeIndex >= 0
        ? {
            ...currentProjects[activeIndex],
            updatedAt: now,
            coverUrl: currentCapture,
            snapshot,
          }
        : {
            id: createProjectId(),
            name: t('directorStudio.defaultProjectName', { count: currentProjects.length + 1 }),
            createdAt: now,
            updatedAt: now,
            coverUrl: currentCapture,
            snapshot,
          };
      const nextProjects = activeIndex >= 0
        ? currentProjects.map((project, index) => index === activeIndex ? nextProject : project)
        : [...currentProjects, nextProject];

      const nextPatch = {
        ...snapshot,
        snapshotUrl: currentCapture,
        directorStudioProjects: nextProjects,
        activeDirectorStudioProjectId: nextProject.id,
      };
      latestDataRef.current = { ...latestDataRef.current, ...nextPatch };
      onUpdateNodeData(nextPatch);

      return { projectId: nextProject.id, projects: nextProjects };
    } catch (error) {
      await showErrorDialog(
        error instanceof Error ? error.message : t('directorStudio.addToCanvasFailed'),
        t('common.error'),
      );
      return null;
    }
  }, [
    activeProject?.coverUrl,
    capturePersistedSceneSnapshot,
    commitPendingTextDrafts,
    getDirectorDataWithTextDrafts,
    onUpdateNodeData,
    persistSnapshotHistory,
    t,
  ]);

  const restoreProject = useCallback(async (project: DirectorStudioProjectRecord) => {
    if (project.id === data.activeDirectorStudioProjectId) return;
    if (hasUnsavedChanges && window.confirm(t('directorStudio.confirmSaveBeforeSwitch'))) {
      const saved = await saveProject();
      if (!saved) return;
    }
    const snapshot = normalizeDirectorSnapshot(project.snapshot);
    selectItemForEditing(null);
    onUpdateNodeData({
      ...snapshot,
      activeDirectorStudioProjectId: project.id,
    });
  }, [
    data.activeDirectorStudioProjectId,
    hasUnsavedChanges,
    onUpdateNodeData,
    saveProject,
    selectItemForEditing,
    t,
  ]);

  const deleteProject = useCallback((project: DirectorStudioProjectRecord) => {
    if (!window.confirm(t('directorStudio.confirmDeleteProject', { name: project.name }))) return;
    const nextProjects = (data.directorStudioProjects ?? []).filter((item) => item.id !== project.id);
    onUpdateNodeData({
      directorStudioProjects: nextProjects,
      activeDirectorStudioProjectId:
        data.activeDirectorStudioProjectId === project.id ? null : data.activeDirectorStudioProjectId ?? null,
    });
  }, [data.activeDirectorStudioProjectId, data.directorStudioProjects, onUpdateNodeData, t]);

  const updateProjectCover = useCallback(async (project: DirectorStudioProjectRecord) => {
    try {
      const coverUrl = await capturePersistedSceneSnapshot(
        data.snapshotUrl ?? normalizeDirectorSnapshot(project.snapshot).snapshotUrl ?? null
      );
      if (!coverUrl) {
        window.alert(t('directorStudio.noSnapshotForCover'));
        return;
      }
      onUpdateNodeData({
        directorStudioProjects: (data.directorStudioProjects ?? []).map((item) =>
          item.id === project.id
            ? { ...item, coverUrl, updatedAt: Date.now() }
            : item
        ),
      });
    } catch (error) {
      await showErrorDialog(
        error instanceof Error ? error.message : t('directorStudio.addToCanvasFailed'),
        t('common.error'),
      );
    }
  }, [capturePersistedSceneSnapshot, data.directorStudioProjects, data.snapshotUrl, onUpdateNodeData, t]);

  const beginEditProjectName = useCallback((project: DirectorStudioProjectRecord) => {
    setEditingProjectId(project.id);
    setEditingProjectName(project.name);
  }, []);

  const commitProjectName = useCallback(() => {
    if (!editingProjectId) return;
    const nextName = editingProjectName.trim() || t('directorStudio.untitledProject');
    onUpdateNodeData({
      directorStudioProjects: (data.directorStudioProjects ?? []).map((project) =>
        project.id === editingProjectId
          ? { ...project, name: nextName, updatedAt: Date.now() }
          : project
      ),
    });
    setEditingProjectId(null);
    setEditingProjectName('');
  }, [data.directorStudioProjects, editingProjectId, editingProjectName, onUpdateNodeData, t]);

  const createBlankWorkspace = useCallback(async () => {
    let nextProjects = data.directorStudioProjects ?? [];
    if (hasUnsavedChanges) {
      if (!window.confirm(t('directorStudio.confirmSaveBeforeNew'))) return;
      const saved = await saveProject();
      if (!saved) return;
      nextProjects = saved.projects;
    }
    const blank = createBlankSnapshot();
    selectItemForEditing(null);
    onUpdateNodeData({
      ...blank,
      directorStudioProjects: nextProjects,
      activeDirectorStudioProjectId: null,
    });
  }, [data.directorStudioProjects, hasUnsavedChanges, onUpdateNodeData, saveProject, selectItemForEditing, t]);

  const deleteSelectedItem = useCallback(() => {
    if (!selectedItem) return;
    setActiveTransformMode(null);
    const nextItems = data.items.filter((item) => item.id !== selectedItem.id);
    if (data.motionProject === undefined) {
      onItemsChange(nextItems);
    } else {
      const nextMotionProject = normalizeDirectorMotionProject(data.motionProject);
      const objectTracks = { ...nextMotionProject.objectTracks };
      const actionTracks = { ...nextMotionProject.actionTracks };
      delete objectTracks[selectedItem.id];
      delete actionTracks[selectedItem.id];
      onUpdateNodeData({
        items: nextItems,
        motionProject: { ...nextMotionProject, objectTracks, actionTracks },
      });
    }
    selectItemForEditing(null);
  }, [data.items, data.motionProject, onItemsChange, onUpdateNodeData, selectItemForEditing, selectedItem]);

  const copySelectedItem = useCallback(() => {
    if (!selectedItem) return false;
    copiedItemRef.current = selectedItem;
    return true;
  }, [selectedItem]);

  const pasteCopiedItem = useCallback(() => {
    const source = copiedItemRef.current;
    if (!source) return false;
    const pos = ensurePos3d(source);
    const nextPos = { x: pos.x + 0.6, y: pos.y, z: pos.z + 0.6 };
    const legacy = pos3dToLegacy(nextPos);
    const labelBase = getCopyLabelBase(source.label, defaultElementLabelBase, copyLabelSuffix);
    const nextItem: BlueprintItem = {
      ...source,
      id: genBlueprintItemId(),
      label: `${labelBase}${getNextLabelIndex(data.items, labelBase)}`,
      x: legacy.x,
      y: legacy.y,
      pos3d: nextPos,
      rotation3d: source.rotation3d ? { ...source.rotation3d } : undefined,
      scale3d: source.scale3d ? { ...source.scale3d } : undefined,
    };
    onItemsChange([...data.items, nextItem]);
    selectItemForEditing(nextItem.id);
    setPanelMode('elements');
    copiedItemRef.current = nextItem;
    return true;
  }, [copyLabelSuffix, data.items, defaultElementLabelBase, onItemsChange, selectItemForEditing]);

  const saveCurrentActionPreset = useCallback(() => {
    commitInspectorTextDraft();
    const action = selectedActionValue;
    if (!action) return;
    onUpdateNodeData({
      customActionPresets: getUniqueActionPresets([...(data.customActionPresets ?? []), action]),
    });
  }, [commitInspectorTextDraft, data.customActionPresets, onUpdateNodeData, selectedActionValue]);

  const openCustomActionEditor = useCallback(() => {
    if (!selectedItem || selectedItem.category !== 'person') return;
    commitInspectorTextDraft();
    const actionName = selectedActionValue || t('directorStudio.inspector.customActionDefaultName');
    setCustomActionName(actionName);
    setCustomActionPose(cloneJson(data.customActionPoses?.[actionName] ?? {}));
    setCustomActionModalOpen(true);
  }, [commitInspectorTextDraft, data.customActionPoses, selectedActionValue, selectedItem, t]);

  const saveCustomActionPose = useCallback(() => {
    if (!selectedItem) return;
    const actionName = customActionName.trim() || t('directorStudio.inspector.customActionDefaultName');
    onUpdateNodeData({
      customActionPresets: getUniqueActionPresets([...(data.customActionPresets ?? []), actionName]),
      customActionPoses: {
        ...(data.customActionPoses ?? {}),
        [actionName]: customActionPose,
      },
    });
    updateItemActionImmediately(selectedItem, actionName);
    setCustomActionModalOpen(false);
  }, [
    customActionName,
    customActionPose,
    data.customActionPoses,
    data.customActionPresets,
    onUpdateNodeData,
    selectedItem,
    t,
    updateItemActionImmediately,
  ]);

  const deleteCustomActionPreset = useCallback((preset: string) => {
    if (!window.confirm(t('directorStudio.inspector.confirmDeleteActionPreset', { name: preset }))) return;
    const normalizedPreset = normalizeActionValue(preset);
    const nextCustomActionPoses = { ...(data.customActionPoses ?? {}) };
    Object.keys(nextCustomActionPoses).forEach((poseName) => {
      if (normalizeActionValue(poseName) === normalizedPreset) {
        delete nextCustomActionPoses[poseName];
      }
    });
    onUpdateNodeData({
      customActionPresets: getUniqueActionPresets(data.customActionPresets).filter(
        (item) => normalizeActionValue(item) !== normalizedPreset,
      ),
      customActionPoses: nextCustomActionPoses,
    });
  }, [data.customActionPoses, data.customActionPresets, onUpdateNodeData, t]);

  const beginRenameItem = useCallback((item: BlueprintItem) => {
    setEditingItemId(item.id);
    setEditingItemName(item.label);
  }, []);

  const commitRenameItem = useCallback(() => {
    if (!editingItemId) return;
    const nextName = editingItemName.trim();
    if (nextName) updateItem(editingItemId, { label: nextName });
    setEditingItemId(null);
    setEditingItemName('');
  }, [editingItemId, editingItemName, updateItem]);

  const openElementAssetPicker = useCallback((itemId: string) => {
    setAssetPickerItemId(itemId);
    setAssetQuery('');
  }, []);

  const chooseElementAsset = useCallback((asset: BlueprintReferenceImage) => {
    if (!assetPickerItemId) return;
    updateItem(assetPickerItemId, {
      refImageUrl: asset.url,
      refImageName: asset.label,
    });
    setAssetPickerItemId(null);
    setAssetQuery('');
  }, [assetPickerItemId, updateItem]);

  const clearElementAsset = useCallback((itemId: string) => {
    updateItem(itemId, { refImageUrl: null, refImageName: null });
  }, [updateItem]);

  const uploadElementAsset = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !assetPickerItem) return;
    setIsUploadingElementImage(true);
    try {
      const prepared = await prepareNodeImageFromFile(file);
      const imageUrl = prepared.imageUrl || prepared.previewImageUrl;
      const label = file.name?.trim() || t('directorStudio.linkedImage.uploadedFallbackName');
      const uploadPosition = findCanvasNodePosition(sourceNodeId, 320, 260);
      const uploadNodeId = addCanvasNode(CANVAS_NODE_TYPES.upload, uploadPosition, {
        imageUrl,
        previewImageUrl: prepared.previewImageUrl ?? null,
        aspectRatio: prepared.aspectRatio || '1:1',
        sourceFileName: file.name,
        displayName: label,
      });
      const nextReferenceImages = [...(data.referenceImages ?? [])];
      if (!nextReferenceImages.some((image) => image.url === imageUrl)) {
        nextReferenceImages.push({
          id: `upload-${uploadNodeId}`,
          url: imageUrl,
          label,
          color: assetPickerItem.color,
        });
      }
      onUpdateNodeData({
        referenceImages: nextReferenceImages,
        items: data.items.map((item) =>
          item.id === assetPickerItem.id
            ? {
                ...item,
                refImageUrl: imageUrl,
                refImageName: label,
              }
            : item
        ),
      });
      setAssetPickerItemId(null);
      setAssetQuery('');
    } catch (error) {
      console.error('Director Studio linked image upload failed', error);
      await showErrorDialog(
        error instanceof Error ? error.message : t('directorStudio.linkedImage.uploadFailed'),
        t('common.error'),
      );
    } finally {
      setIsUploadingElementImage(false);
    }
  }, [
    addCanvasNode,
    assetPickerItem,
    data.items,
    data.referenceImages,
    findCanvasNodePosition,
    onUpdateNodeData,
    sourceNodeId,
    t,
  ]);

  const updateItemPosition = useCallback((item: BlueprintItem, axis: VectorAxis, value: number) => {
    const current = ensurePos3d(item);
    const nextPos = { ...current, [axis]: value };
    const legacy = pos3dToLegacy(nextPos);
    updateItem(item.id, { pos3d: nextPos, x: legacy.x, y: legacy.y });
  }, [updateItem]);

  const updateItemRotationDegrees = useCallback((item: BlueprintItem, axis: VectorAxis, degrees: number) => {
    const current = item.rotation3d ?? { x: 0, y: 0, z: 0 };
    updateItem(item.id, {
      rotation3d: {
        ...current,
        [axis]: degrees * Math.PI / 180,
      },
    });
  }, [updateItem]);

  const updateItemScale = useCallback((item: BlueprintItem, axis: VectorAxis, value: number) => {
    const current = item.scale3d ?? { x: 1, y: 1, z: 1 };
    updateItem(item.id, {
      scale3d: {
        ...current,
        [axis]: clampNumber(value, 1, 0.1, 5),
      },
    });
  }, [updateItem]);

  const updateItemBodyControls = useCallback((item: BlueprintItem, patch: Partial<BlueprintBodyControls>) => {
    updateItem(item.id, {
      bodyControls: {
        ...(item.bodyControls ?? {}),
        ...patch,
      },
    });
  }, [updateItem]);

  const updateItemBodySection = useCallback((
    item: BlueprintItem,
    section: 'core' | 'arms' | 'legs',
    patch: NonNullable<BlueprintBodyControls[typeof section]>,
  ) => {
    updateItem(item.id, {
      bodyControls: {
        ...(item.bodyControls ?? {}),
        [section]: {
          ...(item.bodyControls?.[section] ?? {}),
          ...patch,
        },
      },
    });
  }, [updateItem]);

  const appendAndSelectItems = useCallback((itemsToAdd: BlueprintItem[]) => {
    if (itemsToAdd.length === 0) return;
    onItemsChange([...data.items, ...itemsToAdd]);
    selectItemForEditing(itemsToAdd[0].id);
    setPanelMode('elements');
    if (!compactLayout) setPanelOpen(true);
  }, [compactLayout, data.items, onItemsChange, selectItemForEditing]);

  const getSuggestedInsertPosition = useCallback(() => (
    editorRef.current?.getSuggestedInsertPosition() ?? DEFAULT_INSERT_POSITION
  ), []);

  const insertModel = useCallback((model: DirectorStudioModelCatalogItem) => {
    const pos3d = getSuggestedInsertPosition();
    const labelBase = t(getModelLabelBaseKey(model), model.labelBase);
    const label = `${labelBase}${getNextLabelIndex(data.items, labelBase, [model.labelBase])}`;
    const item = createBlueprintItemFromPreset({
      label,
      color: model.color,
      category: model.itemCategory,
      presetId: model.presetId,
      pos3d,
      defaultPersonAction,
      bodyControls: model.bodyControls,
    });
    appendAndSelectItems([item]);
    setActiveDialog(null);
  }, [appendAndSelectItems, data.items, defaultPersonAction, getSuggestedInsertPosition, t]);

  const addPedestrians = useCallback((mode: PedestrianMode) => {
    const count = mode === 'direct'
      ? 1
      : Math.round(clampNumber(pedestrianCount, 8, 1, 200));
    const columns = Math.round(clampNumber(pedestrianColumns, Math.min(count, 4), 1, count));
    const xSpacing = clampNumber(pedestrianXSpacing, 1.2, 0.2, 10);
    const zSpacing = clampNumber(pedestrianZSpacing, 1.2, 0.2, 10);
    const radius = clampNumber(pedestrianRadius, 4, 0.5, 30);
    const firstLabelIndex = getNextLabelIndex(data.items, pedestrianLabelBase, PEDESTRIAN_LABEL_ALIASES);
    const center = getSuggestedInsertPosition();
    const itemsToAdd = Array.from({ length: count }, (_, index) => {
      let pos3d = { ...center };
      if (mode === 'array') {
        const row = Math.floor(index / columns);
        const col = index % columns;
        const rowCount = Math.ceil(count / columns);
        pos3d = {
          x: center.x + (col - (columns - 1) / 2) * xSpacing,
          y: center.y,
          z: center.z + (row - (rowCount - 1) / 2) * zSpacing,
        };
      } else if (mode === 'random') {
        const angle = Math.random() * Math.PI * 2;
        const distance = Math.sqrt(Math.random()) * radius;
        pos3d = {
          x: center.x + Math.cos(angle) * distance,
          y: center.y,
          z: center.z + Math.sin(angle) * distance,
        };
      }
      return createBlueprintItemFromPreset({
        label: `${pedestrianLabelBase}${firstLabelIndex + index}`,
        color: PEDESTRIAN_COLORS[(firstLabelIndex + index - 1) % PEDESTRIAN_COLORS.length],
        category: 'person',
        presetId: (firstLabelIndex + index - 1) % 5 === 1
          ? 'woman'
          : (firstLabelIndex + index - 1) % 5 === 2
            ? 'shortMan'
            : (firstLabelIndex + index - 1) % 5 === 3
              ? 'tallWoman'
              : 'man',
        pos3d,
        directorStudioRole: 'pedestrian',
        directorStudioNumber: firstLabelIndex + index,
        defaultPersonAction,
      });
    });
    appendAndSelectItems(itemsToAdd);
    setActiveDialog(null);
  }, [
    appendAndSelectItems,
    data.items,
    defaultPersonAction,
    getSuggestedInsertPosition,
    pedestrianLabelBase,
    pedestrianColumns,
    pedestrianCount,
    pedestrianRadius,
    pedestrianXSpacing,
    pedestrianZSpacing,
  ]);

  const updateCamera = useCallback((patch: Partial<DirectorStudioCameraSettings>) => {
    onUpdateNodeData({ camera: { ...camera, ...patch } });
  }, [camera, onUpdateNodeData]);

  const updateLighting = useCallback((patch: Partial<DirectorStudioLightingSettings>) => {
    onUpdateNodeData({ lighting: { ...lighting, ...patch } });
  }, [lighting, onUpdateNodeData]);

  const updateGrid = useCallback((patch: Partial<DirectorStudioGridSettings>) => {
    onUpdateNodeData({ grid: { ...grid, ...patch } });
  }, [grid, onUpdateNodeData]);

  const updateViewSettings = useCallback((patch: Partial<DirectorStudioViewSettings>) => {
    onUpdateNodeData({ viewSettings: { ...viewSettings, ...patch } });
  }, [onUpdateNodeData, viewSettings]);

  const selectCameraPreset = useCallback((presetId: string, fov: number) => {
    updateCamera({ fov, activePreset: presetId });
  }, [updateCamera]);

  const updateFov = useCallback((value: number) => {
    const matchedPreset = CAMERA_PRESETS.find((preset) => Math.abs(preset.fov - value) < 0.05);
    updateCamera({ fov: value, activePreset: matchedPreset?.id ?? null });
  }, [updateCamera]);

  const updateAspectFrame = useCallback((value: DirectorStudioAspectFrame) => {
    onUpdateNodeData({
      aspectFrame: value,
      aspectRatio: value === 'panorama' ? data.aspectRatio ?? '16:9' : value,
    });
  }, [data.aspectRatio, onUpdateNodeData]);

  const captureScreenshot = useCallback(async () => {
    const rawSnapshotUrl = editorRef.current?.exportPng(computeScreenshotExportOptions());
    if (!rawSnapshotUrl) {
      await showErrorDialog(t('directorStudio.addToCanvasNoSnapshot'), t('common.error'));
      return;
    }
    try {
      const snapshotUrl = await persistDirectorStudioImageSource(rawSnapshotUrl);
      const persistedHistory = await persistSnapshotHistory(snapshotHistory);
      onUpdateNodeData({
        snapshotUrl,
        snapshotHistory: appendSnapshotHistory(persistedHistory, snapshotUrl),
      });
      showSidePanel('snapshot');
    } catch (error) {
      await showErrorDialog(
        error instanceof Error ? error.message : t('directorStudio.addToCanvasFailed'),
        t('common.error'),
      );
    }
  }, [computeScreenshotExportOptions, onUpdateNodeData, persistSnapshotHistory, showSidePanel, snapshotHistory, t]);

  const selectSnapshot = useCallback(async (snapshotUrl: string) => {
    try {
      const persistedSnapshotUrl = await persistDirectorStudioImageSource(snapshotUrl);
      const persistedHistory = await persistSnapshotHistory(snapshotHistory);
      onUpdateNodeData({
        snapshotUrl: persistedSnapshotUrl,
        snapshotHistory: persistedHistory.map((item) => item === snapshotUrl ? persistedSnapshotUrl : item),
      });
    } catch (error) {
      await showErrorDialog(
        error instanceof Error ? error.message : t('directorStudio.addToCanvasFailed'),
        t('common.error'),
      );
    }
  }, [onUpdateNodeData, persistSnapshotHistory, snapshotHistory, t]);

  const deleteSnapshot = useCallback(async (snapshotUrl: string) => {
    try {
      const nextHistory = await persistSnapshotHistory(snapshotHistory.filter((url) => url !== snapshotUrl));
      const rawNextCurrent = data.snapshotUrl === snapshotUrl
        ? nextHistory[nextHistory.length - 1] ?? null
        : data.snapshotUrl ?? nextHistory[nextHistory.length - 1] ?? null;
      const nextCurrent = rawNextCurrent
        ? await persistDirectorStudioImageSource(rawNextCurrent)
        : null;
      onUpdateNodeData({
        snapshotUrl: nextCurrent,
        snapshotHistory: nextHistory,
      });
      if (!nextCurrent) {
        setSidePanel((value) => value === 'snapshot' ? null : value);
      }
    } catch (error) {
      await showErrorDialog(
        error instanceof Error ? error.message : t('directorStudio.addToCanvasFailed'),
        t('common.error'),
      );
    }
  }, [data.snapshotUrl, onUpdateNodeData, persistSnapshotHistory, snapshotHistory, t]);

  const clearCurrentSnapshot = useCallback(() => {
    if (!data.snapshotUrl) return;
    void deleteSnapshot(data.snapshotUrl);
  }, [data.snapshotUrl, deleteSnapshot]);

  const clearAllSnapshots = useCallback(() => {
    onUpdateNodeData({
      snapshotUrl: null,
      snapshotHistory: [],
    });
    setSidePanel((value) => value === 'snapshot' ? null : value);
  }, [onUpdateNodeData]);

  const addSnapshotToCanvas = useCallback(async () => {
    if (!onAddSnapshotToCanvas || isAddingSnapshotToCanvas) return;
    const hadDraftWrites = commitPendingTextDrafts();
    setIsAddingSnapshotToCanvas(true);
    try {
      const rawSnapshotUrl = data.snapshotUrl ?? editorRef.current?.exportPng(computeScreenshotExportOptions());
      if (!rawSnapshotUrl) {
        await showErrorDialog(t('directorStudio.addToCanvasNoSnapshot'), t('common.error'));
        return;
      }
      const snapshotUrl = await persistDirectorStudioImageSource(rawSnapshotUrl);
      const persistedHistory = await persistSnapshotHistory(snapshotHistory);
      const historyChanged = persistedHistory.some((historyUrl, index) => historyUrl !== snapshotHistory[index]);
      if (snapshotUrl !== data.snapshotUrl || isDataImageUrl(rawSnapshotUrl) || historyChanged) {
        onUpdateNodeData({
          snapshotUrl,
          snapshotHistory: appendSnapshotHistory(persistedHistory, snapshotUrl),
        });
      }
      if (hadDraftWrites) {
        await waitForNextFrame();
      }
      const result = await onAddSnapshotToCanvasRef.current?.(snapshotUrl);
      if (result === false) return;
      setSidePanel((value) => value === 'snapshot' ? null : value);
      handleClose();
    } catch (error) {
      await showErrorDialog(
        error instanceof Error ? error.message : t('directorStudio.addToCanvasFailed'),
        t('common.error'),
      );
    } finally {
      setIsAddingSnapshotToCanvas(false);
    }
  }, [
    commitPendingTextDrafts,
    computeScreenshotExportOptions,
    data.snapshotUrl,
    handleClose,
    isAddingSnapshotToCanvas,
    onAddSnapshotToCanvas,
    onUpdateNodeData,
    persistSnapshotHistory,
    snapshotHistory,
    t,
  ]);

  const addAllSnapshotsToCanvas = useCallback(async () => {
    if (!onAddSnapshotToCanvas || isAddingSnapshotToCanvas || snapshotHistory.length === 0) return;
    const hadDraftWrites = commitPendingTextDrafts();
    setIsAddingSnapshotToCanvas(true);
    try {
      const persistedHistory = await persistSnapshotHistory(snapshotHistory);
      const currentSnapshotUrl = data.snapshotUrl
        ? await persistDirectorStudioImageSource(data.snapshotUrl)
        : persistedHistory[persistedHistory.length - 1] ?? null;
      if (
        currentSnapshotUrl !== data.snapshotUrl ||
        persistedHistory.some((snapshotUrl, index) => snapshotUrl !== snapshotHistory[index])
      ) {
        onUpdateNodeData({
          snapshotUrl: currentSnapshotUrl,
          snapshotHistory: persistedHistory,
        });
      }
      if (hadDraftWrites) {
        await waitForNextFrame();
      }
      for (const snapshotUrl of persistedHistory) {
        const result = await onAddSnapshotToCanvasRef.current?.(snapshotUrl);
        if (result === false) return;
      }
      setSidePanel((value) => value === 'snapshot' ? null : value);
      handleClose();
    } catch (error) {
      await showErrorDialog(
        error instanceof Error ? error.message : t('directorStudio.addToCanvasFailed'),
        t('common.error'),
      );
    } finally {
      setIsAddingSnapshotToCanvas(false);
    }
  }, [
    commitPendingTextDrafts,
    data.snapshotUrl,
    handleClose,
    isAddingSnapshotToCanvas,
    onAddSnapshotToCanvas,
    onUpdateNodeData,
    persistSnapshotHistory,
    snapshotHistory,
    t,
  ]);

  const importPanorama = useCallback(async (url: string | null | undefined, label?: string) => {
    if (!url) {
      await showErrorDialog(t('directorStudio.importErrors.missingSource'), t('common.error'));
      return;
    }
    setIsUploadingPanorama(true);
    setPanoramaImportStage('checking');
    try {
      const result = await importDirectorStudioPanorama({
        sourceUrl: url,
        sourceLabel: label,
        projection: 'spherical',
        onProgress: setPanoramaImportStage,
        messages: {
          missingBuiltinApiKey: (providerLabel) => t('directorStudio.importErrors.missingBuiltinApiKey', { provider: providerLabel }),
          missingCustomApiKey: (providerLabel) => t('directorStudio.importErrors.missingCustomApiKey', { provider: providerLabel }),
          timeout: t('directorStudio.importErrors.timeout'),
          submitFailed: t('directorStudio.importErrors.submitFailed'),
          generationFailed: t('directorStudio.importErrors.generationFailed'),
          fetchResultFailed: t('directorStudio.importErrors.fetchResultFailed'),
        },
      });
      onUpdateNodeData({
        mode: 'panorama',
        backgroundPanoramaUrl: result.panoramaUrl,
        backgroundImageUrl: result.panoramaUrl,
      });
      setImportOpen(false);
    } catch (error) {
      console.error('Director Studio panorama import failed', error);
      await showErrorDialog(
        error instanceof Error ? error.message : t('directorStudio.importFailed'),
        t('common.error'),
      );
    } finally {
      setIsUploadingPanorama(false);
      setPanoramaImportStage(null);
    }
  }, [onUpdateNodeData, t]);

  const clearPanorama = useCallback(() => {
    onUpdateNodeData({
      mode: 'flat',
      backgroundImageUrl: null,
      backgroundPanoramaUrl: null,
    });
  }, [onUpdateNodeData]);

  const handleUploadPanorama = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setIsUploadingPanorama(true);
    try {
      const prepared = await prepareNodeImageFromFile(file);
      await importPanorama(prepared.imageUrl ?? prepared.previewImageUrl ?? null, file.name);
    } catch (error) {
      console.error('Director Studio panorama import failed', error);
      await showErrorDialog(
        error instanceof Error ? error.message : t('directorStudio.importFailed'),
        t('common.error'),
      );
    } finally {
      setIsUploadingPanorama(false);
    }
  }, [importPanorama, t]);

  const sceneWidth = Math.max(320, viewportSize.width);
  const motionTimelineHeight = timelineOpen
    ? lowHeightLayout
      ? Math.max(168, Math.min(200, Math.round(viewportSize.height * 0.45)))
      : 232
    : 0;
  const motionToolbarHeight = mobileLayout ? 168 : compactLayout ? 120 : 96;
  const sceneHeight = Math.max(320, viewportSize.height - motionTimelineHeight);
  const rawPanoramaUrl = data.backgroundPanoramaUrl ?? data.backgroundImageUrl ?? null;
  const panoramaUrl = rawPanoramaUrl ? resolveImageDisplayUrl(rawPanoramaUrl) ?? rawPanoramaUrl : null;
  const panoramaImportStageLabel = panoramaImportStage
    ? t(`directorStudio.importStages.${panoramaImportStage}`)
    : null;
  const safeFrameStyle = useMemo(() => {
    const ratio = selectedAspect.ratio;
    if (!ratio) return null;
    const sceneRatio = sceneWidth / sceneHeight;
    const width = sceneRatio > ratio ? sceneHeight * ratio : sceneWidth;
    const height = sceneRatio > ratio ? sceneHeight : sceneWidth / ratio;
    return {
      width,
      height,
      left: (sceneWidth - width) / 2,
      top: (sceneHeight - height) / 2,
    };
  }, [sceneHeight, sceneWidth, selectedAspect.ratio]);

  const openFloatingPanel = useCallback((panel: ToolFloatingPanel) => {
    setTopFloatingSurface('tool');
    setFloatingPanel((value) => value === panel ? null : panel);
    requestAnimationFrame(() => setToolbarLayoutVersion((value) => value + 1));
  }, []);

  const toolFloatingPanelStyle = useMemo(() => {
    if (!floatingPanel) return undefined;
    const anchorKeyByPanel: Record<ToolFloatingPanel, string> = {
      camera: 'cameraPreset',
      lighting: 'lighting',
      grid: 'grid',
      frame: 'frame',
      resolution: 'resolution',
      prompt: 'prompt',
    };
    const panelWidth = 320;
    const anchor = toolbarAnchorRefs.current[anchorKeyByPanel[floatingPanel]];
    const rect = anchor?.getBoundingClientRect();
    if (!rect) {
      return {
        left: panelOpen ? 352 : 88,
        bottom: 80,
      };
    }
    const left = Math.min(
      Math.max(16, rect.left + rect.width / 2 - panelWidth / 2),
      Math.max(16, viewportSize.width - panelWidth - 16),
    );
    return {
      left,
      bottom: Math.max(78, viewportSize.height - rect.top + 10),
    };
  }, [floatingPanel, panelOpen, toolbarLayoutVersion, viewportSize.height, viewportSize.width]);

  const showSidePanelSwitcher = Boolean(selectedItem && data.snapshotUrl);
  const toolFloatingPanelZIndex = topFloatingSurface === 'tool' ? 58 : 34;
  const sidePanelZIndex = topFloatingSurface === 'side' ? 58 : 34;

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const claimShortcut = () => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      };
      if (pilotActive) return;
      if (actionLibraryOpen) {
        if (event.key === 'Escape') {
          setActionLibraryOpen(false);
          claimShortcut();
        }
        return;
      }
      if (videoExportOpen) {
        if (event.key === 'Escape' && !videoExportRecording) {
          setVideoExportOpen(false);
          claimShortcut();
        }
        return;
      }
      if (customActionModalOpen) return;
      if (activeDialog === 'shortcuts') {
        if (editingShortcutId) {
          if (event.key === 'Escape') {
            setEditingShortcutId(null);
            claimShortcut();
            return;
          }
          const nextBinding = eventToShortcutBinding(event);
          if (nextBinding) {
            onUpdateNodeData({
              directorStudioShortcuts: {
                ...(data.directorStudioShortcuts ?? {}),
                [editingShortcutId]: nextBinding,
              },
            });
            setEditingShortcutId(null);
            claimShortcut();
          }
          return;
        }
        if (event.key === 'Escape') {
          setActiveDialog(null);
        }
        claimShortcut();
        return;
      }
      if (activeDialog) return;
      if (isEditableEventTarget(event.target)) return;
      if (shortcutMatchesEvent(event, shortcuts.copy)) {
        if (!copySelectedItem()) return;
        claimShortcut();
        return;
      }
      if (shortcutMatchesEvent(event, shortcuts.paste)) {
        if (!pasteCopiedItem()) return;
        claimShortcut();
        return;
      }
      if (shortcutMatchesEvent(event, shortcuts.undo)) {
        if (!undoCanvas()) return;
        setActiveTransformMode(null);
        claimShortcut();
        return;
      }
      if (shortcutMatchesEvent(event, shortcuts.redo)) {
        if (!redoCanvas()) return;
        setActiveTransformMode(null);
        claimShortcut();
        return;
      }
      if (shortcutMatchesEvent(event, shortcuts.delete)) {
        if (motionSelection) {
          deleteMotionKeyframe(motionSelection);
          claimShortcut();
          return;
        }
        if (!selectedItem) return;
        deleteSelectedItem();
        claimShortcut();
        return;
      }
      if (shortcutMatchesEvent(event, shortcuts.save)) {
        void saveProject();
        claimShortcut();
        return;
      }
      if (shortcutMatchesEvent(event, shortcuts.transformMove)) {
        if (!selectedItem) return;
        setActiveTransformMode('move');
        claimShortcut();
        return;
      }
      if (shortcutMatchesEvent(event, shortcuts.transformRotate)) {
        if (!selectedItem) return;
        setActiveTransformMode('rotate');
        claimShortcut();
        return;
      }
      if (shortcutMatchesEvent(event, shortcuts.transformScale)) {
        if (!selectedItem) return;
        setActiveTransformMode('scale');
        claimShortcut();
        return;
      }
      if (shortcutMatchesEvent(event, shortcuts.focus)) {
        if (!selectedItem) return;
        editorRef.current?.focusItem(selectedItem.id);
        setFollowSelectedItem(true);
        claimShortcut();
        return;
      }
      if (shortcutMatchesEvent(event, shortcuts.fit)) {
        editorRef.current?.fitCamera();
        setFollowSelectedItem(false);
        claimShortcut();
        return;
      }
      if (shortcutMatchesEvent(event, shortcuts.reset)) {
        editorRef.current?.resetCamera();
        setFollowSelectedItem(false);
        claimShortcut();
        return;
      }
      if (shortcutMatchesEvent(event, shortcuts.screenshot)) {
        void captureScreenshot();
        claimShortcut();
        return;
      }
      if (shortcutMatchesEvent(event, shortcuts.model)) {
        setActiveDialog('modelLibrary');
        claimShortcut();
        return;
      }
      if (shortcutMatchesEvent(event, shortcuts.advancedPedestrianTags)) {
        updateViewSettings({ showAdvancedPedestrianTags: !viewSettings.showAdvancedPedestrianTags });
        claimShortcut();
        return;
      }
      if (shortcutMatchesEvent(event, shortcuts.lighting)) {
        openFloatingPanel('lighting');
        claimShortcut();
        return;
      }
      if (shortcutMatchesEvent(event, shortcuts.grid)) {
        openFloatingPanel('grid');
        claimShortcut();
        return;
      }
      if (shortcutMatchesEvent(event, shortcuts.prompt)) {
        openFloatingPanel('prompt');
        claimShortcut();
        return;
      }
      if (shortcutMatchesEvent(event, shortcuts.shortcuts)) {
        setActiveDialog('shortcuts');
        claimShortcut();
        return;
      }
    };
    window.addEventListener('keydown', handleShortcut, true);
    return () => window.removeEventListener('keydown', handleShortcut, true);
  }, [
    actionLibraryOpen,
    activeDialog,
    captureScreenshot,
    copySelectedItem,
    customActionModalOpen,
    data.directorStudioShortcuts,
    deleteMotionKeyframe,
    deleteSelectedItem,
    editingShortcutId,
    onUpdateNodeData,
    openFloatingPanel,
    pasteCopiedItem,
    pilotActive,
    motionSelection,
    redoCanvas,
    saveProject,
    selectedItem,
    shortcuts,
    undoCanvas,
    updateViewSettings,
    videoExportOpen,
    videoExportRecording,
    viewSettings.showAdvancedPedestrianTags,
  ]);

  const toolbarButtons: ToolButtonSpec[] = [
    { key: 'model', label: t('directorStudio.toolbar.addModel'), title: t('directorStudio.toolbar.addModel'), icon: Box, active: activeDialog === 'modelLibrary', onClick: () => setActiveDialog('modelLibrary') },
    { key: 'pedestrian', label: t('directorStudio.toolbar.addPedestrian'), title: t('directorStudio.toolbar.addPedestrian'), icon: Users, active: activeDialog === 'pedestrians', onClick: () => setActiveDialog('pedestrians') },
    { key: 'defaultPedestrian', label: t('directorStudio.toolbar.defaultPedestrian'), title: t('directorStudio.toolbar.defaultPedestrian'), icon: UserPlus, onClick: () => addPedestrians('direct') },
    { key: 'delete', label: t('directorStudio.toolbar.delete'), title: selectedItem ? t('directorStudio.toolbar.delete') : t('directorStudio.selectElementFirst'), icon: Trash2, disabled: !selectedItem, onClick: deleteSelectedItem },
    { key: 'prompt', label: t('directorStudio.toolbar.prompt'), title: t('directorStudio.prompt.title'), icon: FileText, active: floatingPanel === 'prompt', onClick: () => openFloatingPanel('prompt') },
    {
      key: 'focus',
      label: t('directorStudio.toolbar.focus'),
      title: selectedItem ? t('directorStudio.toolbar.focus') : t('directorStudio.selectElementFirst'),
      icon: Focus,
      disabled: !selectedItem,
      active: followSelectedItem,
      onClick: () => {
        if (!selectedItem) return;
        const next = !followSelectedItem;
        setFollowSelectedItem(next);
        if (next) {
          editorRef.current?.focusItem(selectedItem.id);
        }
      },
    },
    {
      key: 'transform',
      label: t('directorStudio.toolbar.transform'),
      title: selectedItem
        ? activeTransformMode
          ? t('directorStudio.transform.cancelTitle')
          : t('directorStudio.transform.help')
        : t('directorStudio.selectElementFirst'),
      icon: Move3d,
      disabled: !selectedItem,
      active: Boolean(activeTransformMode),
      onClick: () => setActiveTransformMode((value) => value ? null : 'move'),
    },
    { key: 'params', label: t('directorStudio.toolbar.params'), title: t('directorStudio.toolbar.params'), icon: SlidersHorizontal, active: sidePanel === 'inspector', onClick: () => toggleSidePanel('inspector') },
    {
      key: 'timeline',
      label: t('directorStudio.motion.timeline.title'),
      title: t('directorStudio.motion.timeline.title'),
      icon: PanelBottom,
      active: timelineOpen,
      onClick: () => {
        if (lowHeightLayout && !timelineOpen) {
          setFloatingPanel(null);
          setSidePanel(null);
        }
        setTimelineOpen((value) => !value);
      },
    },
    { key: 'pilot', label: t('directorStudio.motion.pilot.enter'), title: t('directorStudio.motion.pilot.enter'), icon: Crosshair, active: pilotActive, onClick: toggleCameraPilot },
    { key: 'exportVideo', label: t('directorStudio.motion.export.title'), title: motionProject.cameraTrack.length < 2 ? t('directorStudio.motion.export.needsCamera') : t('directorStudio.motion.export.title'), icon: Video, disabled: motionProject.cameraTrack.length < 2, onClick: openVideoExport },
    { key: 'cameraPreset', label: t('directorStudio.toolbar.cameraPreset'), title: t('directorStudio.toolbar.cameraPreset'), icon: Camera, active: floatingPanel === 'camera', onClick: () => openFloatingPanel('camera') },
    { key: 'lighting', label: t('directorStudio.toolbar.lighting'), title: t('directorStudio.toolbar.lighting'), icon: Lightbulb, active: floatingPanel === 'lighting', onClick: () => openFloatingPanel('lighting') },
    {
      key: 'reset',
      label: t('directorStudio.toolbar.reset'),
      title: t('directorStudio.toolbar.reset'),
      icon: RotateCcw,
      onClick: () => {
        editorRef.current?.resetCamera();
        setFollowSelectedItem(false);
      },
    },
    { key: 'grid', label: t('directorStudio.toolbar.grid'), title: t('directorStudio.toolbar.grid'), icon: Grid3x3, active: floatingPanel === 'grid', onClick: () => openFloatingPanel('grid') },
    { key: 'frame', label: t('directorStudio.toolbar.frame'), title: t('directorStudio.toolbar.frame'), icon: Crop, active: floatingPanel === 'frame', onClick: () => openFloatingPanel('frame') },
    { key: 'resolution', label: t('directorStudio.toolbar.resolution'), title: t('directorStudio.toolbar.resolution'), icon: Monitor, active: floatingPanel === 'resolution', onClick: () => openFloatingPanel('resolution') },
    { key: 'screenshot', label: t('directorStudio.toolbar.screenshot'), title: t('directorStudio.toolbar.screenshot'), icon: Aperture, active: sidePanel === 'snapshot', onClick: () => { void captureScreenshot(); } },
    { key: 'shortcuts', label: t('directorStudio.toolbar.shortcuts'), title: t('directorStudio.shortcuts.title'), icon: Keyboard, active: activeDialog === 'shortcuts', onClick: () => setActiveDialog('shortcuts') },
  ];
  const orderedToolbarButtons = lowHeightLayout
    ? [
        ...toolbarButtons.filter((button) => button.key === 'timeline'),
        ...toolbarButtons.filter((button) => button.key !== 'timeline'),
      ]
    : toolbarButtons;

  const content = (
    <div
      className="director-studio-shell nodrag nopan fixed inset-0 z-[8600] overflow-hidden bg-[#071012] text-white"
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <header className="absolute inset-x-0 top-0 z-50 flex h-14 items-center justify-between gap-2 border-b border-white/10 bg-[#101113]/82 px-2 shadow-[0_10px_34px_rgba(0,0,0,0.28)] backdrop-blur-xl sm:px-4">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <div className="truncate whitespace-nowrap text-sm font-semibold tracking-normal sm:text-base">{t('directorStudio.title')}</div>
          <div className={`rounded border px-2 py-0.5 text-[11px] ${
            hasUnsavedChanges ? 'border-amber-300/30 bg-amber-300/10 text-amber-200' : 'border-emerald-300/25 bg-emerald-300/10 text-emerald-200'
          }`}>
            {hasUnsavedChanges ? t('directorStudio.unsaved') : t('directorStudio.saved')}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          <button
            type="button"
            onClick={() => { void saveProject(); }}
            className="inline-flex h-9 w-9 items-center justify-center gap-2 rounded-md bg-white px-0 text-sm font-medium text-black hover:bg-white/90 sm:w-auto sm:px-3"
            title={t('directorStudio.saveProject')}
            aria-label={t('directorStudio.saveProject')}
          >
            <Save className="h-4 w-4" />
            <span className="hidden sm:inline">{t('directorStudio.saveProject')}</span>
          </button>
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            className="inline-flex h-9 w-9 items-center justify-center gap-2 rounded-md border border-white/12 bg-white/6 px-0 text-sm text-white/75 hover:bg-white/12 hover:text-white sm:w-auto sm:px-3"
            title={t('directorStudio.panoramaImport')}
            aria-label={t('directorStudio.panoramaImport')}
          >
            <Upload className="h-4 w-4" />
            <span className="hidden sm:inline">{t('directorStudio.panoramaImport')}</span>
          </button>
          {rawPanoramaUrl ? (
            <button
              type="button"
              onClick={clearPanorama}
              className="inline-flex h-9 w-9 items-center justify-center gap-2 rounded-md border border-red-300/20 bg-red-500/10 px-0 text-sm text-red-100 hover:bg-red-500/18 sm:w-auto sm:px-3"
              title={t('directorStudio.clearPanorama')}
              aria-label={t('directorStudio.clearPanorama')}
            >
              <Eraser className="h-4 w-4" />
              <span className="hidden sm:inline">{t('directorStudio.clearPanorama')}</span>
            </button>
          ) : null}
          <button
            type="button"
            onClick={handleClose}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-white/10 bg-white/6 text-white/70 hover:bg-white/12 hover:text-white"
            aria-label={t('common.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="absolute inset-0 z-0 overflow-hidden bg-[#071012]">
        {panelOpen ? (
        <aside
          className="absolute top-16 z-30 flex min-h-0 flex-col overflow-hidden rounded-lg border border-white/12 bg-[#0d0f11]/84 shadow-[0_18px_60px_rgba(0,0,0,0.36)] backdrop-blur-xl"
          style={{
            left: compactLayout ? 12 : 16,
            width: compactLayout ? Math.min(360, viewportSize.width - 24) : 320,
            bottom: motionTimelineHeight + motionToolbarHeight,
          }}
        >
          <div className="flex items-center gap-1 border-b border-white/10 p-2">
            {([
              ['projects', FolderOpen, t('directorStudio.projects')],
              ['elements', ImagePlus, t('directorStudio.elements')],
            ] as const).map(([mode, Icon, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => setPanelMode(mode)}
                className={`flex h-9 min-w-0 flex-1 items-center justify-center gap-2 rounded-md text-xs ${
                  panelMode === mode
                    ? 'bg-white text-black'
                    : 'bg-white/6 text-white/65 hover:bg-white/10 hover:text-white'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPanelOpen(false)}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-white/50 hover:bg-white/10 hover:text-white"
              aria-label={t('directorStudio.collapsePanel')}
              title={t('directorStudio.collapsePanel')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {panelMode === 'projects' ? (
            <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
              <div className="space-y-2">
                {projects.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-white/12 px-3 py-8 text-center text-xs leading-5 text-white/42">
                    {t('directorStudio.noProjects')}
                  </div>
                ) : null}
                {projects.map((project) => {
                    const isActive = project.id === data.activeDirectorStudioProjectId;
                    const coverUrl = getProjectCover(project);
                    const coverDisplayUrl = coverUrl ? resolveImageDisplayUrl(coverUrl) ?? coverUrl : null;
                    const createdAt = Number.isFinite(project.createdAt) ? project.createdAt : project.updatedAt;
                    return (
                    <div
                      key={project.id}
                      className={`rounded-lg border bg-black/18 p-2 transition-colors ${
                        isActive ? 'border-accent/70' : 'border-white/10 hover:border-white/25'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => { void restoreProject(project); }}
                        className="block w-full overflow-hidden rounded-md bg-white/5 text-left"
                        title={t('directorStudio.openProject')}
                      >
                        <div className="aspect-video bg-black/40">
                          {coverDisplayUrl ? (
                            <img src={coverDisplayUrl} alt={project.name} className="h-full w-full object-cover" draggable={false} />
                          ) : (
                            <div className="flex h-full items-center justify-center text-[11px] text-white/32">
                              {t('directorStudio.noCover')}
                            </div>
                          )}
                        </div>
                      </button>
                      <div className="mt-2 flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          {editingProjectId === project.id ? (
                            <input
                              value={editingProjectName}
                              onChange={(event) => setEditingProjectName(event.target.value)}
                              onBlur={commitProjectName}
                              onKeyDown={(event) => {
                                event.stopPropagation();
                                if (event.key === 'Enter') commitProjectName();
                                if (event.key === 'Escape') {
                                  setEditingProjectId(null);
                                  setEditingProjectName('');
                                }
                              }}
                              autoFocus
                              className={`h-7 w-full px-2 text-xs ${DIRECTOR_FIELD_CLASS}`}
                            />
                          ) : (
                            <button
                              type="button"
                              onDoubleClick={() => beginEditProjectName(project)}
                              className={`block max-w-full truncate text-left text-xs font-medium text-white/85 ${DIRECTOR_EDITABLE_NAME_CLASS}`}
                              title={t('directorStudio.renameHint')}
                            >
                              {project.name}
                            </button>
                            )}
                            <div className="mt-1 space-y-0.5 text-[10px] leading-4 text-white/38">
                              <div>{t('directorStudio.createdAt', { time: formatProjectTime(createdAt) })}</div>
                              <div>{t('directorStudio.updatedAt', { time: formatProjectTime(project.updatedAt) })}</div>
                            </div>
                          </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => { void updateProjectCover(project); }}
                            className="rounded p-1 text-white/45 hover:bg-white/10 hover:text-white"
                            title={t('directorStudio.changeCover')}
                          >
                            <Camera className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteProject(project)}
                            className="rounded p-1 text-white/45 hover:bg-red-500/16 hover:text-red-200"
                            title={t('common.delete')}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
                <button
                  type="button"
                  onClick={() => { void createBlankWorkspace(); }}
                  className="flex aspect-video w-full items-center justify-center rounded-lg border border-dashed border-white/16 bg-white/[0.03] text-white/45 hover:border-white/30 hover:text-white"
                  title={t('directorStudio.newProject')}
                >
                  <Plus className="h-7 w-7" />
                </button>
              </div>
            </div>
          ) : (
            <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
              <div className="mb-2 text-[11px] text-white/42">
                {t('directorStudio.elementCount', { count: data.items.length })}
              </div>
              <div className="space-y-1.5">
                {data.items.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-white/12 px-3 py-8 text-center text-xs leading-5 text-white/42">
                    {t('directorStudio.noElements')}
                  </div>
                ) : null}
                {displayItems.map(({ item, displayCategory }, itemIndex) => {
                  const isSelected = selectedItemId === item.id;
                  const showCategoryHeading = displayCategory !== displayItems[itemIndex - 1]?.displayCategory;
                  const CategoryIcon = displayCategory === 'person' ? Users : displayCategory === 'scene' ? Image : Box;
                  const categoryLabel = displayCategory === 'person'
                    ? t('directorStudio.category.person')
                    : displayCategory === 'scene'
                      ? t('directorStudio.category.scene')
                      : t('directorStudio.category.object');
                  return (
                    <div
                      key={item.id}
                      className={showCategoryHeading ? 'pt-2 first:pt-0' : undefined}
                    >
                      {showCategoryHeading ? (
                        <div className="mb-1 flex items-center gap-1.5 px-1 text-[10px] font-medium text-white/36">
                          <CategoryIcon className="h-3 w-3 text-white/28" />
                          <span>{categoryLabel}</span>
                        </div>
                      ) : null}
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                          selectItemForEditing(item.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter' && event.key !== ' ') return;
                          event.preventDefault();
                          selectItemForEditing(item.id);
                        }}
                        className={`flex w-full items-center gap-2 rounded-lg border px-2 py-2 text-left text-xs ${
                          isSelected
                            ? 'border-accent/70 bg-accent/12 text-white'
                            : 'border-white/10 bg-black/18 text-white/68 hover:border-white/24 hover:text-white'
                        }`}
                      >
                        <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: item.color || '#9ca3af' }} />
                        <CategoryIcon className="h-3.5 w-3.5 shrink-0 text-white/45" />
                        <div className="min-w-0 flex-1">
                          {editingItemId === item.id ? (
                            <input
                              value={editingItemName}
                              onChange={(event) => setEditingItemName(event.target.value)}
                              onClick={(event) => event.stopPropagation()}
                              onDoubleClick={(event) => event.stopPropagation()}
                              onKeyDown={(event) => {
                                event.stopPropagation();
                                if (event.key === 'Enter') commitRenameItem();
                                if (event.key === 'Escape') {
                                  setEditingItemId(null);
                                  setEditingItemName('');
                                }
                              }}
                              onBlur={commitRenameItem}
                              autoFocus
                              className={`h-7 w-full px-2 text-xs ${DIRECTOR_FIELD_CLASS}`}
                            />
                          ) : (
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                selectItemForEditing(item.id);
                              }}
                              onDoubleClick={(event) => {
                                event.stopPropagation();
                                beginRenameItem(item);
                              }}
                              className={`block max-w-full truncate text-left font-medium text-white/86 ${DIRECTOR_EDITABLE_NAME_CLASS}`}
                              title={t('directorStudio.renameElementHint')}
                            >
                              {item.label}
                            </button>
                          )}
                          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-white/38">
                            <span>{categoryLabel}</span>
                            {item.refImageName ? (
                              <span className="min-w-0 truncate text-accent/80">@{item.refImageName}</span>
                            ) : null}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            openElementAssetPicker(item.id);
                          }}
                          className={`shrink-0 rounded p-1.5 ${
                            item.refImageUrl
                              ? 'bg-accent/18 text-accent hover:bg-accent/25'
                              : 'bg-white/[0.07] text-white/48 hover:bg-white/12 hover:text-white'
                          }`}
                          title={item.refImageUrl ? t('directorStudio.linkedImage.change') : t('directorStudio.linkedImage.choose')}
                        >
                          <Link2 className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            updateItem(item.id, { showLabel: item.showLabel === false });
                          }}
                          className="shrink-0 rounded p-1.5 text-white/45 hover:bg-white/10 hover:text-white"
                          title={item.showLabel === false ? t('directorStudio.inspector.showLabel') : t('directorStudio.inspector.hideLabel')}
                        >
                          {item.showLabel === false ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </aside>
        ) : (
          <div className="absolute left-4 top-16 z-30 flex flex-col gap-2 rounded-lg border border-white/12 bg-[#0d0f11]/78 p-1.5 shadow-[0_14px_40px_rgba(0,0,0,0.32)] backdrop-blur-xl">
            {([
              ['projects', FolderOpen, t('directorStudio.projects'), t('directorStudio.openProjectsPanel')],
              ['elements', ImagePlus, t('directorStudio.elements'), t('directorStudio.openElementsPanel')],
            ] as const).map(([mode, Icon, label, title]) => (
              <button
                key={mode}
                type="button"
                onClick={() => {
                  if (compactLayout) setSidePanel(null);
                  setPanelMode(mode);
                  setPanelOpen(true);
                }}
                className={`flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
                  panelMode === mode
                    ? 'bg-white text-black'
                    : 'text-white/58 hover:bg-white/10 hover:text-white'
                }`}
                aria-label={title}
                title={title}
              >
                <Icon className="h-4 w-4" />
                <span className="sr-only">{label}</span>
              </button>
            ))}
          </div>
        )}

        <main className="absolute inset-0 z-0 h-full min-h-0 overflow-hidden bg-[#071012]">
          <DirectorSceneErrorBoundary
            key={sceneLoadAttempt}
            title={t('directorStudio.sceneError.title')}
            description={t('directorStudio.sceneError.description')}
            retryLabel={t('directorStudio.sceneError.retry')}
            closeLabel={t('common.close')}
            onRetry={retryBlueprintScene}
            onClose={onClose}
          >
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-sm text-white/45">
                  {t('directorStudio.loadingScene')}
                </div>
              }
            >
              <BlueprintSceneComponent
                ref={editorRef}
                items={data.items}
                onItemsChange={onItemsChange}
                referenceImages={referenceImages}
                mode={data.mode === 'panorama' ? 'panorama' : 'flat'}
                panoramaUrl={panoramaUrl}
                width={sceneWidth}
                height={sceneHeight}
                fullBleed
                selectedItemId={selectedItemId}
                followSelectedItem={followSelectedItem}
                transformMode={selectedItem ? activeTransformMode : null}
                onSelectedItemChange={selectItemForEditing}
                customActionPoses={data.customActionPoses}
                cameraFov={camera.fov}
                cameraDistance={camera.lensDistance}
                lighting={lighting}
                grid={grid}
                viewSettings={viewSettings}
                keyboardShortcutsEnabled={activeDialog !== 'shortcuts'}
                motionProject={motionProject}
                motionRoutesVisible={motionShowRoutes}
                motionRouteSelection={motionSelection && motionSelection.kind !== 'action'
                  ? {
                      kind: motionSelection.kind,
                      trackId: motionSelection.trackId,
                      keyframeId: motionSelection.keyframeId,
                    }
                  : null}
                onMotionRoutePointSelect={selectMotionRouteKeyframe}
                onMotionRoutePointMove={moveMotionRouteKeyframe}
                onMotionRoutePointInsert={insertMotionRouteKeyframe}
                pilotActive={pilotActive}
                onPilotActiveChange={setPilotActive}
                onPilotRecordCamera={recordPilotCamera}
                onPilotTargetChange={setPilotTargetId}
              />
            </Suspense>
          </DirectorSceneErrorBoundary>

          {safeFrameStyle ? (
            <div
              className="pointer-events-none absolute z-10 border border-white/75 shadow-[0_0_0_9999px_rgba(0,0,0,0.22)]"
              style={safeFrameStyle}
            >
              <div className="absolute left-2 top-2 rounded bg-black/60 px-2 py-0.5 text-[10px] text-white/80">
                {t('directorStudio.safeFrame')} · {selectedAspect.value}
              </div>
            </div>
          ) : null}

          {floatingPanel ? (
            <div
              className="absolute bottom-20 z-30 w-[320px] rounded-lg border border-white/12 bg-[#101316]/92 p-3 shadow-[0_18px_60px_rgba(0,0,0,0.34)] backdrop-blur-xl"
              style={{ ...(toolFloatingPanelStyle ?? {}), zIndex: toolFloatingPanelZIndex }}
              onPointerDownCapture={() => bringFloatingSurfaceToFront('tool')}
            >
              <div className="mb-3 flex items-center justify-between">
                <div className="text-xs font-medium text-white/86">
                  {floatingPanel === 'camera'
                    ? t('directorStudio.toolbar.cameraPreset')
                    : floatingPanel === 'lighting'
                      ? t('directorStudio.toolbar.lighting')
                      : floatingPanel === 'grid'
                        ? t('directorStudio.toolbar.grid')
                        : floatingPanel === 'frame'
                          ? t('directorStudio.toolbar.frame')
                          : floatingPanel === 'resolution'
                            ? t('directorStudio.toolbar.resolution')
                            : t('directorStudio.prompt.title')}
                </div>
                <button
                  type="button"
                  onClick={() => setFloatingPanel(null)}
                  className="rounded p-1 text-white/45 hover:bg-white/10 hover:text-white"
                  aria-label={t('common.close')}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>

              {floatingPanel === 'prompt' ? (
                <label className="block text-xs text-white/68">
                  <span className="mb-2 block text-white/82">{t('directorStudio.prompt.title')}</span>
                  <textarea
                    value={basePromptDraft}
                    onChange={(event) => updateBasePromptDraft(event.target.value)}
                    onBlur={commitBasePromptDraft}
                    onKeyUp={(event) => {
                      if (event.key === 'Enter') {
                        commitBasePromptDraft();
                      }
                    }}
                    rows={7}
                    className="nodrag nowheel w-full resize-none rounded-md border border-white/12 bg-black/30 px-3 py-2 text-xs leading-5 text-white outline-none placeholder:text-white/30 focus:border-white/30"
                    placeholder={t('directorStudio.prompt.placeholder')}
                  />
                  <span className="mt-2 block text-[10px] leading-4 text-white/42">
                    {t('directorStudio.prompt.hint')}
                  </span>
                </label>
              ) : null}

              {floatingPanel === 'camera' ? (
                <div className="space-y-3">
                  <label className="block text-[11px] text-white/62">
                    <span className="mb-1 flex justify-between">
                      <span>{t('directorStudio.camera.fov')}</span>
                      <span className="font-mono text-white/82">{camera.fov.toFixed(1)}</span>
                    </span>
                    <input
                      type="range"
                      min={10}
                      max={150}
                      step={0.1}
                      value={camera.fov}
                      onChange={(event) => updateFov(Number(event.target.value))}
                      className="w-full accent-white"
                    />
                  </label>
                  <label className="block text-[11px] text-white/62">
                    <span className="mb-1 flex justify-between">
                      <span>{t('directorStudio.camera.lensDistance')}</span>
                      <span className="font-mono text-white/82">{camera.lensDistance.toFixed(1)}</span>
                    </span>
                    <input
                      type="range"
                      min={2}
                      max={40}
                      step={0.1}
                      value={camera.lensDistance}
                      onChange={(event) => updateCamera({ lensDistance: Number(event.target.value) })}
                      className="w-full accent-white"
                    />
                  </label>
                  <div className="border-t border-white/10 pt-3">
                    <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-white/42">
                      {t('directorStudio.toolbar.cameraPreset')}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {CAMERA_PRESETS.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => selectCameraPreset(preset.id, preset.fov)}
                        className={`flex items-center justify-between rounded-md border px-2.5 py-2 text-xs ${
                          camera.activePreset === preset.id
                            ? 'border-accent/70 bg-accent/18 text-white'
                            : 'border-white/10 bg-white/6 text-white/68 hover:border-white/25 hover:text-white'
                        }`}
                      >
                        <span>{t(preset.labelKey)}</span>
                        <span className="font-mono text-[10px] text-white/48">{preset.fov}</span>
                      </button>
                    ))}
                  </div>
                  <div className="space-y-2 border-t border-white/10 pt-3">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-white/42">
                      {t('directorStudio.viewSettings.title')}
                    </div>
                    <DirectorSettingToggle
                      label={t('directorStudio.viewSettings.wheelZoomEnabled')}
                      description={t('directorStudio.viewSettings.wheelZoomEnabledHint')}
                      checked={viewSettings.wheelZoomEnabled}
                      onChange={(checked) => updateViewSettings({ wheelZoomEnabled: checked })}
                    />
                    <DirectorSettingToggle
                      label={t('directorStudio.viewSettings.reverseWheelZoom')}
                      description={t('directorStudio.viewSettings.reverseWheelZoomHint')}
                      checked={viewSettings.reverseWheelZoom}
                      onChange={(checked) => updateViewSettings({ reverseWheelZoom: checked })}
                    />
                    <DirectorSettingToggle
                      label={t('directorStudio.viewSettings.showAdvancedPedestrianTags')}
                      description={t('directorStudio.viewSettings.showAdvancedPedestrianTagsHint')}
                      checked={viewSettings.showAdvancedPedestrianTags}
                      onChange={(checked) => updateViewSettings({ showAdvancedPedestrianTags: checked })}
                    />
                  </div>
                </div>
              ) : null}

              {floatingPanel === 'lighting' ? (
                <div className="space-y-3">
                  <label className="flex items-center justify-between rounded-md border border-white/10 bg-white/6 px-3 py-2 text-xs text-white/78">
                    <span>{t('directorStudio.lighting.enabled')}</span>
                    <input
                      type="checkbox"
                      checked={lighting.enabled}
                      onChange={(event) => updateLighting({ enabled: event.target.checked })}
                      className="h-4 w-4 accent-white"
                    />
                  </label>
                  {([
                    ['mainIntensity', 'directorStudio.lighting.mainIntensity', 0, 4, 0.05],
                    ['mainYaw', 'directorStudio.lighting.mainYaw', -180, 180, 1],
                    ['mainPitch', 'directorStudio.lighting.mainPitch', -20, 89, 1],
                    ['ambientIntensity', 'directorStudio.lighting.ambientIntensity', 0, 3, 0.05],
                  ] as const).map(([key, labelKey, min, max, step]) => (
                    <label key={key} className="block text-[11px] text-white/62">
                      <span className="mb-1 flex justify-between">
                        <span>{t(labelKey)}</span>
                        <span className="font-mono text-white/82">{Number(lighting[key]).toFixed(step < 1 ? 2 : 0)}</span>
                      </span>
                      <input
                        type="range"
                        min={min}
                        max={max}
                        step={step}
                        value={Number(lighting[key])}
                        onChange={(event) => updateLighting({ [key]: Number(event.target.value) } as Partial<DirectorStudioLightingSettings>)}
                        className="w-full accent-white"
                      />
                    </label>
                  ))}
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-[11px] text-white/62">
                      <span>{t('directorStudio.lighting.mainColor')}</span>
                      <input
                        type="color"
                        value={lighting.mainColor}
                        onChange={(event) => updateLighting({ mainColor: event.target.value })}
                        className="mt-1 h-9 w-full rounded border border-white/10 bg-transparent"
                      />
                    </label>
                    <label className="text-[11px] text-white/62">
                      <span>{t('directorStudio.lighting.ambientColor')}</span>
                      <input
                        type="color"
                        value={lighting.ambientColor}
                        onChange={(event) => updateLighting({ ambientColor: event.target.value })}
                        className="mt-1 h-9 w-full rounded border border-white/10 bg-transparent"
                      />
                    </label>
                  </div>
                </div>
              ) : null}

              {floatingPanel === 'grid' ? (
                <div className="space-y-3">
                  <label className="flex items-center justify-between rounded-md border border-white/10 bg-white/6 px-3 py-2 text-xs text-white/78">
                    <span>{t('directorStudio.grid.visible')}</span>
                    <input
                      type="checkbox"
                      checked={grid.visible}
                      onChange={(event) => updateGrid({ visible: event.target.checked })}
                      className="h-4 w-4 accent-white"
                    />
                  </label>
                  <label className="block text-[11px] text-white/62">
                    <span className="mb-1 flex justify-between">
                      <span>{t('directorStudio.grid.height')}</span>
                      <span className="font-mono text-white/82">{grid.height.toFixed(1)}</span>
                    </span>
                    <input
                      type="range"
                      min={-3}
                      max={5}
                      step={0.1}
                      value={grid.height}
                      onChange={(event) => updateGrid({ height: Number(event.target.value) })}
                      className="w-full accent-white"
                    />
                  </label>
                </div>
              ) : null}

              {floatingPanel === 'frame' ? (
                <div className="grid grid-cols-3 gap-2">
                  {ASPECT_FRAMES.map((frame) => (
                    <button
                      key={frame.value}
                      type="button"
                      onClick={() => updateAspectFrame(frame.value)}
                      className={`rounded-md border px-2 py-2 text-xs ${
                        aspectFrame === frame.value
                          ? 'border-accent/70 bg-accent/18 text-white'
                          : 'border-white/10 bg-white/6 text-white/68 hover:border-white/25 hover:text-white'
                      }`}
                    >
                      {t(frame.labelKey)}
                    </button>
                  ))}
                </div>
              ) : null}

              {floatingPanel === 'resolution' ? (
                <div className="grid grid-cols-3 gap-2">
                  {SCREENSHOT_RESOLUTIONS.map((resolution) => (
                    <button
                      key={resolution.value}
                      type="button"
                      onClick={() => onUpdateNodeData({ screenshotResolution: resolution.value })}
                      className={`rounded-md border px-2 py-2 text-xs ${
                        screenshotResolution === resolution.value
                          ? 'border-accent/70 bg-accent/18 text-white'
                          : 'border-white/10 bg-white/6 text-white/68 hover:border-white/25 hover:text-white'
                      }`}
                    >
                      {t(resolution.labelKey)}
                    </button>
                  ))}
                  <div className="col-span-3 text-[10px] leading-4 text-white/42">
                    {t('directorStudio.resolutionNote')}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {showSidePanelSwitcher && !compactLayout ? (
            <div
              className="absolute right-[364px] top-20 z-40 flex flex-col gap-1 rounded-full border border-white/12 bg-[#151618]/92 p-1 shadow-xl backdrop-blur-xl"
              style={{ zIndex: sidePanelZIndex + 1 }}
              onPointerDownCapture={() => bringFloatingSurfaceToFront('side')}
            >
              {([
                ['inspector', SlidersHorizontal, t('directorStudio.sidePanels.inspector')],
                ['snapshot', Aperture, t('directorStudio.sidePanels.snapshot')],
              ] as const).map(([panel, Icon, label]) => (
                <button
                  key={panel}
                  type="button"
                  onClick={() => showSidePanel(panel)}
                  className={`flex h-7 w-7 items-center justify-center rounded-full transition-colors ${
                    sidePanel === panel
                      ? 'bg-accent text-black'
                      : 'text-white/52 hover:bg-white/10 hover:text-white'
                  }`}
                  aria-label={label}
                  title={label}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              ))}
            </div>
          ) : null}

          {sidePanel === 'inspector' ? (
            <aside
              className="absolute top-16 z-30 flex flex-col rounded-lg border border-white/12 bg-[#151618]/96 shadow-2xl"
              style={{
                zIndex: sidePanelZIndex,
                right: compactLayout ? 12 : 16,
                width: compactLayout ? Math.min(360, viewportSize.width - 24) : 336,
                bottom: motionTimelineHeight + motionToolbarHeight,
              }}
              onPointerDownCapture={() => bringFloatingSurfaceToFront('side')}
            >
              <div className="flex h-12 items-center justify-between border-b border-white/10 px-4">
                <div>
                  <div className="text-sm font-medium text-white/88">{t('directorStudio.inspector.title')}</div>
                  <div className="text-[10px] text-white/38">
                    {selectedItem ? selectedItem.label : t('directorStudio.inspector.noSelection')}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSidePanel(null)}
                  className="rounded p-1.5 text-white/45 hover:bg-white/10 hover:text-white"
                  aria-label={t('common.close')}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              {selectedItem ? (
                <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
                  <div className="space-y-4">
                    <div className="rounded-lg border border-white/10 bg-black/18 p-3">
                      <div className="mb-3 text-[11px] font-medium uppercase tracking-wide text-white/42">
                        {t('directorStudio.inspector.basic')}
                      </div>
                      <label className="mb-3 grid grid-cols-[40px_minmax(0,1fr)] items-center gap-2">
                        <input
                          type="color"
                          value={selectedItem.color || '#9ca3af'}
                          onChange={(event) => updateItem(selectedItem.id, { color: event.target.value })}
                          className="h-9 w-10 rounded border border-white/10 bg-transparent"
                          aria-label={t('directorStudio.inspector.color')}
                        />
                        <input
                          value={inspectorTextDraft.itemId === selectedItem.id ? inspectorTextDraft.label : selectedItem.label}
                          onChange={(event) => updateInspectorTextDraft('label', event.target.value)}
                          onBlur={commitInspectorTextDraft}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              commitInspectorTextDraft();
                              event.currentTarget.blur();
                            }
                          }}
                          className={`h-9 px-2.5 text-xs ${DIRECTOR_FIELD_CLASS}`}
                          aria-label={t('directorStudio.inspector.name')}
                        />
                      </label>
                      <label className="flex items-center justify-between rounded-md border border-white/10 bg-white/6 px-3 py-2 text-xs text-white/78">
                        <span>{t('directorStudio.inspector.showLabel')}</span>
                        <input
                          type="checkbox"
                          checked={selectedItem.showLabel !== false}
                          onChange={(event) => updateItem(selectedItem.id, { showLabel: event.target.checked })}
                          className="h-4 w-4 accent-white"
                        />
                      </label>
                    </div>

                    <div className="rounded-lg border border-white/10 bg-black/18 p-3">
                      <div className="mb-3 flex items-center justify-between">
                        <div className="text-[11px] font-medium uppercase tracking-wide text-white/42">
                          {t('directorStudio.linkedImage.title')}
                        </div>
                        {selectedItem.refImageUrl ? (
                          <button
                            type="button"
                            onClick={() => clearElementAsset(selectedItem.id)}
                            className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] text-red-100 hover:bg-red-500/15"
                          >
                            <Unlink className="h-3 w-3" />
                            {t('directorStudio.linkedImage.clear')}
                          </button>
                        ) : null}
                      </div>
                      {selectedItem.refImageUrl ? (
                        <div className="mb-3 flex items-center gap-2 rounded-md border border-white/10 bg-white/6 p-2">
                          <img
                            src={resolveImageDisplayUrl(selectedItem.refImageUrl) ?? selectedItem.refImageUrl}
                            alt={selectedItem.refImageName ?? selectedItem.label}
                            className="h-12 w-12 rounded object-cover"
                            draggable={false}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-xs text-white/82">{selectedItem.refImageName}</div>
                            <div className="text-[10px] text-white/38">{t('directorStudio.linkedImage.associated')}</div>
                          </div>
                        </div>
                      ) : (
                        <div className="mb-3 rounded-md border border-dashed border-white/12 px-3 py-4 text-center text-xs text-white/42">
                          {t('directorStudio.linkedImage.empty')}
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => openElementAssetPicker(selectedItem.id)}
                        className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-white/10 bg-white/6 text-xs text-white/74 hover:bg-white/12 hover:text-white"
                      >
                        <Link2 className="h-3.5 w-3.5" />
                        {selectedItem.refImageUrl ? t('directorStudio.linkedImage.change') : t('directorStudio.linkedImage.choose')}
                      </button>
                    </div>

                    <label className="block rounded-lg border border-white/10 bg-black/18 p-3">
                      <span className="mb-2 block text-[11px] font-medium uppercase tracking-wide text-white/42">
                        {t('directorStudio.inspector.relation')}
                      </span>
                      <textarea
                        value={inspectorTextDraft.itemId === selectedItem.id ? inspectorTextDraft.relation : selectedItem.relation ?? ''}
                        onChange={(event) => updateInspectorTextDraft('relation', event.target.value)}
                        onBlur={commitInspectorTextDraft}
                        onKeyUp={(event) => {
                          if (event.key === 'Enter') {
                            commitInspectorTextDraft();
                          }
                        }}
                        rows={3}
                        className="w-full resize-none rounded border border-white/12 bg-white/6 px-2.5 py-2 text-xs leading-5 text-white outline-none placeholder:text-white/30 focus:border-white/30"
                        placeholder={t('directorStudio.inspector.relationPlaceholder')}
                      />
                    </label>

                    <label className="block rounded-lg border border-white/10 bg-black/18 p-3">
                      <span className="mb-2 block text-[11px] font-medium uppercase tracking-wide text-white/42">
                        {t('directorStudio.inspector.note')}
                      </span>
                      <textarea
                        value={inspectorTextDraft.itemId === selectedItem.id ? inspectorTextDraft.note : selectedItem.note ?? ''}
                        onChange={(event) => updateInspectorTextDraft('note', event.target.value)}
                        onBlur={commitInspectorTextDraft}
                        onKeyUp={(event) => {
                          if (event.key === 'Enter') {
                            commitInspectorTextDraft();
                          }
                        }}
                        rows={3}
                        className="w-full resize-none rounded border border-white/12 bg-white/6 px-2.5 py-2 text-xs leading-5 text-white outline-none placeholder:text-white/30 focus:border-white/30"
                        placeholder={t('directorStudio.inspector.notePlaceholder')}
                      />
                    </label>

                    <TransformVectorBlock
                      title={t('directorStudio.inspector.position')}
                      values={ensurePos3d(selectedItem)}
                      step={0.1}
                      min={-20}
                      max={20}
                      onChange={(axis, value) => updateItemPosition(selectedItem, axis, value)}
                    />
                    <TransformVectorBlock
                      title={t('directorStudio.inspector.rotation')}
                      values={{
                        x: ((selectedItem.rotation3d?.x ?? 0) * 180) / Math.PI,
                        y: ((selectedItem.rotation3d?.y ?? 0) * 180) / Math.PI,
                        z: ((selectedItem.rotation3d?.z ?? 0) * 180) / Math.PI,
                      }}
                      step={1}
                      min={-180}
                      max={180}
                      suffix="°"
                      onChange={(axis, value) => updateItemRotationDegrees(selectedItem, axis, value)}
                    />
                    <TransformVectorBlock
                      title={t('directorStudio.inspector.scale')}
                      values={selectedItem.scale3d ?? { x: 1, y: 1, z: 1 }}
                      step={0.05}
                      min={0.1}
                      max={5}
                      onChange={(axis, value) => updateItemScale(selectedItem, axis, value)}
                    />

                    {selectedItem.category === 'person' ? (() => {
                      const bodyControls = normalizeBlueprintBodyControls(selectedItem.bodyControls);
                      return (
                        <>
                          <div className="rounded-lg border border-white/10 bg-black/18 p-3">
                            <div className="mb-3 text-[11px] font-medium uppercase tracking-wide text-white/42">
                              {t('directorStudio.inspector.action')}
                            </div>
                            <div className="grid grid-cols-3 gap-1.5">
                              {inspectorActionPresets.map((preset) => (
                                <button
                                  key={preset.id}
                                  type="button"
                                  onClick={() => updateItemActionImmediately(selectedItem, preset.value)}
                                  className={`h-8 rounded-md border text-xs ${
                                    isInspectorActionPresetSelected(selectedItem.action, preset)
                                      ? 'border-accent/70 bg-accent/18 text-white'
                                      : 'border-white/10 bg-white/6 text-white/62 hover:border-white/25 hover:text-white'
                                  }`}
                                >
                                  {t(preset.labelKey)}
                                </button>
                              ))}
                            </div>
                            {customActionPresets.length > 0 ? (
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {customActionPresets.map((preset) => {
                                  const isSelected = normalizeActionValue(selectedItem.action) === normalizeActionValue(preset);
                                  return (
                                    <div
                                      key={preset}
                                      className={`flex h-8 max-w-full overflow-hidden rounded-md border text-xs ${
                                        isSelected
                                          ? 'border-accent/70 bg-accent/18 text-white'
                                          : 'border-white/10 bg-white/6 text-white/62 hover:border-white/25 hover:text-white'
                                      }`}
                                    >
                                      <button
                                        type="button"
                                        onClick={() => updateItemActionImmediately(selectedItem, preset)}
                                        className="min-w-0 px-2 text-left"
                                      >
                                        <span className="block max-w-28 truncate">{preset}</span>
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => deleteCustomActionPreset(preset)}
                                        className="flex w-7 items-center justify-center border-l border-white/10 text-white/42 hover:bg-white/10 hover:text-white"
                                        title={t('directorStudio.inspector.deleteActionPreset', { name: preset })}
                                        aria-label={t('directorStudio.inspector.deleteActionPreset', { name: preset })}
                                      >
                                        <X className="h-3.5 w-3.5" />
                                      </button>
                                    </div>
                                  );
                                })}
                              </div>
                            ) : null}
                            <div className="mt-3 flex items-center gap-1.5">
                              <input
                                value={inspectorTextDraft.itemId === selectedItem.id ? inspectorTextDraft.action : selectedItem.action ?? ''}
                                onChange={(event) => updateInspectorTextDraft('action', event.target.value)}
                                onBlur={commitInspectorTextDraft}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') {
                                    commitInspectorTextDraft();
                                    event.currentTarget.blur();
                                  }
                                }}
                                className="h-9 min-w-0 flex-1 rounded border border-white/12 bg-white/6 px-2.5 text-xs text-white outline-none placeholder:text-white/30 focus:border-white/30"
                                placeholder={t('directorStudio.inspector.actionPlaceholder')}
                              />
                              <button
                                type="button"
                                onClick={saveCurrentActionPreset}
                                disabled={!selectedActionValue}
                                className="flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-white/12 bg-white/8 px-2.5 text-xs text-white/72 hover:border-white/25 hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
                              >
                                <Save className="h-3.5 w-3.5" />
                                {t('directorStudio.inspector.saveActionPreset')}
                              </button>
                            </div>
                            <button
                              type="button"
                              onClick={openCustomActionEditor}
                              className="mt-2 flex h-9 w-full items-center justify-center gap-1.5 rounded-md border border-accent/30 bg-accent/12 px-2.5 text-xs text-accent hover:bg-accent/18"
                            >
                              <SlidersHorizontal className="h-3.5 w-3.5" />
                              {t('directorStudio.inspector.editCustomActionPose')}
                            </button>
                          </div>

                          <div className="rounded-lg border border-white/10 bg-black/18 p-3">
                            <div className="mb-3 text-[11px] font-medium uppercase tracking-wide text-white/42">
                              {t('directorStudio.inspector.body')}
                            </div>
                            <div className="mb-3 grid grid-cols-5 gap-1.5">
                              {DIRECTOR_STUDIO_BODY_STYLES.map((style) => (
                                <button
                                  key={style.value}
                                  type="button"
                                  onClick={() => updateItemBodyControls(selectedItem, { style: style.value as BlueprintBodyStyle })}
                                  className={`h-8 rounded-md border text-[11px] ${
                                    bodyControls.style === style.value
                                      ? 'border-accent/70 bg-accent/18 text-white'
                                      : 'border-white/10 bg-white/6 text-white/62 hover:border-white/25 hover:text-white'
                                  }`}
                                >
                                  {t(style.labelKey)}
                                </button>
                              ))}
                            </div>
                            <label className="mb-3 flex items-center justify-between rounded-md border border-white/10 bg-white/6 px-3 py-2 text-xs text-white/78">
                              <span>{t('directorStudio.inspector.showControls')}</span>
                              <input
                                type="checkbox"
                                checked={bodyControls.showControls}
                                onChange={(event) => updateItemBodyControls(selectedItem, { showControls: event.target.checked })}
                                className="h-4 w-4 accent-white"
                              />
                            </label>
                            <div className="space-y-4">
                              <div>
                                <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-white/35">
                                  {t('directorStudio.inspector.bodyCore')}
                                </div>
                                <div className="space-y-2">
                                  <BodyScalarControl
                                    label={t('directorStudio.inspector.bodyHeight')}
                                    value={bodyControls.core.height}
                                    min={0.45}
                                    max={1.8}
                                    step={0.01}
                                    onChange={(value) => updateItemBodySection(selectedItem, 'core', { height: value })}
                                  />
                                  <BodyScalarControl
                                    label={t('directorStudio.inspector.torsoWidth')}
                                    value={bodyControls.core.torsoWidth}
                                    min={0.45}
                                    max={2}
                                    step={0.01}
                                    onChange={(value) => updateItemBodySection(selectedItem, 'core', { torsoWidth: value })}
                                  />
                                  <BodyScalarControl
                                    label={t('directorStudio.inspector.headScale')}
                                    value={bodyControls.core.headScale}
                                    min={0.55}
                                    max={1.8}
                                    step={0.01}
                                    onChange={(value) => updateItemBodySection(selectedItem, 'core', { headScale: value })}
                                  />
                                  <BodyScalarControl
                                    label={t('directorStudio.inspector.torsoLean')}
                                    value={bodyControls.core.torsoLeanDeg}
                                    min={-45}
                                    max={45}
                                    step={1}
                                    suffix="°"
                                    onChange={(value) => updateItemBodySection(selectedItem, 'core', { torsoLeanDeg: value })}
                                  />
                                </div>
                              </div>

                              <div>
                                <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-white/35">
                                  {t('directorStudio.inspector.bodyArms')}
                                </div>
                                <div className="space-y-2">
                                  <BodyScalarControl
                                    label={t('directorStudio.inspector.armLength')}
                                    value={bodyControls.arms.length}
                                    min={0.45}
                                    max={1.8}
                                    step={0.01}
                                    onChange={(value) => updateItemBodySection(selectedItem, 'arms', { length: value })}
                                  />
                                  <BodyScalarControl
                                    label={t('directorStudio.inspector.armThickness')}
                                    value={bodyControls.arms.thickness}
                                    min={0.45}
                                    max={2}
                                    step={0.01}
                                    onChange={(value) => updateItemBodySection(selectedItem, 'arms', { thickness: value })}
                                  />
                                  <BodyScalarControl
                                    label={t('directorStudio.inspector.armSpread')}
                                    value={bodyControls.arms.spreadDeg}
                                    min={-35}
                                    max={35}
                                    step={1}
                                    suffix="°"
                                    onChange={(value) => updateItemBodySection(selectedItem, 'arms', { spreadDeg: value })}
                                  />
                                </div>
                              </div>

                              <div>
                                <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-white/35">
                                  {t('directorStudio.inspector.bodyLegs')}
                                </div>
                                <div className="space-y-2">
                                  <BodyScalarControl
                                    label={t('directorStudio.inspector.legLength')}
                                    value={bodyControls.legs.length}
                                    min={0.45}
                                    max={1.8}
                                    step={0.01}
                                    onChange={(value) => updateItemBodySection(selectedItem, 'legs', { length: value })}
                                  />
                                  <BodyScalarControl
                                    label={t('directorStudio.inspector.legThickness')}
                                    value={bodyControls.legs.thickness}
                                    min={0.45}
                                    max={2}
                                    step={0.01}
                                    onChange={(value) => updateItemBodySection(selectedItem, 'legs', { thickness: value })}
                                  />
                                  <BodyScalarControl
                                    label={t('directorStudio.inspector.legSpread')}
                                    value={bodyControls.legs.spreadDeg}
                                    min={-25}
                                    max={35}
                                    step={1}
                                    suffix="°"
                                    onChange={(value) => updateItemBodySection(selectedItem, 'legs', { spreadDeg: value })}
                                  />
                                </div>
                              </div>
                            </div>
                          </div>
                        </>
                      );
                    })() : null}
                  </div>
                </div>
              ) : (
                <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-xs leading-5 text-white/42">
                  {t('directorStudio.inspector.empty')}
                </div>
              )}
            </aside>
          ) : null}

            {sidePanel === 'snapshot' && data.snapshotUrl ? (
              <aside
                className="absolute top-16 z-30 flex flex-col rounded-lg border border-white/12 bg-[#151618]/96 p-3 shadow-2xl"
                style={{
                  zIndex: sidePanelZIndex,
                  right: compactLayout ? 12 : 16,
                  width: compactLayout ? Math.min(360, viewportSize.width - 24) : 340,
                  bottom: motionTimelineHeight + motionToolbarHeight,
                }}
                onPointerDownCapture={() => bringFloatingSurfaceToFront('side')}
              >
                <div className="mb-3 flex items-center justify-between">
                  <div className="text-xs font-medium text-white/86">{t('directorStudio.snapshotPreview')}</div>
                  <button
                  type="button"
                  onClick={() => setSidePanel(null)}
                  className="rounded p-1 text-white/45 hover:bg-white/10 hover:text-white"
                  aria-label={t('common.close')}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
                <button
                  type="button"
                  onClick={() => setLightboxSnapshotUrl(data.snapshotUrl ?? null)}
                  className="min-h-0 flex-1 overflow-hidden rounded-md bg-black/35"
                  title={t('directorStudio.openSnapshotLightbox')}
                >
                  <img
                    src={resolveImageDisplayUrl(data.snapshotUrl) ?? data.snapshotUrl}
                    alt={t('directorStudio.snapshotPreview')}
                    className="h-full w-full object-contain"
                    draggable={false}
                  />
                </button>
                <div className="mt-3">
                  <div className="mb-1.5 flex items-center justify-between text-[10px] text-white/42">
                    <span>{t('directorStudio.snapshotHistory')}</span>
                    <span>{t('directorStudio.snapshotCount', { count: snapshotHistory.length })}</span>
                  </div>
                  <div className="ui-scrollbar grid max-h-[92px] grid-cols-5 gap-1.5 overflow-y-auto pr-1">
                      {snapshotHistory.map((snapshotUrl, index) => {
                        const isCurrent = snapshotUrl === data.snapshotUrl;
                        return (
                          <div
                            key={`${snapshotUrl.slice(0, 48)}-${index}`}
                            className={`group relative aspect-video overflow-hidden rounded border bg-black/35 ${
                              isCurrent ? 'border-emerald-300/80 ring-1 ring-emerald-300/35' : 'border-white/10 hover:border-white/35'
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => { void selectSnapshot(snapshotUrl); }}
                              className="block h-full w-full"
                              title={t('directorStudio.selectSnapshot')}
                            >
                              <img
                                src={resolveImageDisplayUrl(snapshotUrl) ?? snapshotUrl}
                                alt={t('directorStudio.snapshotThumbnail', { count: index + 1 })}
                                className="h-full w-full object-cover"
                                draggable={false}
                              />
                              <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[9px] text-white/72">{index + 1}</span>
                            </button>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                void deleteSnapshot(snapshotUrl);
                              }}
                              className="absolute right-1 top-1 rounded bg-black/70 p-0.5 text-white/70 opacity-0 transition-opacity hover:bg-red-500/80 hover:text-white group-hover:opacity-100 group-focus-within:opacity-100"
                              aria-label={t('directorStudio.deleteSnapshot')}
                              title={t('directorStudio.deleteSnapshot')}
                            >
                              <X className="h-2.5 w-2.5" />
                            </button>
                          </div>
                        );
                      })}
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={clearCurrentSnapshot}
                    className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-white/10 bg-white/6 text-xs text-white/72 hover:bg-white/12 hover:text-white"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {t('directorStudio.clearCurrentSnapshot')}
                  </button>
                  <button
                    type="button"
                    onClick={clearAllSnapshots}
                    disabled={snapshotHistory.length === 0}
                    className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-white/10 bg-white/6 text-xs text-white/72 hover:bg-white/12 hover:text-white disabled:text-white/32"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {t('directorStudio.clearAllSnapshots')}
                  </button>
                  <button
                    type="button"
                  onClick={addSnapshotToCanvas}
                  disabled={!data.snapshotUrl || !onAddSnapshotToCanvas || isAddingSnapshotToCanvas}
                  title={t('directorStudio.addToCanvasTitle')}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-emerald-400/30 bg-emerald-400/16 text-xs font-medium text-emerald-100 hover:bg-emerald-400/24 disabled:border-white/10 disabled:bg-white/6 disabled:text-white/32"
                >
                    <Plus className="h-3.5 w-3.5" />
                    {t('directorStudio.addToCanvas')}
                  </button>
                  <button
                    type="button"
                    onClick={addAllSnapshotsToCanvas}
                    disabled={snapshotHistory.length === 0 || !onAddSnapshotToCanvas || isAddingSnapshotToCanvas}
                    title={t('directorStudio.addAllToCanvasTitle')}
                    className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-emerald-400/30 bg-emerald-400/16 text-xs font-medium text-emerald-100 hover:bg-emerald-400/24 disabled:border-white/10 disabled:bg-white/6 disabled:text-white/32"
                  >
                    <ImagePlus className="h-3.5 w-3.5" />
                    {t('directorStudio.addAllToCanvas')}
                  </button>
                </div>
              </aside>
            ) : null}

          {lightboxSnapshotUrl ? (
            <div className="absolute inset-0 z-[65] flex items-center justify-center bg-black/78 p-8">
              <button
                type="button"
                onClick={() => setLightboxSnapshotUrl(null)}
                className="absolute right-5 top-5 inline-flex h-9 w-9 items-center justify-center rounded-md border border-white/12 bg-white/8 text-white/70 hover:bg-white/14 hover:text-white"
                aria-label={t('common.close')}
              >
                <X className="h-4 w-4" />
              </button>
              <img
                src={resolveImageDisplayUrl(lightboxSnapshotUrl) ?? lightboxSnapshotUrl}
                alt={t('directorStudio.snapshotPreview')}
                className="max-h-full max-w-full rounded-lg border border-white/12 bg-black/45 object-contain shadow-2xl"
                draggable={false}
              />
            </div>
          ) : null}

          {!lowHeightLayout || !timelineOpen ? (
            <div className="pointer-events-none absolute inset-x-0 z-40 flex justify-center" style={{ bottom: motionTimelineHeight + 20 }}>
              <div className="director-studio-tool-dock ui-scrollbar pointer-events-auto flex max-w-[calc(100%-24px)] flex-wrap items-center justify-center gap-1 rounded-lg border border-white/12 bg-[#151618]/92 p-1.5 shadow-2xl">
                {orderedToolbarButtons.map((button) => {
                  const Icon = button.icon;
                  if (button.key === 'transform') {
                    return (
                      <div
                        key={button.key}
                        ref={(node) => {
                          toolbarAnchorRefs.current[button.key] = node;
                        }}
                        className={`flex h-10 shrink-0 items-center gap-1 rounded-md border px-1 transition-colors ${
                          button.active
                            ? 'border-accent/45 bg-accent/14'
                            : button.disabled
                              ? 'border-transparent text-white/28'
                              : 'border-transparent text-white/72 hover:bg-white/8'
                        }`}
                        title={button.title}
                      >
                        <button
                          type="button"
                          disabled={button.disabled}
                          onClick={button.onClick}
                          aria-label={button.title}
                          className={`flex h-8 w-9 items-center justify-center gap-1 rounded px-1 text-[10px] min-[1700px]:w-auto min-[1700px]:min-w-[58px] min-[1700px]:px-1.5 ${
                            button.active
                              ? 'text-accent'
                              : button.disabled
                                ? 'text-white/28'
                                : 'text-white/72 hover:bg-white/10 hover:text-white'
                          }`}
                        >
                          <Icon className="h-4 w-4" />
                          <span className="hidden max-w-[42px] truncate min-[1700px]:block">{button.label}</span>
                        </button>
                        <div className="flex items-center gap-0.5">
                          {TRANSFORM_MODE_OPTIONS.map((option) => {
                            const ModeIcon = option.icon;
                            const isActive = activeTransformMode === option.mode;
                            const shortcut = shortcuts[option.shortcutId];
                            return (
                              <button
                                key={option.mode}
                                type="button"
                                disabled={!selectedItem}
                                onClick={() => setActiveTransformMode(option.mode)}
                                title={selectedItem ? `${t(option.titleKey)} · ${shortcut}` : t('directorStudio.selectElementFirst')}
                                aria-label={selectedItem ? `${t(option.titleKey)} · ${shortcut}` : t('directorStudio.selectElementFirst')}
                                className={`relative flex h-8 w-8 items-center justify-center rounded text-[10px] transition-colors ${
                                  isActive
                                    ? 'bg-accent/28 text-accent'
                                    : selectedItem
                                      ? 'text-white/68 hover:bg-white/10 hover:text-white'
                                      : 'text-white/24'
                                }`}
                              >
                                <ModeIcon className="h-4 w-4" />
                                <span className="absolute bottom-0.5 right-1 font-mono text-[8px] opacity-70">
                                  {shortcut}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  }
                  return (
                    <button
                      key={button.key}
                      ref={(node) => {
                        toolbarAnchorRefs.current[button.key] = node;
                      }}
                      type="button"
                      disabled={button.disabled}
                      onClick={button.onClick}
                      title={button.title}
                      aria-label={button.title}
                      aria-pressed={button.active ?? undefined}
                      className={`flex h-10 w-10 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md px-1 text-[10px] transition-colors min-[1700px]:w-auto min-[1700px]:min-w-[74px] min-[1700px]:px-2 ${
                        button.active
                          ? 'bg-accent/25 text-accent'
                          : button.disabled
                            ? 'text-white/28'
                            : 'text-white/72 hover:bg-white/10 hover:text-white'
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                      <span className="hidden max-w-full truncate min-[1700px]:block">{button.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          <DirectorCameraPilotHud
            active={pilotActive}
            recording={false}
            currentTime={motionTimeSource.getSnapshot()}
            timeSource={motionTimeSource}
            targetLabel={data.items.find((item) => item.id === pilotTargetId)?.label ?? null}
            onExit={() => editorRef.current?.exitPilot()}
          />

          {timelineOpen ? (
            <DirectorTimeline
              height={motionTimelineHeight}
              project={motionProject}
              items={data.items}
              timeSource={motionTimeSource}
              playbackSource={playbackSource}
              selection={motionSelection}
              showRoutes={motionShowRoutes}
              previewMode={motionPreviewMode}
              pilotActive={pilotActive}
              onTimeChange={setMotionTimeAndApply}
              onTogglePlayback={() => setMotionPlaying((value) => !value)}
              onGoToStart={() => { setMotionPlaying(false); setMotionTimeAndApply(0); }}
              onLoopChange={(loop) => {
                updateMotionProject((project) => ({ ...project, loop }));
              }}
              onDurationChange={updateMotionDuration}
              onSelectionChange={setMotionSelection}
              onMoveKeyframe={moveMotionKeyframe}
              onPatchKeyframe={patchMotionKeyframe}
              onDuplicateKeyframe={duplicateMotionKeyframe}
              onDeleteKeyframe={deleteMotionKeyframe}
              onAddCameraKeyframe={addCameraMotionKeyframe}
              onAddObjectKeyframe={addObjectMotionKeyframe}
              onAddActionKeyframe={(itemId) => addActionMotionKeyframe(itemId)}
              onShowRoutesChange={setMotionShowRoutes}
              onPreviewModeChange={setPreviewModeAndApply}
              onTogglePilot={toggleCameraPilot}
              onOpenActionLibrary={() => setActionLibraryOpen(true)}
              onOpenExport={openVideoExport}
              onApplyCameraPreset={applyCameraPreset}
              onClose={() => setTimelineOpen(false)}
            />
          ) : null}
        </main>
      </div>

      {importOpen ? (
        <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/55 p-6">
          <section className="flex max-h-[78vh] w-[620px] flex-col rounded-lg border border-white/12 bg-[#151618] shadow-2xl">
            <div className="flex h-12 items-center justify-between border-b border-white/10 px-4">
              <div className="min-w-0">
                <div className="text-sm font-medium text-white/88">{t('directorStudio.panoramaImport')}</div>
                <div className="mt-0.5 truncate text-[11px] text-white/42">{t('directorStudio.panoramaImportHint')}</div>
              </div>
              <button
                type="button"
                onClick={() => setImportOpen(false)}
                className="rounded p-1.5 text-white/45 hover:bg-white/10 hover:text-white"
                aria-label={t('common.close')}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleUploadPanorama}
              />
              <div className="mb-4 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isUploadingPanorama}
                  className="flex h-11 items-center justify-center gap-2 rounded-md border border-white/12 bg-white/8 text-sm text-white/78 hover:bg-white/14 hover:text-white"
                >
                  <Upload className="h-4 w-4" />
                  {panoramaImportStageLabel ?? (isUploadingPanorama ? t('directorStudio.importing') : t('directorStudio.uploadPanorama'))}
                </button>
                <button
                  type="button"
                  disabled={!rawPanoramaUrl || isUploadingPanorama}
                  onClick={clearPanorama}
                  className={`flex h-11 items-center justify-center gap-2 rounded-md border text-sm ${
                    rawPanoramaUrl && !isUploadingPanorama
                      ? 'border-red-300/20 bg-red-500/10 text-red-100 hover:bg-red-500/18'
                      : 'border-white/10 bg-white/5 text-white/30'
                  }`}
                >
                  <Eraser className="h-4 w-4" />
                  {t('directorStudio.clearPanorama')}
                </button>
              </div>

              <div className="mb-2 text-xs text-white/58">{t('directorStudio.importFromAssets')}</div>
              {panoramaImportAssets.length === 0 ? (
                <div className="rounded-lg border border-dashed border-white/12 px-3 py-10 text-center text-xs text-white/42">
                  {t('directorStudio.noImportAssets')}
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-3">
                  {panoramaImportAssets.map((image) => {
                    const displayUrl = resolveImageDisplayUrl(image.url) ?? image.url;
                    const active = rawPanoramaUrl === image.url;
                    return (
                      <button
                        key={image.id}
                        type="button"
                        onClick={() => void importPanorama(image.url, image.label)}
                        disabled={isUploadingPanorama}
                        className={`overflow-hidden rounded-lg border bg-black/22 text-left transition-colors ${
                          active ? 'border-accent/80' : 'border-white/10 hover:border-white/28'
                        }`}
                      >
                        <div className="relative aspect-video bg-black/30">
                          <img src={displayUrl} alt={image.label} className="h-full w-full object-cover" draggable={false} />
                          {active ? (
                            <span className="absolute right-2 top-2 rounded-full bg-accent p-1 text-black">
                              <Check className="h-3 w-3" />
                            </span>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-2 px-2 py-2 text-xs text-white/74">
                          <Image className="h-3.5 w-3.5 shrink-0 text-white/42" />
                          <span className="min-w-0 flex-1 truncate">{image.label}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        </div>
      ) : null}

      {assetPickerItem ? (
        <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/55 p-6">
          <section className="flex max-h-[76vh] w-[620px] flex-col rounded-lg border border-white/12 bg-[#151618] shadow-2xl">
            <div className="flex h-12 items-center justify-between border-b border-white/10 px-4">
              <div>
                <div className="text-sm font-medium text-white/88">{t('directorStudio.linkedImage.pickerTitle')}</div>
                <div className="text-[10px] text-white/38">
                  {t('directorStudio.linkedImage.pickerSubtitle', { name: assetPickerItem.label })}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setAssetPickerItemId(null)}
                className="rounded p-1.5 text-white/45 hover:bg-white/10 hover:text-white"
                aria-label={t('common.close')}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="border-b border-white/10 p-4">
              <input
                ref={elementImageInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={uploadElementAsset}
              />
              <input
                value={assetQuery}
                onChange={(event) => setAssetQuery(event.target.value)}
                placeholder={t('directorStudio.linkedImage.search')}
                className={`h-9 w-full px-3 text-xs ${DIRECTOR_FIELD_CLASS}`}
              />
              <button
                type="button"
                onClick={() => elementImageInputRef.current?.click()}
                disabled={isUploadingElementImage}
                className="mt-2 inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-white/12 bg-white/8 text-xs text-white/74 hover:bg-white/14 hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Upload className="h-3.5 w-3.5" />
                {isUploadingElementImage
                  ? t('directorStudio.linkedImage.uploading')
                  : t('directorStudio.linkedImage.uploadAndLink')}
              </button>
            </div>
            <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
              {elementAssetOptions.length === 0 ? (
                <div className="rounded-lg border border-dashed border-white/12 px-3 py-10 text-center text-xs text-white/42">
                  {t('directorStudio.linkedImage.noAssets')}
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-3">
                  {elementAssetOptions.map((asset) => {
                    const displayUrl = resolveImageDisplayUrl(asset.url) ?? asset.url;
                    const active = assetPickerItem.refImageUrl === asset.url;
                    return (
                      <button
                        key={asset.id}
                        type="button"
                        onClick={() => chooseElementAsset(asset)}
                        className={`overflow-hidden rounded-lg border bg-black/22 text-left transition-colors ${
                          active ? 'border-accent/80' : 'border-white/10 hover:border-white/28'
                        }`}
                      >
                        <div className="relative aspect-video bg-black/30">
                          <img src={displayUrl} alt={asset.label} className="h-full w-full object-cover" draggable={false} />
                          {active ? (
                            <span className="absolute right-2 top-2 rounded-full bg-accent p-1 text-black">
                              <Check className="h-3 w-3" />
                            </span>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-2 px-2 py-2 text-xs text-white/74">
                          <Image className="h-3.5 w-3.5 shrink-0 text-white/42" />
                          <span className="min-w-0 flex-1 truncate">{asset.label}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="flex justify-between gap-2 border-t border-white/10 px-4 py-3">
              <button
                type="button"
                disabled={!assetPickerItem.refImageUrl}
                onClick={() => {
                  clearElementAsset(assetPickerItem.id);
                  setAssetPickerItemId(null);
                }}
                className={`inline-flex h-9 items-center gap-2 rounded-md border px-3 text-xs ${
                  assetPickerItem.refImageUrl
                    ? 'border-red-300/20 bg-red-500/10 text-red-100 hover:bg-red-500/18'
                    : 'border-white/10 bg-white/5 text-white/30'
                }`}
              >
                <Unlink className="h-3.5 w-3.5" />
                {t('directorStudio.linkedImage.clear')}
              </button>
              <button
                type="button"
                onClick={() => setAssetPickerItemId(null)}
                className="h-9 rounded-md border border-white/10 bg-white/6 px-3 text-xs text-white/68 hover:bg-white/12 hover:text-white"
              >
                {t('common.cancel')}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      <DirectorActionLibrary
        isOpen={actionLibraryOpen}
        selectedItem={selectedItem}
        project={motionProject}
        currentTime={motionTimeSource.getSnapshot()}
        customActionPoses={data.customActionPoses ?? {}}
        onClose={() => setActionLibraryOpen(false)}
        onApplyStaticPose={(poseId, pose) => applyMotionActionState({ poseId, pose })}
        onApplyProceduralAction={(actionId) => applyMotionActionState({ actionId })}
        onApplyClip={(clip) => applyMotionActionState({ clipId: clip.id })}
        onSaveClip={saveMotionClip}
        onRenameClip={(clipId, name) => updateMotionClip(clipId, { name: name.trim() || t('directorStudio.motion.library.untitledClip') })}
        onDuplicateClip={duplicateMotionClip}
        onDeleteClip={deleteMotionClip}
        onLoopClip={(clipId, loop) => updateMotionClip(clipId, { loop })}
      />

      <DirectorVideoExportDialog
        isOpen={videoExportOpen}
        durationSeconds={motionProject.durationSeconds}
        format={videoExportResult ? { mimeType: videoExportResult.mimeType, extension: videoExportResult.extension } : availableVideoFormat}
        resolution={videoExportResolution}
        fps={videoExportFps}
        isRecording={videoExportRecording}
        progress={videoExportProgress}
        error={videoExportError}
        result={videoExportResult}
        onResolutionChange={setVideoExportResolution}
        onFpsChange={setVideoExportFps}
        onStart={() => { void startVideoExport(); }}
        onCancel={cancelVideoExport}
        onSave={saveVideoExport}
        onAddToCanvas={() => { void addVideoExportToCanvas(); }}
        onClose={() => setVideoExportOpen(false)}
      />

      <BlueprintCustomActionModal
        isOpen={customActionModalOpen}
        onClose={() => setCustomActionModalOpen(false)}
        nameValue={customActionName}
        poseValue={customActionPose}
        onNameChange={setCustomActionName}
        onPoseChange={setCustomActionPose}
        onSave={saveCustomActionPose}
      />

      {activeDialog === 'shortcuts' ? (
        <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/55 p-6">
          <section className="flex max-h-[82vh] w-[760px] flex-col rounded-lg border border-white/12 bg-[#151618] shadow-2xl">
            <div className="flex h-12 items-center justify-between border-b border-white/10 px-4">
              <div className="text-sm font-medium text-white/88">{t('directorStudio.shortcuts.title')}</div>
              <button
                type="button"
                onClick={() => setActiveDialog(null)}
                className="rounded p-1.5 text-white/45 hover:bg-white/10 hover:text-white"
                aria-label={t('common.close')}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="ui-scrollbar grid min-h-0 flex-1 gap-3 overflow-y-auto p-4 md:grid-cols-2">
              <section className="rounded-lg border border-white/10 bg-black/18 p-3 md:col-span-2">
                <div className="mb-3 text-xs font-medium text-white/82">{t('directorStudio.viewSettings.title')}</div>
                <div className="grid gap-2 md:grid-cols-3">
                  <DirectorSettingToggle
                    label={t('directorStudio.viewSettings.wheelZoomEnabled')}
                    description={t('directorStudio.viewSettings.wheelZoomEnabledHint')}
                    checked={viewSettings.wheelZoomEnabled}
                    onChange={(checked) => updateViewSettings({ wheelZoomEnabled: checked })}
                  />
                  <DirectorSettingToggle
                    label={t('directorStudio.viewSettings.reverseWheelZoom')}
                    description={t('directorStudio.viewSettings.reverseWheelZoomHint')}
                    checked={viewSettings.reverseWheelZoom}
                    onChange={(checked) => updateViewSettings({ reverseWheelZoom: checked })}
                  />
                  <DirectorSettingToggle
                    label={t('directorStudio.viewSettings.showAdvancedPedestrianTags')}
                    description={t('directorStudio.viewSettings.showAdvancedPedestrianTagsHint')}
                    checked={viewSettings.showAdvancedPedestrianTags}
                    onChange={(checked) => updateViewSettings({ showAdvancedPedestrianTags: checked })}
                  />
                </div>
              </section>
              {SHORTCUT_GROUPS.map((group) => (
                <section key={group.titleKey} className="rounded-lg border border-white/10 bg-black/18 p-3">
                  <div className="mb-3 text-xs font-medium text-white/82">{t(group.titleKey)}</div>
                  <div className="space-y-2">
                    {group.entries.map((entry) => {
                      const keyText = (entry.shortcutId ? shortcuts[entry.shortcutId] : entry.defaultKeys) ?? '';
                      const isEditing = entry.shortcutId === editingShortcutId;
                      return (
                      <div key={`${group.titleKey}-${entry.shortcutId ?? entry.defaultKeys}`} className="grid grid-cols-[132px_minmax(0,1fr)] gap-3 text-xs">
                        <button
                          type="button"
                          disabled={!entry.shortcutId}
                          onClick={() => entry.shortcutId && setEditingShortcutId(entry.shortcutId)}
                          className={`rounded border px-2 py-1 text-center font-mono text-[11px] transition-colors ${
                            isEditing
                              ? 'border-accent bg-accent/20 text-accent'
                              : entry.shortcutId
                                ? 'border-white/12 bg-white/8 text-white/78 hover:border-white/28 hover:bg-white/12 hover:text-white'
                                : 'cursor-default border-white/8 bg-white/[0.04] text-white/42'
                          }`}
                        >
                          {isEditing ? t('directorStudio.shortcuts.recording') : keyText}
                        </button>
                        <span className="leading-6 text-white/58">{t(entry.labelKey)}</span>
                      </div>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          </section>
        </div>
      ) : null}

      {activeDialog === 'modelLibrary' ? (
        <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/55 p-6">
          <section className="flex max-h-[82vh] w-[820px] flex-col rounded-lg border border-white/12 bg-[#151618] shadow-2xl">
            <div className="flex h-12 items-center justify-between border-b border-white/10 px-4">
              <div className="text-sm font-medium text-white/88">{t('directorStudio.modelLibrary.title')}</div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled
                  title={t('directorStudio.modelLibrary.uploadDeferred')}
                  className="inline-flex h-8 items-center gap-2 rounded-md border border-white/10 bg-white/5 px-3 text-xs text-white/32"
                >
                  <Upload className="h-3.5 w-3.5" />
                  {t('directorStudio.modelLibrary.uploadModel')}
                </button>
                <button
                  type="button"
                  onClick={() => setActiveDialog(null)}
                  className="rounded p-1.5 text-white/45 hover:bg-white/10 hover:text-white"
                  aria-label={t('common.close')}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="flex min-h-0 flex-1">
              <div className="w-36 shrink-0 border-r border-white/10 p-2">
                <div className="space-y-1">
                  {DIRECTOR_STUDIO_MODEL_CATEGORIES.map((category) => (
                    <button
                      key={category.id}
                      type="button"
                      onClick={() => setActiveModelCategory(category.id)}
                      className={`flex h-9 w-full items-center rounded-md px-3 text-left text-xs ${
                        activeModelCategory === category.id
                          ? 'bg-white text-black'
                          : 'bg-white/5 text-white/62 hover:bg-white/10 hover:text-white'
                      }`}
                    >
                      {t(category.labelKey)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
                {activeModelCategory === 'mine' ? (
                  <div className="flex min-h-[320px] flex-col items-center justify-center rounded-lg border border-dashed border-white/12 text-center">
                    <Box className="mb-3 h-8 w-8 text-white/28" />
                    <div className="text-sm text-white/58">{t('directorStudio.modelLibrary.myModelsEmpty')}</div>
                    <div className="mt-1 max-w-[300px] text-xs leading-5 text-white/36">
                      {t('directorStudio.modelLibrary.myModelsHint')}
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-3 md:grid-cols-4">
                    {modelCards.map((model) => {
                      const modelName = t(getModelNameKey(model), model.displayName);
                      return (
                        <button
                          key={model.id}
                          type="button"
                          onClick={() => insertModel(model)}
                          className="group overflow-hidden rounded-lg border border-white/10 bg-black/20 text-left transition-colors hover:border-white/28 hover:bg-white/[0.07]"
                        >
                          <div className="flex aspect-[4/3] items-center justify-center bg-white/[0.04] p-4">
                            <DirectorStudioModelThumbnail model={model} />
                          </div>
                          <div className="border-t border-white/8 px-2.5 py-2">
                            <div className="truncate text-xs font-medium text-white/82 group-hover:text-white">{modelName}</div>
                            <div className="mt-1 flex items-center gap-1.5 text-[10px] text-white/38">
                              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: model.color }} />
                              <span>
                                {model.itemCategory === 'person'
                                  ? t('directorStudio.category.person')
                                  : model.itemCategory === 'scene'
                                    ? t('directorStudio.category.scene')
                                    : t('directorStudio.category.object')}
                              </span>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {activeDialog === 'pedestrians' ? (
        <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/55 p-6">
          <section className="w-[520px] rounded-lg border border-white/12 bg-[#151618] shadow-2xl">
            <div className="flex h-12 items-center justify-between border-b border-white/10 px-4">
              <div className="text-sm font-medium text-white/88">{t('directorStudio.pedestrians.title')}</div>
              <button
                type="button"
                onClick={() => setActiveDialog(null)}
                className="rounded p-1.5 text-white/45 hover:bg-white/10 hover:text-white"
                aria-label={t('common.close')}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-4">
              <div className="grid grid-cols-3 gap-2">
                {([
                  ['direct', 'directorStudio.pedestrians.modes.direct'],
                  ['array', 'directorStudio.pedestrians.modes.array'],
                  ['random', 'directorStudio.pedestrians.modes.random'],
                ] as const).map(([mode, labelKey]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setPedestrianMode(mode)}
                    className={`h-9 rounded-md border text-xs ${
                      pedestrianMode === mode
                        ? 'border-accent/70 bg-accent/18 text-white'
                        : 'border-white/10 bg-white/6 text-white/65 hover:border-white/25 hover:text-white'
                    }`}
                  >
                    {t(labelKey)}
                  </button>
                ))}
              </div>

              {pedestrianMode !== 'direct' ? (
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <label className="text-[11px] text-white/62">
                    <span>{t('directorStudio.pedestrians.count')}</span>
                    <input
                      type="number"
                      min={1}
                      max={200}
                      value={pedestrianCount}
                      onChange={(event) => setPedestrianCount(Number(event.target.value))}
                      className="mt-1 h-9 w-full rounded border border-white/12 bg-black/30 px-2 text-xs text-white outline-none focus:border-white/30"
                    />
                  </label>
                  {pedestrianMode === 'array' ? (
                    <label className="text-[11px] text-white/62">
                      <span>{t('directorStudio.pedestrians.columns')}</span>
                      <input
                        type="number"
                        min={1}
                        max={50}
                        value={pedestrianColumns}
                        onChange={(event) => setPedestrianColumns(Number(event.target.value))}
                        className="mt-1 h-9 w-full rounded border border-white/12 bg-black/30 px-2 text-xs text-white outline-none focus:border-white/30"
                      />
                    </label>
                  ) : (
                    <label className="text-[11px] text-white/62">
                      <span>{t('directorStudio.pedestrians.radius')}</span>
                      <input
                        type="number"
                        min={0.5}
                        max={30}
                        step={0.5}
                        value={pedestrianRadius}
                        onChange={(event) => setPedestrianRadius(Number(event.target.value))}
                        className="mt-1 h-9 w-full rounded border border-white/12 bg-black/30 px-2 text-xs text-white outline-none focus:border-white/30"
                      />
                    </label>
                  )}
                  {pedestrianMode === 'array' ? (
                    <>
                      <label className="text-[11px] text-white/62">
                        <span>{t('directorStudio.pedestrians.xSpacing')}</span>
                        <input
                          type="number"
                          min={0.2}
                          max={10}
                          step={0.1}
                          value={pedestrianXSpacing}
                          onChange={(event) => setPedestrianXSpacing(Number(event.target.value))}
                          className="mt-1 h-9 w-full rounded border border-white/12 bg-black/30 px-2 text-xs text-white outline-none focus:border-white/30"
                        />
                      </label>
                      <label className="text-[11px] text-white/62">
                        <span>{t('directorStudio.pedestrians.zSpacing')}</span>
                        <input
                          type="number"
                          min={0.2}
                          max={10}
                          step={0.1}
                          value={pedestrianZSpacing}
                          onChange={(event) => setPedestrianZSpacing(Number(event.target.value))}
                          className="mt-1 h-9 w-full rounded border border-white/12 bg-black/30 px-2 text-xs text-white outline-none focus:border-white/30"
                        />
                      </label>
                    </>
                  ) : null}
                </div>
              ) : (
                <div className="mt-4 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-4 text-xs leading-5 text-white/52">
                  {t('directorStudio.pedestrians.directHint')}
                </div>
              )}

              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setActiveDialog(null)}
                  className="h-9 rounded-md border border-white/10 bg-white/6 px-3 text-xs text-white/64 hover:bg-white/10 hover:text-white"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => addPedestrians(pedestrianMode)}
                  className="h-9 rounded-md bg-white px-4 text-xs font-medium text-black hover:bg-white/90"
                >
                  {pedestrianMode === 'direct'
                    ? t('directorStudio.pedestrians.addOne')
                    : t('directorStudio.pedestrians.addBatch')}
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );

  if (typeof document === 'undefined') {
    return null;
  }

  return createPortal(content, document.body);
});

DirectorStudioShell.displayName = 'DirectorStudioShell';
