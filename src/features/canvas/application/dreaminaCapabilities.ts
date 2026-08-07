import {
  normalizeVideoInputSchema,
  type VideoInputSchema,
} from './videoInputSchema';

export const DREAMINA_IMAGE_RATIOS = [
  '21:9',
  '16:9',
  '3:2',
  '4:3',
  '1:1',
  '3:4',
  '2:3',
  '9:16',
] as const;

export type DreaminaImageRatio = typeof DREAMINA_IMAGE_RATIOS[number];
export type DreaminaImageResolution = '1k' | '2k' | '4k';
export type DreaminaImageCommand = 'text2image' | 'image2image' | 'image_upscale';
export type DreaminaVideoCommand =
  | 'text2video'
  | 'image2video'
  | 'frames2video'
  | 'multiframe2video'
  | 'multimodal2video';

export interface DreaminaCountRange {
  min: number;
  max: number;
}

export interface DreaminaImageModelCapability {
  model: string;
  commands: readonly Exclude<DreaminaImageCommand, 'image_upscale'>[];
  resolutions: readonly DreaminaImageResolution[];
  ratios: readonly DreaminaImageRatio[];
  inputImages: DreaminaCountRange;
  generateCount: DreaminaCountRange;
}

export interface DreaminaCustomDimensionLimit {
  minSide: number;
  maxSide: number;
  maxPixels: number;
}

const TEXT_AND_IMAGE_COMMANDS = ['text2image', 'image2image'] as const;
const TEXT_ONLY_COMMANDS = ['text2image'] as const;
const IMAGE_GENERATE_COUNT = Object.freeze({ min: 1, max: 10 });

export const DREAMINA_IMAGE_MODEL_CAPABILITIES: readonly DreaminaImageModelCapability[] = [
  { model: '3.0', commands: TEXT_ONLY_COMMANDS, resolutions: ['1k', '2k'], ratios: DREAMINA_IMAGE_RATIOS, inputImages: { min: 0, max: 0 }, generateCount: IMAGE_GENERATE_COUNT },
  { model: '3.1', commands: TEXT_ONLY_COMMANDS, resolutions: ['1k', '2k'], ratios: DREAMINA_IMAGE_RATIOS, inputImages: { min: 0, max: 0 }, generateCount: IMAGE_GENERATE_COUNT },
  { model: '4.0', commands: TEXT_AND_IMAGE_COMMANDS, resolutions: ['2k', '4k'], ratios: DREAMINA_IMAGE_RATIOS, inputImages: { min: 1, max: 10 }, generateCount: IMAGE_GENERATE_COUNT },
  { model: '4.1', commands: TEXT_AND_IMAGE_COMMANDS, resolutions: ['2k', '4k'], ratios: DREAMINA_IMAGE_RATIOS, inputImages: { min: 1, max: 10 }, generateCount: IMAGE_GENERATE_COUNT },
  { model: '4.5', commands: TEXT_AND_IMAGE_COMMANDS, resolutions: ['2k', '4k'], ratios: DREAMINA_IMAGE_RATIOS, inputImages: { min: 1, max: 10 }, generateCount: IMAGE_GENERATE_COUNT },
  { model: '4.6', commands: TEXT_AND_IMAGE_COMMANDS, resolutions: ['2k', '4k'], ratios: DREAMINA_IMAGE_RATIOS, inputImages: { min: 1, max: 10 }, generateCount: IMAGE_GENERATE_COUNT },
  { model: '4.7', commands: TEXT_AND_IMAGE_COMMANDS, resolutions: ['2k', '4k'], ratios: DREAMINA_IMAGE_RATIOS, inputImages: { min: 1, max: 10 }, generateCount: IMAGE_GENERATE_COUNT },
  { model: '5.0', commands: TEXT_AND_IMAGE_COMMANDS, resolutions: ['2k', '4k'], ratios: DREAMINA_IMAGE_RATIOS, inputImages: { min: 1, max: 10 }, generateCount: IMAGE_GENERATE_COUNT },
  { model: '5.0Pro', commands: TEXT_AND_IMAGE_COMMANDS, resolutions: ['1k', '2k', '4k'], ratios: DREAMINA_IMAGE_RATIOS, inputImages: { min: 1, max: 10 }, generateCount: IMAGE_GENERATE_COUNT },
] as const;

