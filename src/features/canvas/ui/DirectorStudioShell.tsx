import { PanelResizeHandle } from '@/components/ui/PanelResizeHandle';
import { useSettingsStore } from '@/stores/settingsStore';
import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  Aperture,
  Box,
  Camera,
  Eraser,
  Film,
  Hand,
  Keyboard,
  ImagePlus,
  Layers3,
  Lightbulb,
  MousePointer2,
  Move3d,
  PenLine,
  PersonStanding,
  Plus,
  Rotate3d,
  Route,
  Ruler,
  Scaling,
  Trash2,
  Unlink,
  Upload,
  UserPlus,
  Users,
  X,
} from 'lucide-react';

import {
  CANVAS_NODE_TYPES,
  type BlueprintActionPose,
  type BlueprintBodyControls,
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
import {
  DIRECTOR_CAMERA_PRESETS,
  normalizeDirectorMotionProject,
  type DirectorCameraPresetId,
} from '@/features/canvas/application/directorMotion';
import {
  DIRECTOR_STUDIO_MODEL_CATALOG,
  DIRECTOR_STUDIO_MODEL_CATEGORIES,
  type DirectorStudioModelCatalogItem,
  type DirectorStudioModelCategoryId,
} from '@/features/canvas/domain/directorStudioModelCatalog';
import type { BlueprintSceneHandle } from '@/features/canvas/ui/BlueprintScene';
import { applyPersonPosePatch, normalizePersonPose, type PersonPoseJoint } from '@/features/canvas/domain/personPose';
import { PersonPoseInspector } from '@/features/canvas/ui/PersonPoseInspector';
import type { PersonPoseEdit } from '@/features/canvas/ui/personPoseEditor';
import type { ImportedModelAsset } from '@/features/stage/domain/importedModel';
import { deleteImportedModel, listImportedModels } from '@/features/stage/application/importedModelLibrary';
import { importModelFile } from '@/features/stage/application/importModelFile';
import { DirectorStudioModelThumbnail } from '@/features/canvas/ui/DirectorStudioModelThumbnail';
import { prepareNodeImageFromFile, resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import {
  importDirectorStudioPanorama,
  type DirectorStudioPanoramaImportStage,
} from '@/features/canvas/application/directorStudioPanoramaImport';
import type { BlueprintReferenceImage } from '@/features/canvas/application/blueprintPrompt';
import { showErrorDialog } from '@/features/canvas/application/errorDialog';
import { DirectorActionLibrary } from '@/features/canvas/ui/DirectorActionLibrary';
import { DirectorCameraPilotHud } from '@/features/canvas/ui/DirectorCameraPilotHud';
import {
  DirectorSceneErrorBoundary,
  isDirectorSceneModuleLoadError,
} from '@/features/canvas/ui/DirectorSceneErrorBoundary';
import { DirectorTimeline } from '@/features/canvas/ui/DirectorTimeline';
import { DirectorPrevisCameraInspector, DirectorPrevisItemMotion } from './DirectorPrevisMotion';
import { DirectorItemInspector } from './DirectorItemInspector';
import { DirectorVideoExportDialog } from '@/features/canvas/ui/DirectorVideoExportDialog';
import { useDirectorStudioMotion } from '@/features/canvas/ui/useDirectorStudioMotion';
import { useDirectorTooltips } from '@/features/canvas/ui/useDirectorTooltips';
import type { CanvasEventMap } from '@/features/canvas/application/ports';
import { ensurePos3d, genBlueprintItemId, pos3dToLegacy } from '@/features/canvas/ui/blueprintCoordinates';
import { useCanvasStore } from '@/stores/canvasStore';
import { stageCommands } from '@/features/stage/application/stageCommands';
import { appendSnapshotHistory, normalizeSnapshotHistory, persistSnapshotHistory, screenshotExportOptions, waitForNextStageFrame } from '@/features/stage/application/stageSnapshotMedia';
import { useStageSnapshotActions } from '@/features/stage/ui/useStageSnapshotActions';
import { useStageCaptureRegistration } from '@/features/stage/ui/useStageCaptureRegistration';
import { useProjectStore } from '@/stores/projectStore';
import { ScopedAgentPanel } from '@/features/agents/ui/ScopedAgentPanel';
import { StageHeader } from '@/features/stage/ui/StageHeader';
import { StageFlyout, StageToolRail, type StageRailTool } from '@/features/stage/ui/StageToolRail';
import { AddFlyoutBody, CameraMotionFlyoutBody, LensFlyoutBody, LightingFlyoutBody } from '@/features/stage/ui/StageFlyouts';
import { StageOutliner, type StageInspectorTarget } from '@/features/stage/ui/StageOutliner';
import { StageSceneInspector } from '@/features/stage/ui/StageSceneInspector';
import { StageSnapshotsPanel } from '@/features/stage/ui/StageSnapshotsPanel';
import { useStageEditorSelection } from '@/features/stage/ui/useStageEditorSelection';
import { StageSelectionBar } from '@/features/stage/ui/StageSelectionBar';
import { StageCapturePanel } from '@/features/stage/ui/StageCapturePanel';
import { assertStageEditUnlocked } from '@/features/stage/application/stageEditProtection';
import type { StageSelectionOperation } from '@/features/stage/application/stageSelection';
import { StageSceneBuilder } from '@/features/stage/ui/StageSceneBuilder';
import {
  StageCaptureToast,
  StageGuideBar,
  StageStatusPill,
  StageViewBar,
  readStageGuideDismissed,
  writeStageGuideDismissed,
} from '@/features/stage/ui/StageViewportChrome';
import { StageProjectsMenu } from '@/features/stage/ui/StageProjectsMenu';
import { StageDialog, StageImageTile } from '@/features/stage/ui/StageDialog';
import { ScrubNumber, StageEmpty } from '@/features/stage/ui/stageKit';
import { UiButton, UiConfirm, UiIconButton, UiInput, UiSegmented } from '@/components/ui';

const loadBlueprintScene = () =>
  import('@/features/canvas/ui/BlueprintScene').then((m) => ({ default: m.BlueprintScene }));

type RailPanel = 'add' | 'camera' | 'lighting' | 'sceneBuilder';
type DockTab = 'scene' | 'shots';
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
  selectTool: 'V',
  orbitTool: 'B',
  transformMove: 'G',
  transformRotate: 'R',
  transformScale: 'T',
  focus: 'F',
  fit: 'Z',
  reset: 'Shift+R',
  screenshot: 'C',
  model: 'M',
  lighting: 'L',
  grid: 'Shift+G',
  prompt: 'P',
  shortcuts: 'H',
  save: 'Cmd/Ctrl+S',
  delete: 'Delete',
  copy: 'Cmd/Ctrl+C',
  paste: 'Cmd/Ctrl+V',
  undo: 'Cmd/Ctrl+Z',
  redo: 'Cmd/Ctrl+Shift+Z',
  advancedPedestrianTags: 'Shift+T',
  poseEdit: 'O',
};

/**
 * Bindings that earlier versions saved as defaults. They collided (G = move and grid,
 * R = rotate and reset, T = scale and tags), so a stored legacy default means "use the
 * current default"; only deliberate custom bindings survive.
 */
const LEGACY_DEFAULT_SHORTCUTS: Partial<Record<DirectorStudioShortcutId, string>> = {
  transformMove: '1',
  transformRotate: '2',
  transformScale: '3',
  reset: 'R',
  grid: 'G',
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
      { shortcutId: 'selectTool', labelKey: 'ui.stage.selectTool' },
      { shortcutId: 'orbitTool', labelKey: 'ui.stage.orbitTool' },
      { defaultKeys: 'Alt + Mouse Left', labelKey: 'directorStudio.shortcuts.rows.viewOrbit' },
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
      { shortcutId: 'poseEdit', labelKey: 'directorStudio.shortcuts.rows.poseEdit' },
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
  presetId?: string;
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
  /** Workspace to enter on open (canvas "新建预演台" opens straight into previs). */
  initialWorkspace?: 'director' | 'previs';
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
  const result = { ...DEFAULT_DIRECTOR_STUDIO_SHORTCUTS };
  (Object.entries(shortcuts ?? {}) as Array<[DirectorStudioShortcutId, string | undefined]>).forEach(([id, binding]) => {
    if (binding && binding !== LEGACY_DEFAULT_SHORTCUTS[id]) result[id] = binding;
  });
  return result;
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

export const DirectorStudioShell = memo(function DirectorStudioShell(props: DirectorStudioShellProps) {
  const {
    initialWorkspace = 'director',
    sourceNodeId,
    data,
    referenceImages,
    panoramaAssets = [],
    imageAssets = [],
    selectedItemId,
    onSelectedItemChange,
    onItemsChange: commitItems,
    onUpdateNodeData: commitNodeData,
    onAddSnapshotToCanvas,
    onAddVideoToCanvas,
    getLastRecordedVideoNodeId,
    recordRequest,
    onRecordRequestResult,
    onClose,
  } = props;
  const { t } = useTranslation();
  const [editError, setEditError] = useState<string | null>(null);
  const editDataRef = useRef(data); editDataRef.current = data;
  const onUpdateNodeData = useCallback((patch: Partial<BlueprintNodeData>) => {
    try {
      if (!Object.hasOwn(patch, 'activeDirectorStudioProjectId')) assertStageEditUnlocked(editDataRef.current, patch);
      setEditError(null); commitNodeData(patch);
    } catch (error) { setEditError(t('ui.stage.selection.lockedHint', { name: error instanceof Error ? error.message : '' })); }
  }, [commitNodeData, t]);
  const onItemsChange = useCallback((items: BlueprintItem[]) => {
    try { assertStageEditUnlocked(editDataRef.current, { items }); setEditError(null); commitItems(items); }
    catch (error) { setEditError(t('ui.stage.selection.lockedHint', { name: error instanceof Error ? error.message : '' })); }
  }, [commitItems, t]);
  const stageSelection = useStageEditorSelection(sourceNodeId, data.items, selectedItemId, onSelectedItemChange);
  const applySelection = useCallback((operation: StageSelectionOperation, targets?: string[]) => {
    try { stageSelection.apply(operation, targets); setEditError(null); }
    catch (error) { setEditError(error instanceof Error ? error.message : t('common.error')); }
  }, [stageSelection.apply, t]);
  const { rootRef: tooltipsRootRef, tooltipRef } = useDirectorTooltips();
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
  const [studioMode, setStudioMode] = useState<'director' | 'previs'>('director');
  const projectId = useProjectStore((state) => state.currentProjectId);
  const [agentOpen, setAgentOpen] = useState(false);
  const stageAgentPanelRef = useRef<HTMLElement>(null);
  const stageAgentSize = useSettingsStore((state) => state.workspacePreferences.panelSizes.stageAgent);
  const [dockOpen, setDockOpen] = useState(true);
  const [dockTab, setDockTab] = useState<DockTab>('scene');
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [inspectorTarget, setInspectorTarget] = useState<StageInspectorTarget>('scene');
  const [cameraSubjectId, setCameraSubjectId] = useState<string | null>(null);
  const [timelineHeightOverride, setTimelineHeightOverride] = useState<number | null>(null);
  const timelineOpen = studioMode === 'previs';
  const [railPanel, setRailPanel] = useState<RailPanel | null>(null);
  const [sceneAssetError, setSceneAssetError] = useState('');
  const [activeDialog, setActiveDialog] = useState<DirectorStudioDialog>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<{
    title: string;
    tone: 'danger' | 'primary';
    resolve: (confirmed: boolean) => void;
  } | null>(null);
  const requestConfirmation = useCallback((title: string, tone: 'danger' | 'primary' = 'primary') => (
    new Promise<boolean>((resolve) => setPendingConfirmation({ title, tone, resolve }))
  ), []);
  const [activeModelCategory, setActiveModelCategory] = useState<DirectorStudioModelCategoryId>('basic');
  const [pedestrianMode, setPedestrianMode] = useState<PedestrianMode>('direct');
  const [myModels, setMyModels] = useState<ImportedModelAsset[]>([]);
  const [modelImportState, setModelImportState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const modelFileInputRef = useRef<HTMLInputElement | null>(null);
  const [pedestrianCount, setPedestrianCount] = useState(8);
  const [pedestrianColumns, setPedestrianColumns] = useState(4);
  const [pedestrianXSpacing, setPedestrianXSpacing] = useState(1.2);
  const [pedestrianZSpacing, setPedestrianZSpacing] = useState(1.2);
  const [pedestrianRadius, setPedestrianRadius] = useState(4);
  const [importOpen, setImportOpen] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [lightboxSnapshotUrl, setLightboxSnapshotUrl] = useState<string | null>(null);
  const [isUploadingPanorama, setIsUploadingPanorama] = useState(false);
  const [isUploadingElementImage, setIsUploadingElementImage] = useState(false);
  const [panoramaImportStage, setPanoramaImportStage] = useState<DirectorStudioPanoramaImportStage | null>(null);
  const [sceneSize, setSceneSize] = useState(() => ({
    width: typeof window === 'undefined' ? 1100 : Math.max(320, window.innerWidth - 304),
    height: typeof window === 'undefined' ? 760 : Math.max(240, window.innerHeight - 52),
  }));
  const [assetPickerItemId, setAssetPickerItemId] = useState<string | null>(null);
  const [assetQuery, setAssetQuery] = useState('');
  const [followSelectedItem, setFollowSelectedItem] = useState(false);
  const [shotPipVisible, setShotPipVisible] = useState(true);
  /** Points placed in the active route draft (status pill: "已 N 点 · 回车结束"). */
  const [routeDraftPointCount, setRouteDraftPointCount] = useState(0);
  // First-visit guide; dismissal is a per-device UI preference, not project data.
  const [guideDismissed, setGuideDismissed] = useState(readStageGuideDismissed);
  const dismissGuide = useCallback(() => {
    setGuideDismissed(true);
    writeStageGuideDismissed();
  }, []);
  const [activeTransformMode, setActiveTransformMode] = useState<DirectorStudioTransformMode | null>(null);
  const [orbitTool, setOrbitTool] = useState(false);
  const [editingShortcutId, setEditingShortcutId] = useState<DirectorStudioShortcutId | null>(null);
  const [poseEditActive, setPoseEditActive] = useState(false);
  const [poseJoint, setPoseJoint] = useState<PersonPoseJoint | null>(null);
  /** Pose read back from the viewport for the inspector (it includes sampled motion). */
  const [poseSnapshot, setPoseSnapshot] = useState<BlueprintActionPose | null>(null);
  const [viewportSize, setViewportSize] = useState(() => ({
    width: typeof window === 'undefined' ? 1440 : window.innerWidth,
    height: typeof window === 'undefined' ? 900 : window.innerHeight,
  }));
  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return undefined;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const next = { width: Math.max(320, Math.round(rect.width)), height: Math.max(240, Math.round(rect.height)) };
      setSceneSize((current) => current.width === next.width && current.height === next.height ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
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
    if (latestItemsRef.current.find((item) => item.id === itemId)?.locked && !(Object.keys(patch).length === 1 && patch.locked === false)) return;
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
    previewProject: motionPreviewProject,
    motionTimeSource,
    playbackSource,
    playbackRate,
    setPlaybackRate,
    setMotionPlaying,
    motionSelection,
    setMotionSelection,
    motionShowRoutes,
    setMotionShowRoutes,
    motionPreviewMode,
    motionRouteDraft,
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
    splitAtTime,
    copyMotionTrack,
    editCameraRigSegment,
    retimeCameraRig,
    patchMotionKeyframe,
    patchMotionKeyframes,
    copyMotionKeyframe,
    deleteMotionKeyframes,
    moveMotionKeyframe,
    retimeMotionTrack,
    toggleMotionRouteClosed,
    setCameraLookAt,
    duplicateMotionKeyframe,
    deleteMotionKeyframe,
    addCameraMotionKeyframe,
    recordPilotCamera,
    addObjectMotionKeyframe,
    addActionMotionKeyframe,
    recordPersonPose,
    clearPersonPoseAt,
    updateMotionDuration,
    applyMotionActionState,
    saveMotionClip,
    updateMotionClip,
    duplicateMotionClip,
    deleteMotionClip,
    applyCameraPreset,
    addCameraRig,
    previewCameraRig,
    updateCameraRig,
    deleteCameraRig,
    bakeCameraRig,
    startMotionRouteDraft,
    finishMotionRouteDraft,
    cancelMotionRouteDraft,
    completeMotionRouteDraft,
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
    previewEnabled: timelineOpen,
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
    if (!currentItem || currentItem.locked) {
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

  const selectItemForEditing = useCallback((itemId: string | null) => {
    setOrbitTool(false);
    commitPendingTextDrafts();
    setMotionSelection(null);
    if (timelineOpen) cancelMotionRouteDraft();
    stageSelection.select(itemId ? [itemId] : [], 'outliner');
    setFollowSelectedItem(false);
    if (!itemId) {
      setActiveTransformMode(null);
      return;
    }
    setActiveTransformMode('move');
    setDockTab('scene');
  }, [cancelMotionRouteDraft, commitPendingTextDrafts, stageSelection.select, setMotionSelection, timelineOpen]);

  /** Nothing selected: the dock shows the world (scene) or, in Previs, the shot camera. */
  const selectInspectorTarget = useCallback((target: StageInspectorTarget) => {
    selectItemForEditing(null);
    setInspectorTarget(target);
    setDockTab('scene');
  }, [selectItemForEditing]);

  const handleClose = useCallback(() => {
    commitPendingTextDrafts();
    stopMotionActivity();
    onCloseRef.current();
  }, [commitPendingTextDrafts, stopMotionActivity]);

  const showCameraInspector = timelineOpen && !selectedItem && (inspectorTarget === 'camera' || motionSelection?.kind === 'camera');

  useEffect(() => {
    if ((!selectedItem && !(showCameraInspector && activeTransformMode === 'rotate') || selectedItem?.locked || selectedItem?.hidden) && activeTransformMode) {
      setActiveTransformMode(null);
    }
  }, [activeTransformMode, selectedItem, showCameraInspector]);

  // Pose mode and transform gizmos are exclusive; pose mode needs a selected person.
  useEffect(() => {
    if (activeTransformMode) setPoseEditActive(false);
  }, [activeTransformMode]);
  useEffect(() => {
    if (selectedItem?.category !== 'person' || selectedItem.locked || selectedItem.hidden) setPoseEditActive(false);
    setPoseJoint(null);
  }, [selectedItem?.id, selectedItem?.category, selectedItem?.locked, selectedItem?.hidden]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (pendingConfirmation) return;
      if (isEditableEventTarget(event.target)) return;
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // Open popovers (frame menu, projects) close themselves; Esc must not also peel a layer.
      if (document.querySelector('.director-studio-shell [data-stage-popover]')) return;
      const claim = () => event.preventDefault();
      if (motionRouteDraft) return claim(), cancelMotionRouteDraft();
      if (pilotActive || actionLibraryOpen || videoExportOpen) return;
      // Topmost surface first; Esc never leaves the stage (that is the back button's job).
      if (activeDialog) return claim(), setActiveDialog(null);
      if (importOpen) return claim(), setImportOpen(false);
      if (assetPickerItemId) return claim(), setAssetPickerItemId(null);
      if (lightboxSnapshotUrl) return claim(), setLightboxSnapshotUrl(null);
      if (railPanel) return claim(), setRailPanel(null);
      if (poseEditActive) return claim(), setPoseEditActive(false);
      if (orbitTool) return claim(), setOrbitTool(false);
      if (selectedItemId) return claim(), selectItemForEditing(null);
      if (activeTransformMode) return claim(), setActiveTransformMode(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [actionLibraryOpen, activeDialog, activeTransformMode, assetPickerItemId, cancelMotionRouteDraft, importOpen, lightboxSnapshotUrl, motionRouteDraft, orbitTool, pendingConfirmation, pilotActive, poseEditActive, railPanel, selectItemForEditing, selectedItemId, videoExportOpen]);

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

  const computeScreenshotExportOptions = useCallback(() => screenshotExportOptions(
    selectedAspect.ratio, (SCREENSHOT_RESOLUTIONS.find((item) => item.value === screenshotResolution) ?? SCREENSHOT_RESOLUTIONS[0]).base, sceneSize,
  ), [sceneSize, screenshotResolution, selectedAspect.ratio]);
  const { captureScreenshot, capturePersistedSceneSnapshot, selectSnapshot, deleteSnapshot, clearCurrentSnapshot, clearAllSnapshots,
    addSnapshotToCanvas, addAllSnapshotsToCanvas, isAddingSnapshotToCanvas, captureToast, setCaptureToast, captureFlashKey } = useStageSnapshotActions({
    nodeId: sourceNodeId, data, editorRef, exportOptions: computeScreenshotExportOptions, commitPendingTextDrafts,
    onUpdateNodeData, onAddSnapshotToCanvas, onClose: handleClose,
  });

  const saveProject = useCallback(async () => {
    const hadDraftWrites = commitPendingTextDrafts();
    if (hadDraftWrites) {
      await waitForNextStageFrame();
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
    t,
  ]);

  const restoreProject = useCallback(async (project: DirectorStudioProjectRecord) => {
    if (project.id === data.activeDirectorStudioProjectId) return;
    if (hasUnsavedChanges && await requestConfirmation(t('directorStudio.confirmSaveBeforeSwitch'))) {
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
    requestConfirmation,
    saveProject,
    selectItemForEditing,
    t,
  ]);

  const deleteProject = useCallback(async (project: DirectorStudioProjectRecord) => {
    if (!await requestConfirmation(t('directorStudio.confirmDeleteProject', { name: project.name }), 'danger')) return;
    const nextProjects = (data.directorStudioProjects ?? []).filter((item) => item.id !== project.id);
    onUpdateNodeData({
      directorStudioProjects: nextProjects,
      activeDirectorStudioProjectId:
        data.activeDirectorStudioProjectId === project.id ? null : data.activeDirectorStudioProjectId ?? null,
    });
  }, [data.activeDirectorStudioProjectId, data.directorStudioProjects, onUpdateNodeData, requestConfirmation, t]);

  const updateProjectCover = useCallback(async (project: DirectorStudioProjectRecord) => {
    try {
      const coverUrl = await capturePersistedSceneSnapshot(
        data.snapshotUrl ?? normalizeDirectorSnapshot(project.snapshot).snapshotUrl ?? null
      );
      if (!coverUrl) {
        void requestConfirmation(t('directorStudio.noSnapshotForCover'));
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
  }, [capturePersistedSceneSnapshot, data.directorStudioProjects, data.snapshotUrl, onUpdateNodeData, requestConfirmation, t]);

  const renameProject = useCallback((projectIdToRename: string, name: string) => {
    const nextName = name.trim() || t('directorStudio.untitledProject');
    onUpdateNodeData({
      directorStudioProjects: (data.directorStudioProjects ?? []).map((project) =>
        project.id === projectIdToRename
          ? { ...project, name: nextName, updatedAt: Date.now() }
          : project
      ),
    });
  }, [data.directorStudioProjects, onUpdateNodeData, t]);

  const createBlankWorkspace = useCallback(async () => {
    let nextProjects = data.directorStudioProjects ?? [];
    if (hasUnsavedChanges) {
      if (!await requestConfirmation(t('directorStudio.confirmSaveBeforeNew'))) return;
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
  }, [data.directorStudioProjects, hasUnsavedChanges, onUpdateNodeData, requestConfirmation, saveProject, selectItemForEditing, t]);

  const deleteSelectedItem = useCallback(() => {
    if (!selectedItem) return;
    setActiveTransformMode(null);
    applySelection({ type: 'remove' });
  }, [applySelection, selectedItem]);

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

  const poseEditItemId = poseEditActive && selectedItem?.category === 'person' ? selectedItem.id : null;

  const togglePoseEdit = useCallback(() => {
    setOrbitTool(false);
    if (selectedItem?.category !== 'person') return;
    commitInspectorTextDraft();
    setActiveTransformMode(null);
    // Pose edits happen in the inspector side panel (director) or the previs sidebar.
    if (!poseEditActive) {
      setDockOpen(true);
      setDockTab('scene');
      setRailPanel(null);
    }
    setPoseEditActive(!poseEditActive);
  }, [commitInspectorTextDraft, poseEditActive, selectedItem?.category, timelineOpen]);

  // The inspector shows what the viewport shows: read the applied pose after the scene has re-posed.
  const refreshPoseSnapshot = useCallback(() => {
    if (!poseEditItemId) {
      setPoseSnapshot(null);
      return;
    }
    if (playbackSource.getSnapshot()) return;
    requestAnimationFrame(() => setPoseSnapshot(editorRef.current?.getPersonPose(poseEditItemId) ?? null));
  }, [playbackSource, poseEditItemId]);
  useEffect(() => { refreshPoseSnapshot(); }, [data.items, motionProject, refreshPoseSnapshot, timelineOpen]);
  useEffect(() => {
    if (!poseEditItemId) return undefined;
    const unsubscribe = motionTimeSource.subscribe(refreshPoseSnapshot);
    return () => { unsubscribe(); };
  }, [motionTimeSource, poseEditItemId, refreshPoseSnapshot]);

  /** Director: the person's own pose layer. Previs: the action keyframe under the playhead. */
  const commitPoseEdit = useCallback((itemId: string, edit: PersonPoseEdit) => {
    if (timelineOpen) {
      recordPersonPose(itemId, edit);
      return;
    }
    const item = latestItemsRef.current.find((candidate) => candidate.id === itemId);
    if (item) updateItem(itemId, { pose: applyPersonPosePatch(normalizePersonPose(item.pose), edit.patch) });
  }, [recordPersonPose, timelineOpen, updateItem]);

  const resetPoseEdits = useCallback(() => {
    if (!poseEditItemId) return;
    if (timelineOpen) clearPersonPoseAt(poseEditItemId);
    else updateItem(poseEditItemId, { pose: undefined });
  }, [clearPersonPoseAt, poseEditItemId, timelineOpen, updateItem]);

  const saveCustomPose = useCallback((name: string, pose: BlueprintActionPose) => {
    if (selectedItem?.category !== 'person') return;
    onUpdateNodeData({
      customActionPresets: getUniqueActionPresets([...(data.customActionPresets ?? []), name]),
      customActionPoses: { ...(data.customActionPoses ?? {}), [name]: pose },
    });
    // Director: the saved pose becomes the person's action. Previs keeps its keyframes untouched.
    if (!timelineOpen) updateItemActionImmediately(selectedItem, name);
  }, [data.customActionPoses, data.customActionPresets, onUpdateNodeData, selectedItem, timelineOpen, updateItemActionImmediately]);

  const poseInspector = poseEditItemId && poseSnapshot ? (
    <PersonPoseInspector
      pose={poseSnapshot}
      joint={poseJoint}
      onJointChange={setPoseJoint}
      onPreview={(pose) => editorRef.current?.previewPersonPose(poseEditItemId, pose)}
      onCommit={(edit) => commitPoseEdit(poseEditItemId, edit)}
      onResetAll={resetPoseEdits}
      onSaveCustomPose={saveCustomPose}
      onExit={() => setPoseEditActive(false)}
      targetLabel={timelineOpen
        ? t('directorStudio.pose.targetKeyframe', { time: motionTimeSource.getSnapshot().toFixed(2) })
        : t('directorStudio.pose.targetItem')}
      defaultPoseName={t('directorStudio.inspector.customActionDefaultName')}
    />
  ) : null;

  const deleteCustomActionPreset = useCallback(async (preset: string) => {
    if (!await requestConfirmation(t('directorStudio.inspector.confirmDeleteActionPreset', { name: preset }), 'danger')) return;
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
  }, [data.customActionPoses, data.customActionPresets, onUpdateNodeData, requestConfirmation, t]);

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
  }, [data.items, onItemsChange, selectItemForEditing]);

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

  useEffect(() => {
    if (activeDialog !== 'modelLibrary') return;
    let cancelled = false;
    void listImportedModels()
      .then((models) => { if (!cancelled) setMyModels(models); })
      .catch((error: unknown) => { if (!cancelled) setModelImportState({ busy: false, error: error instanceof Error ? error.message : String(error) }); });
    return () => { cancelled = true; };
  }, [activeDialog]);

  const importMyModel = useCallback(async (file: File) => {
    setModelImportState({ busy: true, error: null });
    try {
      const asset = await importModelFile(file);
      setMyModels((current) => [asset, ...current.filter((model) => model.id !== asset.id)]);
      setActiveModelCategory('mine');
      setModelImportState({ busy: false, error: null });
    } catch (error) {
      setModelImportState({ busy: false, error: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  const insertMyModel = useCallback((asset: ImportedModelAsset) => {
    const item = createBlueprintItemFromPreset({
      label: `${asset.name}${getNextLabelIndex(data.items, asset.name, [])}`,
      color: '#94a3b8',
      category: 'object',
      pos3d: getSuggestedInsertPosition(),
      defaultPersonAction,
    });
    appendAndSelectItems([{ ...item, importedModelId: asset.id }]);
    setActiveDialog(null);
  }, [appendAndSelectItems, data.items, defaultPersonAction, getSuggestedInsertPosition]);

  const deleteMyModel = useCallback(async (asset: ImportedModelAsset) => {
    if (!await requestConfirmation(t('directorStudio.modelLibrary.confirmDeleteMine', { name: asset.name }), 'danger')) return;
    await deleteImportedModel(asset.id);
    setMyModels((current) => current.filter((model) => model.id !== asset.id));
  }, [requestConfirmation, t]);

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

  const dockWidth = viewportSize.width < 1100 ? 280 : 304;
  const maxMotionTimelineHeight = Math.max(180, viewportSize.height - 52 - 260);
  const defaultMotionTimelineHeight = Math.min(maxMotionTimelineHeight, viewportSize.height < 760 ? 210 : 248);
  const motionTimelineHeight = Math.max(180, Math.min(maxMotionTimelineHeight, timelineHeightOverride ?? defaultMotionTimelineHeight));
  const rawPanoramaUrl = data.backgroundPanoramaUrl ?? data.backgroundImageUrl ?? null;
  const panoramaUrl = rawPanoramaUrl ? resolveImageDisplayUrl(rawPanoramaUrl) ?? rawPanoramaUrl : null;
  const panoramaImportStageLabel = panoramaImportStage
    ? t(`directorStudio.importStages.${panoramaImportStage}`)
    : null;
  const safeFrameStyle = useMemo(() => {
    const ratio = selectedAspect.ratio;
    if (!ratio) return null;
    const sceneRatio = sceneSize.width / sceneSize.height;
    const width = sceneRatio > ratio ? sceneSize.height * ratio : sceneSize.width;
    const height = sceneRatio > ratio ? sceneSize.height : sceneSize.width / ratio;
    return {
      width,
      height,
      left: (sceneSize.width - width) / 2,
      top: (sceneSize.height - height) / 2,
    };
  }, [sceneSize.height, sceneSize.width, selectedAspect.ratio]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (pendingConfirmation) return;
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
        // Inside the timeline, Delete acts on its (multi-)selection; the timeline handles it.
        if (event.target instanceof Element && event.target.closest('[data-stage-timeline]')) return;
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
      if (shortcutMatchesEvent(event, shortcuts.orbitTool)) {
        if (motionRouteDraft) cancelMotionRouteDraft();
        setActiveTransformMode(null);
        setPoseEditActive(false);
        setRailPanel(null);
        setOrbitTool(value => !value);
        claimShortcut();
        return;
      }
      // Selection and orbit use the same editable bindings as the rail/help.
      if (shortcutMatchesEvent(event, shortcuts.selectTool)) {
        if (motionRouteDraft) cancelMotionRouteDraft();
        setOrbitTool(false);
        setActiveTransformMode(null);
        setPoseEditActive(false);
        claimShortcut();
        return;
      }
      if (shortcutMatchesEvent(event, shortcuts.transformMove) || shortcutMatchesEvent(event, '1')) {
        if (!selectedItem) return;
        setOrbitTool(false);
        setActiveTransformMode('move');
        claimShortcut();
        return;
      }
      if (shortcutMatchesEvent(event, shortcuts.transformRotate) || shortcutMatchesEvent(event, '2')) {
        if (!selectedItem && !showCameraInspector) return;
        setOrbitTool(false);
        if (showCameraInspector) setPreviewModeAndApply('route');
        setActiveTransformMode('rotate');
        claimShortcut();
        return;
      }
      if (shortcutMatchesEvent(event, shortcuts.transformScale) || shortcutMatchesEvent(event, '3')) {
        if (!selectedItem) return;
        setOrbitTool(false);
        setActiveTransformMode('scale');
        claimShortcut();
        return;
      }
      if (shortcutMatchesEvent(event, shortcuts.poseEdit)) {
        if (selectedItem?.category !== 'person') return;
        setOrbitTool(false);
        togglePoseEdit();
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
        setRailPanel((value) => value === 'lighting' ? null : 'lighting');
        claimShortcut();
        return;
      }
      if (shortcutMatchesEvent(event, shortcuts.grid)) {
        updateGrid({ visible: !grid.visible });
        claimShortcut();
        return;
      }
      if (shortcutMatchesEvent(event, shortcuts.prompt)) {
        selectInspectorTarget('scene');
        setDockOpen(true);
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
    cancelMotionRouteDraft,
    captureScreenshot,
    copySelectedItem,
    togglePoseEdit,
    data.directorStudioShortcuts,
    deleteMotionKeyframe,
    deleteSelectedItem,
    editingShortcutId,
    grid.visible,
    showCameraInspector,
    setPreviewModeAndApply,
    motionRouteDraft,
    onUpdateNodeData,
    pasteCopiedItem,
    pendingConfirmation,
    pilotActive,
    motionSelection,
    redoCanvas,
    saveProject,
    selectInspectorTarget,
    selectedItem,
    shortcuts,
    undoCanvas,
    updateGrid,
    updateViewSettings,
    videoExportOpen,
    videoExportRecording,
    viewSettings.showAdvancedPedestrianTags,
  ]);

  const switchStudioMode = (nextMode: 'director' | 'previs') => {
    if (nextMode === studioMode) return;
    if (nextMode === 'director') {
      stopMotionActivity();
      setPilotActive(false);
      setActionLibraryOpen(false);
      setVideoExportOpen(false);
      setMotionSelection(null);
    } else {
      setMotionShowRoutes(true);
      setActiveTransformMode(null);
      if (!selectedItem) setInspectorTarget('camera');
    }
    if (nextMode === 'director') setInspectorTarget('scene');
    setRailPanel(null);
    setPreviewModeAndApply('route');
    setStudioMode(nextMode);
  };
  const workspaceTransitionRef = useRef(switchStudioMode);
  workspaceTransitionRef.current = switchStudioMode;
  // Enter the requested workspace once on open, through the same transition as the mode switch.
  useEffect(() => {
    if (initialWorkspace === 'previs') workspaceTransitionRef.current('previs');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open-time only
  }, []);
  useStageCaptureRegistration({ nodeId: sourceNodeId, projectId, data, editorRef, motionProject, motionPreviewProject,
    timelineOpen, camera, lighting, panoramaUrl, exportOptions: computeScreenshotExportOptions, timeSource: motionTimeSource,
    setWorkspace: switchStudioMode });

  const toggleRailPanel = (panel: RailPanel) => setRailPanel((value) => value === panel ? null : panel);
  const cancelTools = () => {
    setOrbitTool(false);
    if (motionRouteDraft) cancelMotionRouteDraft();
    setActiveTransformMode(null);
    setPoseEditActive(false);
  };
  const chooseTransform = (mode: DirectorStudioTransformMode) => {
    if (!selectedItem && !(showCameraInspector && mode === 'rotate')) return;
    setOrbitTool(false);
    if (showCameraInspector && mode === 'rotate') setPreviewModeAndApply('route');
    if (motionRouteDraft) cancelMotionRouteDraft();
    setActiveTransformMode((value) => value === mode ? null : mode);
  };
  // Routes belong to people or, with nothing selected, to the shot camera.
  const routePerson = selectedItem?.category === 'person' ? selectedItem : null;
  const routeAllowed = !selectedItem || Boolean(routePerson);
  const routeTargetLabel = routePerson?.label ?? t('directorStudio.motion.timeline.camera');
  const startRoute = (method: 'draw' | 'points' | 'line') => {
    setOrbitTool(false);
    setActiveTransformMode(null);
    setPoseEditActive(false);
    setRailPanel(null);
    startMotionRouteDraft({ kind: routePerson ? 'object' : 'camera', trackId: routePerson?.id ?? 'camera', method });
  };
  const openCameraPanel = () => {
    if (railPanel === 'camera') {
      setRailPanel(null);
      return;
    }
    if (timelineOpen) {
      // Templates aim at the person that was selected when the panel opened.
      setCameraSubjectId(selectedItem?.category === 'person' ? selectedItem.id : null);
      selectInspectorTarget('camera');
    }
    setRailPanel('camera');
  };
  const cameraSubject = cameraSubjectId ? data.items.find((item) => item.id === cameraSubjectId) ?? null : null;
  const cameraSubjectHasRoute = Boolean(cameraSubject && (motionProject.objectTracks[cameraSubject.id]?.length ?? 0) >= 2);
  const selectFirstReason = t('directorStudio.previs.selectFirst');

  const railGroups: StageRailTool[][] = [
    [
      { key: 'select', label: t('directorStudio.previs.select'), description: t('directorStudio.previs.selectHelp'), keys: shortcuts.selectTool, icon: MousePointer2, active: !orbitTool && !activeTransformMode && !motionRouteDraft && !poseEditActive, onClick: cancelTools },
      { key: 'orbit', label: t('ui.stage.orbitTool'), description: t('ui.stage.orbitToolHint'), keys: shortcuts.orbitTool, icon: Hand, active: orbitTool, onClick: () => { cancelTools(); setRailPanel(null); setOrbitTool(!orbitTool); } },
      { key: 'move', label: t('directorStudio.previs.move'), description: t('directorStudio.previs.moveHelp'), keys: shortcuts.transformMove, icon: Move3d, active: activeTransformMode === 'move', disabled: !selectedItem, disabledReason: selectFirstReason, onClick: () => chooseTransform('move') },
      { key: 'rotate', label: t('directorStudio.previs.rotate'), description: t('directorStudio.previs.rotateHelp'), keys: shortcuts.transformRotate, icon: Rotate3d, active: activeTransformMode === 'rotate', disabled: !selectedItem && !showCameraInspector, disabledReason: selectFirstReason, onClick: () => chooseTransform('rotate') },
      { key: 'scale', label: t('directorStudio.previs.scale'), description: t('directorStudio.previs.scaleHelp'), keys: shortcuts.transformScale, icon: Scaling, active: activeTransformMode === 'scale', disabled: !selectedItem, disabledReason: selectFirstReason, onClick: () => chooseTransform('scale') },
    ],
    [
      { key: 'pose', label: t('directorStudio.pose.enter'), description: t('directorStudio.pose.viewportHint'), keys: shortcuts.poseEdit, icon: PersonStanding, active: poseEditActive, disabled: selectedItem?.category !== 'person', disabledReason: t('directorStudio.motion.library.selectPerson'), onClick: togglePoseEdit },
      ...(timelineOpen ? [
        { key: 'draw', label: t('directorStudio.previs.draw'), description: t('directorStudio.previs.drawHelp', { name: routeTargetLabel }), icon: PenLine, active: motionRouteDraft?.method === 'draw', disabled: !routeAllowed, disabledReason: t('directorStudio.previs.routePersonOnly'), onClick: () => startRoute('draw') },
        { key: 'points', label: t('directorStudio.previs.points'), description: t('directorStudio.previs.pointsHelp', { name: routeTargetLabel }), icon: Route, active: motionRouteDraft?.method === 'points', disabled: !routeAllowed, disabledReason: t('directorStudio.previs.routePersonOnly'), onClick: () => startRoute('points') },
        { key: 'line', label: t('directorStudio.previs.line'), description: t('directorStudio.previs.lineHelp', { name: routeTargetLabel }), icon: Ruler, active: motionRouteDraft?.method === 'line', disabled: !routeAllowed, disabledReason: t('directorStudio.previs.routePersonOnly'), onClick: () => startRoute('line') },
      ] : []),
    ],
    [
      { key: 'add', label: t('directorStudio.rail.add'), description: t('directorStudio.rail.addHelp'), icon: Plus, menu: true, open: railPanel === 'add', onClick: () => toggleRailPanel('add') },
      { key: 'sceneBuilder', label: t('rework.stage.sceneBuilder.title'), description: t('rework.stage.sceneBuilder.help'), icon: ImagePlus, menu: true, open: railPanel === 'sceneBuilder', onClick: () => toggleRailPanel('sceneBuilder') },
      {
        key: 'camera',
        label: t(timelineOpen ? 'directorStudio.previs.camera' : 'directorStudio.rail.lens'),
        description: t(timelineOpen ? 'directorStudio.previs.cameraHelp' : 'directorStudio.rail.lensHelp'),
        icon: Camera,
        menu: true,
        open: railPanel === 'camera',
        onClick: openCameraPanel,
      },
      ...(timelineOpen ? [{
        key: 'actions',
        label: t('directorStudio.previs.actions'),
        description: t('directorStudio.previs.actionsHelp'),
        icon: Film,
        active: actionLibraryOpen,
        disabled: selectedItem?.category !== 'person',
        disabledReason: t('directorStudio.motion.library.selectPerson'),
        onClick: () => setActionLibraryOpen(true),
      }] : []),
      { key: 'lighting', label: t('directorStudio.toolbar.lighting'), description: t('directorStudio.previs.lightingHelp'), keys: shortcuts.lighting, icon: Lightbulb, menu: true, open: railPanel === 'lighting', onClick: () => toggleRailPanel('lighting') },
    ],
  ];
  const railFooter: StageRailTool[] = [
    { key: 'help', label: t('directorStudio.rail.help'), description: t('directorStudio.rail.helpHint'), keys: shortcuts.shortcuts, icon: Keyboard, active: activeDialog === 'shortcuts', onClick: () => setActiveDialog('shortcuts') },
  ];
  const closeRailPanel = () => setRailPanel(null);
  const railPanelNode = railPanel === 'add' ? (
    <StageFlyout title={t('directorStudio.rail.add')} closeLabel={t('common.close')} onClose={closeRailPanel}>
      <AddFlyoutBody entries={[
        { key: 'person', icon: UserPlus, label: t('directorStudio.rail.addPerson'), hint: t('directorStudio.previs.addPersonHelp'), onClick: () => { closeRailPanel(); addPedestrians('direct'); } },
        { key: 'crowd', icon: Users, label: t('directorStudio.toolbar.addPedestrian'), hint: t('directorStudio.rail.addCrowdHelp'), onClick: () => { closeRailPanel(); setActiveDialog('pedestrians'); } },
        { key: 'models', icon: Box, label: t('directorStudio.previs.models'), hint: t('directorStudio.previs.openModelsHelp'), keys: shortcuts.model, onClick: () => { closeRailPanel(); setActiveDialog('modelLibrary'); } },
        { key: 'mine', icon: Upload, label: t('directorStudio.rail.myModels'), hint: t('directorStudio.modelLibrary.uploadHint'), onClick: () => { closeRailPanel(); setActiveModelCategory('mine'); setActiveDialog('modelLibrary'); } },
      ]} />
    </StageFlyout>
  ) : railPanel === 'camera' ? (
    <StageFlyout title={t(timelineOpen ? 'directorStudio.previs.camera' : 'directorStudio.rail.lens')} closeLabel={t('common.close')} onClose={closeRailPanel}>
      {timelineOpen ? (
        <CameraMotionFlyoutBody
          presets={DIRECTOR_CAMERA_PRESETS.map((preset) => ({
            id: preset.id,
            label: t(preset.labelKey),
            disabled: preset.id === 'follow-actor-route' && !cameraSubjectHasRoute,
            disabledReason: t('directorStudio.previs.followHelp'),
          }))}
          subjectLabel={cameraSubject?.label ?? null}
          pilotActive={pilotActive}
          onPreset={(id) => {
            applyCameraPreset(id as DirectorCameraPresetId, cameraSubjectId);
            onSelectedItemChange(null);
            closeRailPanel();
          }}
          onTogglePilot={() => { toggleCameraPilot(); closeRailPanel(); }}
          onAddKey={addCameraMotionKeyframe}
        />
      ) : (
        <LensFlyoutBody camera={camera} presets={CAMERA_PRESETS} onFov={updateFov} onDistance={(lensDistance) => updateCamera({ lensDistance })} onPreset={selectCameraPreset} />
      )}
    </StageFlyout>
  ) : railPanel === 'lighting' ? (
    <StageFlyout title={t('directorStudio.toolbar.lighting')} closeLabel={t('common.close')} onClose={closeRailPanel}>
      <LightingFlyoutBody lighting={lighting} onChange={updateLighting} />
    </StageFlyout>
  ) : null;

  const motionEditing = {
    project: motionProject,
    items: data.items,
    selection: motionSelection,
    onSelectionChange: setMotionSelection,
    onTimeChange: setMotionTimeAndApply,
    onRetimeTrack: retimeMotionTrack,
    onPatchKeyframe: patchMotionKeyframe,
    onDuplicateKeyframe: duplicateMotionKeyframe,
    onDeleteKeyframe: deleteMotionKeyframe,
  };

  const selectedText = selectedItem
    ? inspectorTextDraft.itemId === selectedItem.id ? inspectorTextDraft : createInspectorTextDraft(selectedItem)
    : null;
  const inspectorNode = selectedItem && selectedText ? (
    <DirectorItemInspector
      key={selectedItem.id}
      item={selectedItem}
      text={selectedText}
      actionPresets={timelineOpen ? null : inspectorActionPresets.map((preset) => ({
        id: preset.id,
        value: preset.value,
        labelKey: preset.labelKey,
        selected: isInspectorActionPresetSelected(selectedItem.action, preset),
      }))}
      customActionPresets={customActionPresets.map((value) => ({ value, selected: normalizeActionValue(selectedItem.action) === normalizeActionValue(value) }))}
      motion={timelineOpen ? <DirectorPrevisItemMotion {...motionEditing} item={selectedItem} onOpenActions={() => setActionLibraryOpen(true)} /> : undefined}
      poseInspector={poseInspector}
      poseShortcut={shortcuts.poseEdit}
      onTextChange={updateInspectorTextDraft}
      onTextCommit={commitInspectorTextDraft}
      onUpdate={(patch) => updateItem(selectedItem.id, patch)}
      onPosition={(axis, value) => updateItemPosition(selectedItem, axis, value)}
      onRotationDegrees={(axis, value) => updateItemRotationDegrees(selectedItem, axis, value)}
      onScale={(axis, value) => updateItemScale(selectedItem, axis, value)}
      onAction={(value) => updateItemActionImmediately(selectedItem, value)}
      onDeleteActionPreset={(value) => { void deleteCustomActionPreset(value); }}
      onSaveActionPreset={saveCurrentActionPreset}
      onStartPose={togglePoseEdit}
      onBodyControls={(patch) => updateItemBodyControls(selectedItem, patch)}
      onBodySection={(section, patch) => updateItemBodySection(selectedItem, section, patch)}
      onLinkImage={() => openElementAssetPicker(selectedItem.id)}
      onClearImage={() => clearElementAsset(selectedItem.id)}
      onDelete={deleteSelectedItem}
    />
  ) : showCameraInspector ? (
    <DirectorPrevisCameraInspector
      {...motionEditing}
      previewProject={motionPreviewProject}
      onAddCameraKeyframe={addCameraMotionKeyframe}
      rigActions={{
        onAddRig: addCameraRig,
        onPreviewRig: previewCameraRig,
        onUpdateRig: updateCameraRig,
        onDeleteRig: deleteCameraRig,
        onBakeRig: bakeCameraRig,
        onTimeChange: setMotionTimeAndApply,
        onEditSegment: editCameraRigSegment,
      }}
    />
  ) : (
    <StageSceneInspector
      counts={{
        person: displayItems.filter((entry) => entry.displayCategory === 'person').length,
        object: displayItems.filter((entry) => entry.displayCategory === 'object').length,
        scene: displayItems.filter((entry) => entry.displayCategory === 'scene').length,
      }}
      prompt={basePromptDraft}
      onPromptChange={updateBasePromptDraft}
      onPromptCommit={commitBasePromptDraft}
      grid={grid}
      onGrid={updateGrid}
      resolution={screenshotResolution}
      resolutionOptions={SCREENSHOT_RESOLUTIONS.map((resolution) => ({ value: resolution.value, label: t(resolution.labelKey) }))}
      onResolution={(value) => onUpdateNodeData({ screenshotResolution: value })}
      viewSettings={viewSettings}
      onViewSettings={updateViewSettings}
      hasPanorama={Boolean(rawPanoramaUrl)}
      panoramaBusyLabel={panoramaImportStageLabel ?? (isUploadingPanorama ? t('directorStudio.importing') : null)}
      onImportPanorama={() => setImportOpen(true)}
      onClearPanorama={clearPanorama}
    />
  );

  const routeDraftStatus = timelineOpen && motionRouteDraft ? {
    targetLabel: motionRouteDraft.kind === 'object'
      ? data.items.find((item) => item.id === motionRouteDraft.trackId)?.label ?? ''
      : t('directorStudio.motion.timeline.camera'),
    hint: motionRouteDraft.method === 'draw'
      ? t('directorStudio.motion.route.hintDraw')
      : motionRouteDraft.method === 'line'
        ? t(routeDraftPointCount === 0 ? 'directorStudio.motion.route.lineStart' : 'directorStudio.motion.route.lineEnd')
        : routeDraftPointCount === 0
          ? t('directorStudio.motion.route.pointsStart')
          : t('directorStudio.motion.route.pointsCount', { count: routeDraftPointCount }),
    canFinish: motionRouteDraft.method === 'points' && routeDraftPointCount >= 2,
  } : null;
  const poseStatus = poseEditItemId && selectedItem ? {
    targetLabel: selectedItem.label,
    jointLabel: poseJoint ? t(`directorStudio.pose.joints.${poseJoint}`) : null,
  } : null;
  const selectionStatus = selectedItem ? {
    label: selectedItem.label,
    color: selectedItem.color || '#9ca3af',
    kindLabel: t(`directorStudio.category.${getDirectorStudioDisplayCategory(selectedItem)}`),
    isPerson: selectedItem.category === 'person',
  } : null;

  const content = (
    <div
      ref={tooltipsRootRef}
      // The portal still bubbles React events through the canvas tree: `nokey` stops React Flow from
      // treating Shift-drag here as a canvas rubber-band selection or keys as canvas shortcuts.
      className="director-studio-shell dark nodrag nopan nokey fixed inset-0 z-8600 flex flex-col overflow-hidden bg-bg text-text-dark"
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <StageHeader
        mode={studioMode}
        dirty={hasUnsavedChanges}
        projectName={activeProject?.name ?? t('directorStudio.untitledProject')}
        projectsOpen={projectsOpen}
        projectsMenu={(
          <StageProjectsMenu
            projects={projects.map((project) => {
              const cover = getProjectCover(project);
              return { id: project.id, name: project.name, coverUrl: cover ? resolveImageDisplayUrl(cover) ?? cover : null, updatedAt: project.updatedAt };
            })}
            activeId={data.activeDirectorStudioProjectId ?? null}
            formatTime={(value) => t('directorStudio.updatedAt', { time: formatProjectTime(value) })}
            onOpen={(id) => {
              const project = projects.find((entry) => entry.id === id);
              setProjectsOpen(false);
              if (project) void restoreProject(project);
            }}
            onRename={renameProject}
            onCover={(id) => {
              const project = projects.find((entry) => entry.id === id);
              if (project) void updateProjectCover(project);
            }}
            onDelete={(id) => {
              const project = projects.find((entry) => entry.id === id);
              if (project) void deleteProject(project);
            }}
            onCreate={() => { setProjectsOpen(false); void createBlankWorkspace(); }}
            onClose={() => setProjectsOpen(false)}
          />
        )}
        agentOpen={agentOpen}
        dockOpen={dockOpen}
        canRecord={motionProject.cameraTrack.length >= 2}
        shortcuts={{ undo: shortcuts.undo, redo: shortcuts.redo, save: shortcuts.save, screenshot: shortcuts.screenshot }}
        onBack={handleClose}
        onMode={switchStudioMode}
        onToggleProjects={() => setProjectsOpen((value) => !value)}
        onSave={() => { void saveProject(); }}
        onCapture={() => { void captureScreenshot(); }}
        onCaptureOptions={() => { setDockOpen(true); setDockTab('shots'); }}
        onRecord={openVideoExport}
        onUndo={undoCanvas}
        onRedo={redoCanvas}
        onToggleDock={() => setDockOpen((value) => !value)}
        onAgent={() => setAgentOpen((value) => !value)}
      />

      <div className="relative flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div ref={viewportRef} className="relative min-h-0 flex-1 overflow-hidden bg-[#0e1013]">
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
                  <div className="flex h-full items-center justify-center text-sm text-text-muted">
                    {t('directorStudio.loadingScene')}
                  </div>
                }
              >
                <BlueprintSceneComponent
                  ref={editorRef}
                  items={data.items}
                  onAssetLoadError={setSceneAssetError}
                  onItemsChange={onItemsChange}
                  referenceImages={referenceImages}
                  mode={data.mode === 'panorama' ? 'panorama' : 'flat'}
                  panoramaUrl={panoramaUrl}
                  width={sceneSize.width}
                  height={sceneSize.height}
                  fullBleed
                  orbitNavigation={orbitTool && !poseEditActive && !motionRouteDraft}
                  selectedItemId={selectedItemId}
                  selectedItemIds={stageSelection.ids}
                  onSelectionChange={(ids, toggle) => { commitPendingTextDrafts(); stageSelection.select(ids, 'viewport', toggle); setMotionSelection(null); setActiveTransformMode(ids.length ? 'move' : null); }}
                  followSelectedItem={followSelectedItem}
                  transformMode={!orbitTool && ((selectedItem && !selectedItem.locked && !selectedItem.hidden) || showCameraInspector) ? activeTransformMode : null}
                  cameraSelected={showCameraInspector}
                  onCameraLookAt={setCameraLookAt}
                  onCameraTargetSelect={(itemId) => { selectInspectorTarget('camera'); setCameraLookAt({ mode: 'target', targetId: itemId, bodyPart: 'torso' }); }}
                  onSelectedItemChange={selectItemForEditing}
                  customActionPoses={data.customActionPoses}
                  cameraFov={camera.fov}
                  cameraDistance={camera.lensDistance}
                  lighting={lighting}
                  grid={grid}
                  viewSettings={viewSettings}
                  keyboardShortcutsEnabled={activeDialog !== 'shortcuts' && !pendingConfirmation}
                  motionProject={timelineOpen ? motionProject : undefined}
                  motionRoutesVisible={timelineOpen && motionShowRoutes}
                  motionRouteSelection={timelineOpen && motionSelection && motionSelection.kind !== 'action'
                    ? {
                        kind: motionSelection.kind,
                        trackId: motionSelection.trackId,
                        keyframeId: motionSelection.keyframeId,
                      }
                    : null}
                  onMotionRoutePointSelect={(selection, time) => {
                    selectMotionRouteKeyframe(selection, time);
                    onSelectedItemChange(selection.kind === 'object' ? selection.trackId : null);
                  }}
                  onMotionRoutePointMove={moveMotionRouteKeyframe}
                  onMotionRouteRetime={retimeMotionTrack}
                  onMotionRouteToggleClosed={toggleMotionRouteClosed}
                  onMotionRoutePointInsert={(kind, trackId, time, position) => {
                    insertMotionRouteKeyframe(kind, trackId, time, position);
                    onSelectedItemChange(kind === 'object' ? trackId : null);
                  }}
                  motionRouteDraft={timelineOpen ? motionRouteDraft : null}
                  onMotionRouteDraftComplete={completeMotionRouteDraft}
                  onMotionRouteDraftCancel={cancelMotionRouteDraft}
                  onMotionRouteDraftProgress={setRouteDraftPointCount}
                  pilotActive={timelineOpen && pilotActive}
                  onPilotActiveChange={setPilotActive}
                  onPilotRecordCamera={recordPilotCamera}
                  onPilotTargetChange={setPilotTargetId}
                  poseEditItemId={pilotActive ? null : poseEditItemId}
                  poseEditJoint={poseJoint}
                  onPoseEditJointChange={setPoseJoint}
                  onPoseEditCommit={commitPoseEdit}
                  shotPreview={timelineOpen && motionPreviewMode === 'route' && shotPipVisible
                    ? {
                        aspect: selectedAspect.ratio ?? 2,
                        cameraLabel: t('directorStudio.motion.timeline.camera'),
                        aspectLabel: selectedAspect.ratio ? selectedAspect.value : t(selectedAspect.labelKey),
                      }
                    : null}
                  onShotPreviewActivate={() => setPreviewModeAndApply('shot')}
                />
              </Suspense>
            </DirectorSceneErrorBoundary>

            {safeFrameStyle && (!timelineOpen || motionPreviewMode === 'shot') ? (
              <div
                className="pointer-events-none absolute z-10 rounded-[2px] shadow-[0_0_0_9999px_rgb(0_0_0/0.32),inset_0_0_0_1px_rgb(255_255_255/0.55)]"
                style={safeFrameStyle}
              >
                {(['left-0 top-0 border-l-2 border-t-2', 'right-0 top-0 border-r-2 border-t-2', 'bottom-0 left-0 border-b-2 border-l-2', 'bottom-0 right-0 border-b-2 border-r-2'] as const).map((corner) => (
                  <span key={corner} className={`absolute h-3.5 w-3.5 border-white/90 ${corner}`} />
                ))}
                <div className="absolute bottom-2 right-2.5 font-mono text-[10px] tracking-wide text-white/70">
                  {t('directorStudio.safeFrame')} · {selectedAspect.value}
                </div>
              </div>
            ) : null}

            {captureFlashKey ? <div key={captureFlashKey} className="stage-flash pointer-events-none absolute inset-0 z-20 bg-white" /> : null}

            <StageToolRail groups={railGroups} footer={railFooter} openKey={railPanel} panel={railPanelNode} label={t('directorStudio.rail.label')} />
            <div className="pointer-events-none absolute left-1/2 top-3 z-20 flex max-w-[90%] -translate-x-1/2 flex-col items-center gap-2">
              <StageSelectionBar count={stageSelection.ids.length} locked={stageSelection.ids.some((id) => data.items.find((item) => item.id === id)?.locked)} onApply={applySelection} />
              {editError ? <div role="alert" className="pointer-events-auto rounded-lg bg-elevated px-3 py-2 text-xs text-danger shadow-lg"><button type="button" onClick={() => setEditError(null)}>{editError} ×</button></div> : null}
            </div>
            <StageSceneBuilder
              key={sourceNodeId}
              open={railPanel === 'sceneBuilder'}
              nodeId={sourceNodeId}
              projectId={projectId ?? undefined}
              onClose={closeRailPanel}
              onOpen={() => setRailPanel('sceneBuilder')}
              onApplied={(ids) => {
                const items = stageCommands.query(sourceNodeId).data.items;
                const item = items.find((entry) => ids.includes(entry.id));
                if (item) selectItemForEditing(item.id);
              }}
            />
            {sceneAssetError && <div role="alert" className="stage-glass absolute bottom-16 left-[68px] z-40 flex max-w-[min(420px,calc(100%-90px))] items-start gap-2 rounded-xl p-3 text-xs text-danger">
              <p className="min-w-0 flex-1 break-words">{sceneAssetError}</p>
              <UiIconButton size="sm" aria-label={t('common.close')} onClick={() => setSceneAssetError('')}><X /></UiIconButton>
            </div>}

            <StageViewBar
              previs={timelineOpen ? { previewMode: motionPreviewMode, showRoutes: motionShowRoutes, showPip: shotPipVisible } : null}
              frame={aspectFrame}
              frames={ASPECT_FRAMES.map((frame) => ({ value: frame.value, label: t(frame.labelKey) }))}
              hasSelection={Boolean(selectedItem)}
              following={followSelectedItem}
              keys={{ focus: shortcuts.focus, fit: shortcuts.fit, reset: shortcuts.reset }}
              onPreviewMode={setPreviewModeAndApply}
              onShowRoutes={setMotionShowRoutes}
              onShowPip={setShotPipVisible}
              onFrame={(value) => updateAspectFrame(normalizeAspectFrame(value))}
              onFocus={() => {
                if (!selectedItem) return;
                const next = !followSelectedItem;
                setFollowSelectedItem(next);
                if (next) editorRef.current?.focusItem(selectedItem.id);
              }}
              onFit={() => { editorRef.current?.fitCamera(); setFollowSelectedItem(false); }}
              onReset={() => { editorRef.current?.resetCamera(); setFollowSelectedItem(false); }}
            />

            <div className="pointer-events-none absolute inset-0 z-40">
              <DirectorCameraPilotHud
                active={timelineOpen && pilotActive}
                recording={false}
                currentTime={motionTimeSource.getSnapshot()}
                timeSource={motionTimeSource}
                bottomOffset={16}
                targetLabel={data.items.find((item) => item.id === pilotTargetId)?.label ?? null}
                onExit={() => editorRef.current?.exitPilot()}
              />
            </div>

            {!guideDismissed && !pilotActive ? (
              <div className="pointer-events-none absolute left-[68px] top-3 z-30">
                <StageGuideBar
                  hasPerson={data.items.some((item) => item.category === 'person')}
                  hasRoute={data.items.some((item) => item.category === 'person' && (motionProject.objectTracks[item.id]?.length ?? 0) >= 2)}
                  playback={playbackSource}
                  onAddPerson={() => setRailPanel('add')}
                  onDrawRoute={() => {
                    const person = selectedItem?.category === 'person' ? selectedItem : data.items.find((item) => item.category === 'person');
                    if (!person) {
                      setRailPanel('add');
                      return;
                    }
                    if (!timelineOpen) switchStudioMode('previs');
                    if (selectedItem?.id !== person.id) selectItemForEditing(person.id);
                    setActiveTransformMode(null);
                    setPoseEditActive(false);
                    setRailPanel(null);
                    startMotionRouteDraft({ kind: 'object', trackId: person.id, method: 'draw' });
                  }}
                  onPlay={() => {
                    if (!timelineOpen) switchStudioMode('previs');
                    setMotionPlaying(true);
                  }}
                  onClose={dismissGuide}
                />
              </div>
            ) : null}

            {pilotActive ? null : (
              <div className="pointer-events-none absolute inset-x-0 bottom-3 z-30 flex justify-center px-16">
                <StageStatusPill
                  routeDraft={routeDraftStatus}
                  pose={poseStatus}
                  selection={selectionStatus}
                  keys={{ pose: shortcuts.poseEdit, duplicate: '', delete: shortcuts.delete }}
                  onFinishRoute={finishMotionRouteDraft}
                  onCancelRoute={cancelMotionRouteDraft}
                  onExitPose={() => setPoseEditActive(false)}
                  onPose={togglePoseEdit}
                  onDuplicate={() => { if (copySelectedItem()) pasteCopiedItem(); }}
                  onDelete={deleteSelectedItem}
                  onDeselect={() => selectItemForEditing(null)}
                />
              </div>
            )}

            {!selectedItem && !routeDraftStatus && !pilotActive ? (
              <div className="pointer-events-none absolute bottom-4 left-[68px] z-20 text-[11px] text-text-subtle">
                {t(orbitTool ? 'ui.stage.orbitToolHint' : 'directorStudio.previs.navigationHint')}
              </div>
            ) : null}

            {captureToast ? (
              <StageCaptureToast
                url={captureToast}
                onOpen={() => { setDockOpen(true); setDockTab('shots'); setCaptureToast(null); }}
                onDismiss={() => setCaptureToast(null)}
              />
            ) : null}
          </div>

          {timelineOpen ? (
            <DirectorTimeline
              height={motionTimelineHeight}
              maxHeight={maxMotionTimelineHeight}
              onHeightChange={setTimelineHeightOverride}
              project={motionProject}
              items={data.items}
              selectedItemId={selectedItemId}
              timeSource={motionTimeSource}
              playbackSource={playbackSource}
              playbackRate={playbackRate}
              onPlaybackRateChange={setPlaybackRate}
              selection={motionSelection}
              onTimeChange={setMotionTimeAndApply}
              onTogglePlayback={() => setMotionPlaying((value) => !value)}
              onGoToStart={() => { setMotionPlaying(false); setMotionTimeAndApply(0); }}
              onLoopChange={(loop) => updateMotionProject((project) => ({ ...project, loop }))}
              onDurationChange={updateMotionDuration}
              onSelectionChange={(selection) => {
                cancelMotionRouteDraft();
                setMotionSelection(selection);
                if (selection?.kind === 'object' || selection?.kind === 'action') stageSelection.select([selection.trackId], 'timeline');
                else if (selection?.kind === 'camera') {
                  onSelectedItemChange(null);
                  setInspectorTarget('camera');
                }
              }}
              onSelectItem={(id) => { cancelMotionRouteDraft(); stageSelection.select([id], 'timeline'); setMotionSelection(null); setDockTab('scene'); }}
              onSelectCamera={() => selectInspectorTarget('camera')}
              onMoveKeyframe={moveMotionKeyframe}
              onCopyKeyframe={copyMotionKeyframe}
              onPatchKeyframes={patchMotionKeyframes}
              onDeleteKeyframes={deleteMotionKeyframes}
              onRetimeTrack={retimeMotionTrack}
              onCopyTrack={copyMotionTrack}
              onSplitAtTime={splitAtTime}
              rigActions={{ edit: editCameraRigSegment, retime: retimeCameraRig }}
              onAddCameraKeyframe={addCameraMotionKeyframe}
              onAddObjectKeyframe={addObjectMotionKeyframe}
              onAddActionKeyframe={(itemId) => addActionMotionKeyframe(itemId)}
            />
          ) : null}
        </div>

          <aside
            hidden={!dockOpen}
            className={dockOpen ? "flex shrink-0 flex-col border-l border-[var(--line)] bg-surface" : "hidden"}
            style={{ width: dockWidth }}
            aria-label={t('directorStudio.previs.sceneAndProperties')}
            onWheel={(event) => event.stopPropagation()}
          >
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--line)] px-2.5">
              <UiSegmented
                value={dockTab}
                onChange={setDockTab}
                size="sm"
                className="min-w-0 flex-1"
                aria-label={t('directorStudio.dock.label')}
                options={[
                  { value: 'scene', label: t('directorStudio.dock.layers'), icon: <Layers3 className="h-3.5 w-3.5" /> },
                  { value: 'shots', label: snapshotHistory.length ? `${t('directorStudio.dock.shots')} · ${snapshotHistory.length}` : t('directorStudio.dock.shots'), icon: <Aperture className="h-3.5 w-3.5" /> },
                ]}
              />
            </div>
            {dockTab === 'scene' ? (
              <>
                <div className="ui-scrollbar max-h-[40%] shrink-0 overflow-y-auto border-b border-[var(--line)] pt-2">
                  <StageOutliner
                    entries={displayItems.map(({ item, displayCategory }) => ({ item, category: displayCategory }))}
                    selectedItemId={selectedItemId}
                    selectedItemIds={stageSelection.ids}
                    target={timelineOpen ? inspectorTarget : 'scene'}
                    showCamera={timelineOpen}
                    cameraKeyCount={motionProject.cameraTrack.length}
                    keyCountByItem={timelineOpen
                      ? Object.fromEntries(data.items.map((item) => [item.id, (motionProject.objectTracks[item.id]?.length ?? 0) + (motionProject.actionTracks[item.id]?.length ?? 0)]))
                      : undefined}
                    onSelectTarget={selectInspectorTarget}
                    onSelectItem={(id, toggle) => { commitPendingTextDrafts(); stageSelection.select([id], 'outliner', toggle); setMotionSelection(null); setDockTab('scene'); setActiveTransformMode('move'); }}
                    onRename={(id, label) => updateItem(id, { label })}
                    onToggleHidden={(item) => applySelection({ type: 'update', patch: { hidden: !item.hidden } }, [item.id])}
                    onToggleLocked={(item) => applySelection({ type: 'update', patch: { locked: !item.locked } }, [item.id])}
                    onLinkImage={timelineOpen ? undefined : (item) => openElementAssetPicker(item.id)}
                  />
                </div>
                <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto pt-3">
                  {selectedItem?.locked ? <div className="mx-3 mb-3 rounded-lg bg-warning/10 p-3 text-xs text-warning">{t('ui.stage.selection.lockedHint', { name: selectedItem.label })}<UiButton className="mt-2" size="sm" onClick={() => applySelection({ type: 'update', patch: { locked: false } }, [selectedItem.id])}>{t('ui.stage.selection.unlock')}</UiButton></div> : null}
                  <fieldset disabled={selectedItem?.locked} className="min-w-0 border-0 p-0 disabled:opacity-60">{inspectorNode}</fieldset>
                </div>
              </>
            ) : null}
              <div hidden={dockTab !== 'shots'} className={dockTab === 'shots' ? "ui-scrollbar min-h-0 flex-1 overflow-y-auto pt-3" : "hidden"}>
                <StageCapturePanel key={sourceNodeId} nodeId={sourceNodeId} duration={data.motionProject?.durationSeconds ?? 0} currentTime={motionTimeSource.getSnapshot} />
                {(data.snapshotUrl || snapshotHistory.length > 0) ? <StageSnapshotsPanel
                  current={data.snapshotUrl ?? null}
                  history={snapshotHistory}
                  resolveUrl={(url) => resolveImageDisplayUrl(url) ?? url}
                  captureKeys={shortcuts.screenshot}
                  canAddToCanvas={Boolean(onAddSnapshotToCanvas)}
                  busy={isAddingSnapshotToCanvas}
                  onCapture={() => { void captureScreenshot(); }}
                  onSelect={(url) => { void selectSnapshot(url); }}
                  onDelete={(url) => { void deleteSnapshot(url); }}
                  onOpen={setLightboxSnapshotUrl}
                  onClearCurrent={clearCurrentSnapshot}
                  onClearAll={clearAllSnapshots}
                  onAddCurrent={() => { void addSnapshotToCanvas(); }}
                  onAddAll={() => { void addAllSnapshotsToCanvas(); }}
                /> : null}
              </div>
          </aside>

        {agentOpen && projectId ? (
          <aside ref={stageAgentPanelRef} className="stage-glass stage-pop absolute right-3 top-3 z-[45] w-[440px] max-w-[calc(100%-24px)] overflow-hidden rounded-2xl text-text-dark" style={{ width: stageAgentSize?.width, height: stageAgentSize?.height ?? 'calc(100% - 24px)', maxHeight: 'calc(100% - 24px)' }}>
            <ScopedAgentPanel scope="stage" projectId={projectId} compact onClose={() => setAgentOpen(false)} />
            <PanelResizeHandle panelRef={stageAgentPanelRef} storageKey="stageAgent" edge="left" />
          </aside>
        ) : null}

        {lightboxSnapshotUrl ? (
          <div className="absolute inset-0 z-[65] flex items-center justify-center bg-black/70 p-8 backdrop-blur-sm" onPointerDown={(event) => { if (event.target === event.currentTarget) setLightboxSnapshotUrl(null); }}>
            <UiIconButton size="sm" type="button" onClick={() => setLightboxSnapshotUrl(null)} className="absolute right-5 top-5" aria-label={t('common.close')}><X className="h-4 w-4" /></UiIconButton>
            <img
              src={resolveImageDisplayUrl(lightboxSnapshotUrl) ?? lightboxSnapshotUrl}
              alt={t('directorStudio.snapshotPreview')}
              className="stage-pop max-h-full max-w-full rounded-xl object-contain shadow-[0_30px_80px_rgb(0_0_0/0.6)]"
              draggable={false}
            />
          </div>
        ) : null}
      </div>

      {importOpen ? (
        <StageDialog title={t('directorStudio.panoramaImport')} subtitle={t('directorStudio.panoramaImportHint')} onClose={() => setImportOpen(false)}>
          <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto p-5">
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleUploadPanorama} />
            <div className="mb-5 grid grid-cols-2 gap-2">
              <UiButton variant="secondary" onClick={() => fileInputRef.current?.click()} disabled={isUploadingPanorama} loading={isUploadingPanorama} className="h-11">
                <Upload className="h-4 w-4" />{panoramaImportStageLabel ?? (isUploadingPanorama ? t('directorStudio.importing') : t('directorStudio.uploadPanorama'))}
              </UiButton>
              <UiButton variant="ghost" disabled={!rawPanoramaUrl || isUploadingPanorama} onClick={clearPanorama} className="h-11 text-danger hover:text-danger">
                <Eraser className="h-4 w-4" />{t('directorStudio.clearPanorama')}
              </UiButton>
            </div>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-subtle">{t('directorStudio.importFromAssets')}</div>
            {panoramaImportAssets.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--line-strong)] px-3 py-10 text-center text-xs text-text-subtle">{t('directorStudio.noImportAssets')}</div>
            ) : (
              <div className="grid grid-cols-3 gap-3">
                {panoramaImportAssets.map((image) => (
                  <StageImageTile
                    key={image.id}
                    url={resolveImageDisplayUrl(image.url) ?? image.url}
                    label={image.label}
                    active={rawPanoramaUrl === image.url}
                    disabled={isUploadingPanorama}
                    onClick={() => { void importPanorama(image.url, image.label); }}
                  />
                ))}
              </div>
            )}
          </div>
        </StageDialog>
      ) : null}

      {assetPickerItem ? (
        <StageDialog
          title={t('directorStudio.linkedImage.pickerTitle')}
          subtitle={t('directorStudio.linkedImage.pickerSubtitle', { name: assetPickerItem.label })}
          onClose={() => setAssetPickerItemId(null)}
          footer={(
            <>
              <UiButton size="sm" variant="ghost" disabled={!assetPickerItem.refImageUrl} onClick={() => { clearElementAsset(assetPickerItem.id); setAssetPickerItemId(null); }} className="mr-auto text-danger hover:text-danger">
                <Unlink className="h-3.5 w-3.5" />{t('directorStudio.linkedImage.clear')}
              </UiButton>
              <UiButton size="sm" variant="secondary" onClick={() => setAssetPickerItemId(null)}>{t('common.cancel')}</UiButton>
            </>
          )}
        >
          <div className="flex gap-2 border-b border-[var(--line)] px-5 py-3">
            <input ref={elementImageInputRef} type="file" accept="image/*" className="hidden" onChange={uploadElementAsset} />
            <UiInput value={assetQuery} onChange={(event) => setAssetQuery(event.target.value)} placeholder={t('directorStudio.linkedImage.search')} className="h-9 min-w-0 flex-1 px-3 text-xs" />
            <UiButton size="sm" variant="secondary" onClick={() => elementImageInputRef.current?.click()} disabled={isUploadingElementImage} loading={isUploadingElementImage} className="h-9">
              <Upload className="h-3.5 w-3.5" />{isUploadingElementImage ? t('directorStudio.linkedImage.uploading') : t('directorStudio.linkedImage.uploadAndLink')}
            </UiButton>
          </div>
          <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto p-5">
            {elementAssetOptions.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--line-strong)] px-3 py-10 text-center text-xs text-text-subtle">{t('directorStudio.linkedImage.noAssets')}</div>
            ) : (
              <div className="grid grid-cols-3 gap-3">
                {elementAssetOptions.map((asset) => (
                  <StageImageTile
                    key={asset.id}
                    url={resolveImageDisplayUrl(asset.url) ?? asset.url}
                    label={asset.label}
                    active={assetPickerItem.refImageUrl === asset.url}
                    onClick={() => chooseElementAsset(asset)}
                  />
                ))}
              </div>
            )}
          </div>
        </StageDialog>
      ) : null}

      <DirectorActionLibrary
        isOpen={actionLibraryOpen}
        selectedItem={selectedItem}
        project={motionProject}
        currentTime={motionTimeSource.getSnapshot()}
        customActionPoses={data.customActionPoses ?? {}}
        onClose={() => setActionLibraryOpen(false)}
        onApplyStaticPose={(poseId, pose) => { applyMotionActionState({ poseId, pose }); setActionLibraryOpen(false); }}
        onApplyProceduralAction={(actionId) => { applyMotionActionState({ actionId }); setActionLibraryOpen(false); }}
        onApplyClip={(clip) => { applyMotionActionState({ clipId: clip.id }); setActionLibraryOpen(false); }}
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

      {activeDialog === 'shortcuts' ? (
        <StageDialog title={t('directorStudio.shortcuts.title')} subtitle={t('directorStudio.shortcuts.editHint')} width={780} onClose={() => setActiveDialog(null)}>
          <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto p-5">
            {timelineOpen ? (
              <section className="mb-5 rounded-xl bg-[rgb(var(--accent-rgb)/0.08)] p-4 shadow-[inset_0_0_0_1px_rgb(var(--accent-rgb)/0.22)]">
                <div className="mb-3 text-xs font-semibold text-text-dark">{t('directorStudio.previs.helpTitle')}</div>
                <ol className="grid gap-3 md:grid-cols-2">
                  {([1, 2, 3, 4] as const).map((step) => (
                    <li key={step} className="flex gap-2.5 text-xs leading-5 text-text-muted">
                      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent font-mono text-[10px] font-semibold text-[var(--accent-fg)]">{step}</span>
                      <span>{t(`directorStudio.previs.helpStep${step}`)}</span>
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}
            <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
              {SHORTCUT_GROUPS.map((group) => (
                <section key={group.titleKey}>
                  <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-subtle">{t(group.titleKey)}</div>
                  <div>
                    {group.entries.map((entry) => {
                      const keyText = (entry.shortcutId ? shortcuts[entry.shortcutId] : entry.defaultKeys) ?? '';
                      const isEditing = entry.shortcutId === editingShortcutId;
                      return (
                        <div key={`${group.titleKey}-${entry.shortcutId ?? entry.defaultKeys}`} className="flex min-h-8 items-center justify-between gap-3 border-b border-[var(--line)] py-1 text-xs last:border-b-0">
                          <span className="min-w-0 truncate text-text-muted">{t(entry.labelKey)}</span>
                          {entry.shortcutId ? (
                            <button
                              type="button"
                              onClick={() => entry.shortcutId && setEditingShortcutId(entry.shortcutId)}
                              data-director-tooltip={t('directorStudio.shortcuts.clickToEdit')}
                              className={`stage-kbd h-6 min-w-[56px] cursor-pointer justify-center px-2 transition-colors hover:text-text-dark ${isEditing ? 'animate-pulse !bg-accent !text-[var(--accent-fg)]' : ''}`}
                            >
                              {isEditing ? t('directorStudio.shortcuts.recording') : keyText}
                            </button>
                          ) : (
                            <span className="stage-kbd h-6 min-w-[56px] justify-center px-2 opacity-70">{keyText}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          </div>
        </StageDialog>
      ) : null}

      {activeDialog === 'modelLibrary' ? (
        <StageDialog
          title={t('directorStudio.modelLibrary.title')}
          width={860}
          onClose={() => setActiveDialog(null)}
          actions={(
            <>
              <input ref={modelFileInputRef} type="file" accept=".glb,.gltf,model/gltf-binary,model/gltf+json" className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) void importMyModel(file);
                }} />
              <UiButton size="sm" variant="secondary" disabled={modelImportState.busy} loading={modelImportState.busy}
                data-director-tooltip={t('directorStudio.modelLibrary.uploadHint')}
                onClick={() => modelFileInputRef.current?.click()}>
                <Upload className="h-3.5 w-3.5" />{t('directorStudio.modelLibrary.uploadModel')}
              </UiButton>
            </>
          )}
        >
          <div className="flex min-h-0 flex-1">
            <nav className="w-40 shrink-0 space-y-0.5 border-r border-[var(--line)] p-2" aria-label={t('directorStudio.modelLibrary.title')}>
              {DIRECTOR_STUDIO_MODEL_CATEGORIES.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  onClick={() => setActiveModelCategory(category.id)}
                  className="stage-row w-full"
                  data-selected={activeModelCategory === category.id ? '' : undefined}
                >
                  <span className="min-w-0 flex-1 truncate text-left">{t(category.labelKey)}</span>
                  {category.id === 'mine' && myModels.length ? <span className="font-mono text-[10px] text-text-subtle">{myModels.length}</span> : null}
                </button>
              ))}
            </nav>
            <div className="ui-scrollbar min-h-[360px] min-w-0 flex-1 overflow-y-auto p-4">
              {modelImportState.error ? (
                <div role="alert" className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs leading-5 text-danger">{modelImportState.error}</div>
              ) : null}
              {activeModelCategory === 'mine' ? myModels.length === 0 ? (
                <StageEmpty
                  icon={<Box className="h-5 w-5" />}
                  title={t('directorStudio.modelLibrary.myModelsEmpty')}
                  hint={t('directorStudio.modelLibrary.myModelsHint')}
                  action={(
                    <UiButton size="sm" variant="secondary" disabled={modelImportState.busy} onClick={() => modelFileInputRef.current?.click()}>
                      <Upload className="h-3.5 w-3.5" />{t('directorStudio.modelLibrary.uploadModel')}
                    </UiButton>
                  )}
                />
              ) : (
                <div className="grid grid-cols-3 gap-3 lg:grid-cols-4">
                  {myModels.map((asset) => (
                    <div key={asset.id} className="group relative">
                      <button type="button" onClick={() => insertMyModel(asset)} className="stage-model-card w-full">
                        <div className="flex aspect-4/3 items-center justify-center"><Box className="h-8 w-8 text-text-subtle transition-colors group-hover:text-text-muted" /></div>
                        <div className="border-t border-[var(--line)] px-2.5 py-2 text-left">
                          <div className="truncate text-xs font-medium text-text-dark">{asset.name}</div>
                          <div className="mt-1 text-[10px] text-text-subtle">
                            {t('directorStudio.modelLibrary.myModelMeta', {
                              height: asset.defaultHeightMeters.toFixed(2),
                              size: asset.sizeBytes >= 1048576 ? `${(asset.sizeBytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(asset.sizeBytes / 1024))} KB`,
                            })}
                          </div>
                        </div>
                      </button>
                      <UiIconButton size="sm" onClick={() => { void deleteMyModel(asset); }}
                        className="absolute right-1.5 top-1.5 text-danger opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                        data-director-tooltip={t('directorStudio.modelLibrary.deleteMine', { name: asset.name })}
                        aria-label={t('directorStudio.modelLibrary.deleteMine', { name: asset.name })}><Trash2 className="h-3.5 w-3.5" /></UiIconButton>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-3 lg:grid-cols-4">
                  {modelCards.map((model) => (
                    <button key={model.id} type="button" onClick={() => insertModel(model)} className="stage-model-card group">
                      <div className="flex aspect-4/3 items-center justify-center p-4">
                        <DirectorStudioModelThumbnail model={model} />
                      </div>
                      <div className="flex items-center gap-1.5 border-t border-[var(--line)] px-2.5 py-2 text-left">
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: model.color }} />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-dark">{t(getModelNameKey(model), model.displayName)}</span>
                        <span className="shrink-0 text-[10px] text-text-subtle">{t(`directorStudio.category.${model.itemCategory}`)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </StageDialog>
      ) : null}

      {activeDialog === 'pedestrians' ? (
        <StageDialog
          title={t('directorStudio.pedestrians.title')}
          width={460}
          onClose={() => setActiveDialog(null)}
          footer={(
            <>
              <UiButton size="sm" variant="secondary" onClick={() => setActiveDialog(null)}>{t('common.cancel')}</UiButton>
              <UiButton size="sm" variant="primary" onClick={() => addPedestrians(pedestrianMode)}>
                <Users className="h-3.5 w-3.5" />{pedestrianMode === 'direct' ? t('directorStudio.pedestrians.addOne') : t('directorStudio.pedestrians.addBatch')}
              </UiButton>
            </>
          )}
        >
          <div className="space-y-4 p-5">
            <UiSegmented
              value={pedestrianMode}
              onChange={setPedestrianMode}
              size="sm"
              className="w-full"
              aria-label={t('directorStudio.pedestrians.title')}
              options={([
                ['direct', 'directorStudio.pedestrians.modes.direct'],
                ['array', 'directorStudio.pedestrians.modes.array'],
                ['random', 'directorStudio.pedestrians.modes.random'],
              ] as const).map(([value, labelKey]) => ({ value, label: t(labelKey) }))}
            />
            {pedestrianMode === 'direct' ? (
              <p className="rounded-xl bg-[var(--hover)] px-3 py-3 text-xs leading-5 text-text-muted">{t('directorStudio.pedestrians.directHint')}</p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <ScrubNumber label={t('directorStudio.pedestrians.count')} value={pedestrianCount} min={1} max={200} step={1} onCommit={setPedestrianCount} />
                {pedestrianMode === 'array' ? (
                  <>
                    <ScrubNumber label={t('directorStudio.pedestrians.columns')} value={pedestrianColumns} min={1} max={50} step={1} onCommit={setPedestrianColumns} />
                    <ScrubNumber label={t('directorStudio.pedestrians.xSpacing')} value={pedestrianXSpacing} min={0.2} max={10} step={0.1} suffix="m" onCommit={setPedestrianXSpacing} />
                    <ScrubNumber label={t('directorStudio.pedestrians.zSpacing')} value={pedestrianZSpacing} min={0.2} max={10} step={0.1} suffix="m" onCommit={setPedestrianZSpacing} />
                  </>
                ) : (
                  <ScrubNumber label={t('directorStudio.pedestrians.radius')} value={pedestrianRadius} min={0.5} max={30} step={0.5} suffix="m" onCommit={setPedestrianRadius} />
                )}
              </div>
            )}
          </div>
        </StageDialog>
      ) : null}
      <UiConfirm
        isOpen={pendingConfirmation !== null}
        title={pendingConfirmation?.title ?? ''}
        tone={pendingConfirmation?.tone}
        containerClassName="dark z-[15000]"
        onConfirm={() => pendingConfirmation?.resolve(true)}
        onClose={() => {
          pendingConfirmation?.resolve(false);
          setPendingConfirmation(null);
        }}
      />
      <div ref={tooltipRef} hidden role="tooltip" className="pointer-events-none fixed z-9999 max-w-[260px] rounded-md border border-[var(--line)] bg-surface px-2.5 py-1.5 text-center text-[11px] font-medium leading-4 text-text-dark shadow-[var(--shadow-pop)]" />
    </div>
  );

  if (typeof document === 'undefined') {
    return null;
  }

  return createPortal(content, document.body);
});

DirectorStudioShell.displayName = 'DirectorStudioShell';