export const DREAMINA_IMAGE_CUSTOM_DIMENSION_LIMITS: Readonly<Record<DreaminaImageResolution, DreaminaCustomDimensionLimit>> = {
  '1k': { minSide: 512, maxSide: 2016, maxPixels: 1_763_584 },
  '2k': { minSide: 768, maxSide: 3072, maxPixels: 4_194_304 },
  '4k': { minSide: 1536, maxSide: 6240, maxPixels: 16_777_216 },
};

export const DREAMINA_UPSCALE_RESOLUTIONS = ['2k', '4k', '8k'] as const;

export function listDreaminaImageModels(
  command: Exclude<DreaminaImageCommand, 'image_upscale'>,
): readonly DreaminaImageModelCapability[] {
  return DREAMINA_IMAGE_MODEL_CAPABILITIES.filter((capability) => capability.commands.includes(command));
}

export function getDreaminaImageModelCapability(
  command: Exclude<DreaminaImageCommand, 'image_upscale'>,
  model: string,
): DreaminaImageModelCapability | undefined {
  return DREAMINA_IMAGE_MODEL_CAPABILITIES.find(
    (capability) => capability.model === model && capability.commands.includes(command),
  );
}

export interface DreaminaVideoModelCapability {
  command: Exclude<DreaminaVideoCommand, 'multiframe2video'>;
  model: string;
  resolutions: readonly string[];
  durations: readonly string[];
  aspectRatios: readonly string[];
  inputSchema: VideoInputSchema;
  maxReferenceTotal: number;
  requiredMedia: 'none' | 'image' | 'images' | 'image-or-video' | 'any';
  vipOnly?: boolean;
}

export interface DreaminaMultiframeCapability {
  command: 'multiframe2video';
  resolutions: readonly ['720p', '1080p'];
  durations: readonly string[];
  aspectRatios: readonly ['auto'];
  inputSchema: VideoInputSchema;
  imageCount: DreaminaCountRange;
  segmentDuration: DreaminaCountRange;
  minTotalDuration: number;
}

const VIDEO_RATIOS = ['1:1', '3:4', '16:9', '4:3', '9:16', '21:9'] as const;
const AUTO_VIDEO_RATIO = ['auto'] as const;

function integerRange(min: number, max: number): string[] {
  return Array.from({ length: max - min + 1 }, (_, index) => String(index + min));
}

function textOnlySchema(): VideoInputSchema {
  return normalizeVideoInputSchema({
    images: { enabled: false, min: 0, max: 0, roles: ['reference'], requireImageHost: false },
    video: { enabled: false, min: 0, max: 0, field: '' },
    audio: { enabled: false, min: 0, max: 0, field: '' },
  });
}

function imageSchema(count: 1 | 2): VideoInputSchema {
  return normalizeVideoInputSchema({
    images: {
      enabled: true,
      min: count,
      max: count,
      roles: count === 1 ? ['firstFrame'] : ['firstFrame', 'lastFrame'],
      requireImageHost: false,
    },
    video: { enabled: false, min: 0, max: 0, field: '' },
    audio: { enabled: false, min: 0, max: 0, field: '' },
  });
}

function multimodalSchema(model: string): VideoInputSchema {
  const is25 = model === 'seedance2.5';
  return normalizeVideoInputSchema({
    images: {
      enabled: true,
      min: 0,
      max: is25 ? 30 : 9,
      roles: ['reference', 'firstFrame', 'lastFrame', 'keyframe'],
      requireImageHost: false,
    },
    video: { enabled: true, min: 0, max: is25 ? 10 : 3, field: 'video' },
    audio: { enabled: true, min: 0, max: is25 ? 10 : 3, field: 'audio' },
  });
}

interface DreaminaVideoProfile {
  model: string;
  commands: readonly Exclude<DreaminaVideoCommand, 'multiframe2video'>[];
  resolutions: readonly string[];
  durations: readonly string[];
  vipOnly?: boolean;
}

const SEEDANCE_COMMANDS = ['text2video', 'image2video', 'frames2video', 'multimodal2video'] as const;

const DREAMINA_VIDEO_PROFILES: readonly DreaminaVideoProfile[] = [
  { model: 'seedance1.0fast', commands: ['image2video'], resolutions: ['720p'], durations: integerRange(5, 10) },
  { model: 'seedance1.5pro', commands: ['image2video', 'frames2video'], resolutions: ['720p'], durations: integerRange(5, 12) },
  { model: 'seedance2.0', commands: SEEDANCE_COMMANDS, resolutions: ['720p'], durations: integerRange(4, 15) },
  { model: 'seedance2.0fast', commands: SEEDANCE_COMMANDS, resolutions: ['720p'], durations: integerRange(4, 15) },
  { model: 'seedance2.0_vip', commands: SEEDANCE_COMMANDS, resolutions: ['720p', '1080p', '4k'], durations: integerRange(4, 15), vipOnly: true },
  { model: 'seedance2.0fast_vip', commands: SEEDANCE_COMMANDS, resolutions: ['720p'], durations: integerRange(4, 15), vipOnly: true },
  { model: 'seedance2.0mini', commands: SEEDANCE_COMMANDS, resolutions: ['720p'], durations: integerRange(4, 15) },
  { model: 'seedance2.5', commands: SEEDANCE_COMMANDS, resolutions: ['480p', '720p'], durations: integerRange(4, 30), vipOnly: true },
] as const;

function requiredMediaFor(command: DreaminaVideoModelCapability['command'], model: string): DreaminaVideoModelCapability['requiredMedia'] {
  if (command === 'text2video') return 'none';
  if (command === 'image2video') return 'image';
  if (command === 'frames2video') return 'images';
  return model === 'seedance2.5' ? 'any' : 'image-or-video';
}

function inputSchemaFor(command: DreaminaVideoModelCapability['command'], model: string): VideoInputSchema {
  if (command === 'text2video') return textOnlySchema();
  if (command === 'image2video') return imageSchema(1);
  if (command === 'frames2video') return imageSchema(2);
  return multimodalSchema(model);
}

export const DREAMINA_VIDEO_MODEL_CAPABILITIES: readonly DreaminaVideoModelCapability[] = DREAMINA_VIDEO_PROFILES.flatMap(
  (profile) => profile.commands.map((command) => ({
    command,
    model: profile.model,
    resolutions: profile.resolutions,
    durations: profile.durations,
    aspectRatios: command === 'text2video' || command === 'multimodal2video'
      ? VIDEO_RATIOS
      : AUTO_VIDEO_RATIO,
    inputSchema: inputSchemaFor(command, profile.model),
    maxReferenceTotal: command === 'multimodal2video'
      ? (profile.model === 'seedance2.5' ? 50 : 12)
      : command === 'frames2video' ? 2 : command === 'image2video' ? 1 : 0,
    requiredMedia: requiredMediaFor(command, profile.model),
    vipOnly: profile.vipOnly,
  })),
);

export const DREAMINA_MULTIFRAME_CAPABILITY: DreaminaMultiframeCapability = {
  command: 'multiframe2video',
  resolutions: ['720p', '1080p'],
  durations: integerRange(2, 8),
  aspectRatios: ['auto'],
  inputSchema: normalizeVideoInputSchema({
    images: { enabled: true, min: 2, max: 20, roles: ['keyframe'], requireImageHost: false },
    video: { enabled: false, min: 0, max: 0, field: '' },
    audio: { enabled: false, min: 0, max: 0, field: '' },
  }),
  imageCount: { min: 2, max: 20 },
  segmentDuration: { min: 1, max: 8 },
  minTotalDuration: 2,
};

export function listDreaminaVideoModels(
  command: DreaminaVideoModelCapability['command'],
): readonly DreaminaVideoModelCapability[] {
  return DREAMINA_VIDEO_MODEL_CAPABILITIES.filter((capability) => capability.command === command);
}

export function getDreaminaVideoModelCapability(
  command: DreaminaVideoModelCapability['command'],
  model: string,
): DreaminaVideoModelCapability | undefined {
  return DREAMINA_VIDEO_MODEL_CAPABILITIES.find(
    (capability) => capability.command === command && capability.model === model,
  );
}

export const DREAMINA_VIDEO_ENTRY_COMMANDS = {
  'text-video': 'text2video',
  'image-video': 'image2video',
  'frames-video': 'frames2video',
  'multi-frame-video': 'multiframe2video',
  'all-reference-video': 'multimodal2video',
} as const satisfies Record<string, DreaminaVideoCommand>;

export type DreaminaVideoEntryKind = keyof typeof DREAMINA_VIDEO_ENTRY_COMMANDS;

export interface ParsedDreaminaVideoEntry {
  entryKind: DreaminaVideoEntryKind;
  command: DreaminaVideoCommand;
  model?: string;
  supported: boolean;
  diagnostic?: string;
}

export function parseDreaminaVideoEntryId(entryId: string): ParsedDreaminaVideoEntry | null {
  const parts = entryId.split(':');
  if (parts[0] !== 'dreamina' || parts.length < 2) return null;
  const entryKind = parts[1] as DreaminaVideoEntryKind;
  const command = DREAMINA_VIDEO_ENTRY_COMMANDS[entryKind];
  if (!command) return null;
  const model = parts.slice(2).join(':').trim() || undefined;
  if (command === 'multiframe2video') {
    return {
      entryKind,
      command,
      model,
      supported: model === undefined,
      diagnostic: model === undefined ? undefined : 'Multi-frame video does not accept a model override.',
    };
  }
  const supported = Boolean(model && getDreaminaVideoModelCapability(command, model));
  return {
    entryKind,
    command,
    model,
    supported,
    diagnostic: supported
      ? undefined
      : model
        ? `Dreamina CLI no longer supports ${model} for ${command}; select a current model.`
        : `Dreamina model is missing for ${command}.`,
  };
}

export interface DreaminaCapabilityIssue {
  code: string;
  field: string;
  message: string;
}

function validateCount(
  issues: DreaminaCapabilityIssue[],
  field: string,
  value: number,
  range: DreaminaCountRange,
): void {
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    issues.push({
      code: 'count-out-of-range',
      field,
      message: `${field} must be between ${range.min} and ${range.max}.`,
    });
  }
}

export interface ValidateDreaminaImageRequestInput {
  command: DreaminaImageCommand;
  model?: string;
  resolution?: string;
  ratio?: string;
  imageCount: number;
  generateCount?: number;
}

export function validateDreaminaImageRequest(
  input: ValidateDreaminaImageRequestInput,
): DreaminaCapabilityIssue[] {
  const issues: DreaminaCapabilityIssue[] = [];
  if (input.command === 'image_upscale') {
    validateCount(issues, 'imageCount', input.imageCount, { min: 1, max: 1 });
    if (input.resolution && !DREAMINA_UPSCALE_RESOLUTIONS.includes(input.resolution as typeof DREAMINA_UPSCALE_RESOLUTIONS[number])) {
      issues.push({ code: 'unsupported-resolution', field: 'resolution', message: `Unsupported upscale resolution: ${input.resolution}.` });
    }
    return issues;
  }

  const capability = input.model
    ? getDreaminaImageModelCapability(input.command, input.model)
    : undefined;
  if (!capability) {
    issues.push({ code: 'unsupported-model', field: 'model', message: `Unsupported Dreamina model for ${input.command}: ${input.model ?? '(missing)'}.` });
    return issues;
  }
  const expectedImages = input.command === 'text2image' ? { min: 0, max: 0 } : capability.inputImages;
  validateCount(issues, 'imageCount', input.imageCount, expectedImages);
  if (input.resolution && !capability.resolutions.includes(input.resolution as DreaminaImageResolution)) {
    issues.push({ code: 'unsupported-resolution', field: 'resolution', message: `${input.model} does not support ${input.resolution}.` });
  }
  if (input.ratio && input.ratio !== 'auto' && !capability.ratios.includes(input.ratio as DreaminaImageRatio)) {
    issues.push({ code: 'unsupported-ratio', field: 'ratio', message: `Unsupported Dreamina image ratio: ${input.ratio}.` });
  }
  validateCount(issues, 'generateCount', input.generateCount ?? 1, capability.generateCount);
  return issues;
}

export interface DreaminaTransitionSegment {
  prompt: string;
  duration?: number;
}

export function parseDreaminaTransitionSegments(
  value: unknown,
): DreaminaTransitionSegment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { prompt: '' };
    }
    const record = item as Record<string, unknown>;
    const rawDuration = record.duration;
    const duration = typeof rawDuration === 'number'
      ? rawDuration
      : typeof rawDuration === 'string' && rawDuration.trim()
        ? Number(rawDuration)
        : undefined;
    return {
      prompt: typeof record.prompt === 'string' ? record.prompt : '',
      duration: duration !== undefined && Number.isFinite(duration) ? duration : undefined,
    };
  });
}

export function resizeDreaminaTransitionSegments(
  value: unknown,
  expectedCount: number,
): DreaminaTransitionSegment[] {
  const count = Number.isInteger(expectedCount) && expectedCount > 0 ? expectedCount : 0;
  const current = parseDreaminaTransitionSegments(value) ?? [];
  return Array.from({ length: count }, (_, index) => ({
    prompt: current[index]?.prompt ?? '',
    ...(current[index]?.duration !== undefined ? { duration: current[index].duration } : {}),
  }));
}

export interface ValidateDreaminaVideoRequestInput {
  command: DreaminaVideoCommand;
  model?: string;
  resolution?: string;
  duration?: number;
  ratio?: string;
  imageCount: number;
  videoCount: number;
  audioCount: number;
  transitions?: readonly DreaminaTransitionSegment[];
}

export function validateDreaminaVideoRequest(
  input: ValidateDreaminaVideoRequestInput,
): DreaminaCapabilityIssue[] {
  const issues: DreaminaCapabilityIssue[] = [];
  if (input.command === 'multiframe2video') {
    validateCount(issues, 'imageCount', input.imageCount, DREAMINA_MULTIFRAME_CAPABILITY.imageCount);
    if (input.resolution && !DREAMINA_MULTIFRAME_CAPABILITY.resolutions.includes(input.resolution as '720p' | '1080p')) {
      issues.push({ code: 'unsupported-resolution', field: 'resolution', message: `Multi-frame video does not support ${input.resolution}.` });
    }
    if (input.imageCount >= 3) {
      const expected = input.imageCount - 1;
      if (input.transitions?.length !== expected) {
        issues.push({ code: 'transition-count-mismatch', field: 'transitions', message: `${input.imageCount} images require exactly ${expected} transition segments.` });
      } else {
        input.transitions.forEach((transition, index) => {
          if (!transition.prompt.trim()) {
            issues.push({ code: 'transition-prompt-empty', field: `transitions.${index}.prompt`, message: 'Transition prompt cannot be empty.' });
          }
          if (transition.duration !== undefined) {
            validateCount(issues, `transitions.${index}.duration`, transition.duration, DREAMINA_MULTIFRAME_CAPABILITY.segmentDuration);
          }
        });
        const durations = input.transitions.map((transition) => transition.duration);
        if (durations.some((duration) => duration !== undefined)) {
          if (durations.some((duration) => duration === undefined)) {
            issues.push({ code: 'transition-duration-incomplete', field: 'transitions', message: 'Provide a duration for every transition or omit all transition durations.' });
          } else if ((durations as number[]).reduce((sum, duration) => sum + duration, 0) < DREAMINA_MULTIFRAME_CAPABILITY.minTotalDuration) {
            issues.push({ code: 'total-duration-too-short', field: 'transitions', message: 'Total transition duration must be at least 2 seconds.' });
          }
        }
      }
    }
    return issues;
  }

  const capability = input.model
    ? getDreaminaVideoModelCapability(input.command, input.model)
    : undefined;
  if (!capability) {
    issues.push({ code: 'unsupported-model', field: 'model', message: `Unsupported Dreamina model for ${input.command}: ${input.model ?? '(missing)'}.` });
    return issues;
  }
  const { images, video, audio } = capability.inputSchema;
  validateCount(issues, 'imageCount', input.imageCount, { min: images.min, max: images.max });
  validateCount(issues, 'videoCount', input.videoCount, { min: video.min, max: video.max });
  validateCount(issues, 'audioCount', input.audioCount, { min: audio.min, max: audio.max });

  const total = input.imageCount + input.videoCount + input.audioCount;
  if (total > capability.maxReferenceTotal) {
    issues.push({ code: 'reference-total-exceeded', field: 'references', message: `Reference total exceeds ${capability.maxReferenceTotal}.` });
  }
  if (capability.requiredMedia === 'image-or-video' && input.imageCount + input.videoCount === 0) {
    issues.push({ code: 'required-media-missing', field: 'references', message: 'This model requires at least one image or video reference.' });
  }
  if (capability.requiredMedia === 'any' && total === 0) {
    issues.push({ code: 'required-media-missing', field: 'references', message: 'This model requires at least one media reference.' });
  }
  if (input.resolution && !capability.resolutions.includes(input.resolution)) {
    issues.push({ code: 'unsupported-resolution', field: 'resolution', message: `${input.model} does not support ${input.resolution}.` });
  }
  if (input.duration !== undefined && !capability.durations.includes(String(input.duration))) {
    issues.push({ code: 'unsupported-duration', field: 'duration', message: `${input.model} does not support ${input.duration}s.` });
  }
  if (input.ratio && input.ratio !== 'auto' && !capability.aspectRatios.includes(input.ratio)) {
    issues.push({ code: 'unsupported-ratio', field: 'ratio', message: `${input.command} does not support ratio ${input.ratio}.` });
  }
  return issues;
}
