export type VideoReferenceRole = 'reference' | 'firstFrame' | 'lastFrame' | 'keyframe';

export interface VideoImageInputSchema {
  enabled: boolean;
  min: number;
  max: number;
  roles: VideoReferenceRole[];
  requireImageHost: boolean;
}

export interface VideoMediaInputSchema {
  enabled: boolean;
  min: number;
  max: number;
  field: string;
}

export interface VideoInputSchema {
  images: VideoImageInputSchema;
  video: VideoMediaInputSchema;
  audio: VideoMediaInputSchema;
}

const MAX_REFERENCE_IMAGES = 30;
const MAX_MEDIA_REFERENCES = 10;
const VALID_REFERENCE_ROLES = new Set<VideoReferenceRole>([
  'reference',
  'firstFrame',
  'lastFrame',
  'keyframe',
]);

function isVideoReferenceRole(value: string): value is VideoReferenceRole {
  return VALID_REFERENCE_ROLES.has(value as VideoReferenceRole);
}

export const DEFAULT_VIDEO_INPUT_SCHEMA: VideoInputSchema = {
  images: {
    enabled: true,
    min: 0,
    max: 1,
    roles: ['reference'],
    requireImageHost: false,
  },
  video: {
    enabled: false,
    min: 0,
    max: 0,
    field: '',
  },
  audio: {
    enabled: false,
    min: 0,
    max: 0,
    field: '',
  },
};

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cloneSchema(schema: VideoInputSchema): VideoInputSchema {
  return {
    images: {
      ...schema.images,
      roles: [...schema.images.roles],
    },
    video: { ...schema.video },
    audio: { ...schema.audio },
  };
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function normalizeReferenceRoles(value: unknown, fallback: VideoReferenceRole[]): VideoReferenceRole[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const seen = new Set<VideoReferenceRole>();
  const roles: VideoReferenceRole[] = [];
  value.forEach((item) => {
    const role = typeof item === 'string' ? item.trim() : '';
    if (isVideoReferenceRole(role) && !seen.has(role)) {
      seen.add(role);
      roles.push(role);
    }
  });
  return roles.length > 0 ? roles : [...fallback];
}

function normalizeMediaField(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function normalizeImageSchema(value: unknown, fallback: VideoImageInputSchema): VideoImageInputSchema {
  const raw = asPlainRecord(value);
  const enabled = raw?.enabled === undefined ? fallback.enabled : raw.enabled === true;
  const fallbackMax = enabled ? fallback.max : 0;
  const max = clampInteger(raw?.max, fallbackMax, 0, MAX_REFERENCE_IMAGES);
  const min = clampInteger(raw?.min, fallback.min, 0, max);
  return {
    enabled,
    min: enabled ? min : 0,
    max: enabled ? max : 0,
    roles: normalizeReferenceRoles(raw?.roles, fallback.roles),
    requireImageHost: raw?.requireImageHost === undefined
      ? fallback.requireImageHost
      : raw.requireImageHost === true,
  };
}

function normalizeMediaSchema(value: unknown, fallback: VideoMediaInputSchema): VideoMediaInputSchema {
  const raw = asPlainRecord(value);
  const enabled = raw?.enabled === undefined ? fallback.enabled : raw.enabled === true;
  const fallbackMax = enabled ? fallback.max : 0;
  const max = clampInteger(raw?.max, fallbackMax, 0, MAX_MEDIA_REFERENCES);
  const min = clampInteger(raw?.min, fallback.min, 0, max);
  return {
    enabled,
    min: enabled ? min : 0,
    max: enabled ? max : 0,
    field: normalizeMediaField(raw?.field, fallback.field),
  };
}

export function normalizeVideoInputSchema(
  value: unknown,
  fallback: VideoInputSchema = DEFAULT_VIDEO_INPUT_SCHEMA
): VideoInputSchema {
  const raw = asPlainRecord(value);
  const base = cloneSchema(fallback);
  if (!raw) {
    return base;
  }
  return {
    images: normalizeImageSchema(raw.images, base.images),
    video: normalizeMediaSchema(raw.video, base.video),
    audio: normalizeMediaSchema(raw.audio, base.audio),
  };
}

export function defaultVideoInputSchemaForProviderKind(providerKind: unknown): VideoInputSchema {
  const kind = typeof providerKind === 'string' ? providerKind.trim().toLowerCase() : '';
  if (kind === 'agnes-video') {
    return normalizeVideoInputSchema({
      images: {
        enabled: true,
        min: 0,
        max: 9,
        roles: ['reference', 'firstFrame', 'lastFrame', 'keyframe'],
        requireImageHost: false,
      },
      video: {
        enabled: true,
        min: 0,
        max: 1,
        field: 'video_url',
      },
      audio: {
        enabled: false,
        min: 0,
        max: 0,
        field: '',
      },
    });
  }
  if (kind === 'seedance-video') {
    return normalizeVideoInputSchema({
      images: {
        enabled: true,
        min: 0,
        max: 9,
        roles: ['reference', 'firstFrame', 'lastFrame', 'keyframe'],
        requireImageHost: true,
      },
      video: {
        enabled: false,
        min: 0,
        max: 0,
        field: '',
      },
      audio: {
        enabled: false,
        min: 0,
        max: 0,
        field: '',
      },
    });
  }
  if (kind === 'chengmeng-seedance9') {
    return normalizeVideoInputSchema({
      images: {
        enabled: true,
        min: 0,
        max: 9,
        roles: ['reference', 'firstFrame', 'lastFrame'],
        requireImageHost: true,
      },
      video: {
        enabled: true,
        min: 0,
        max: 3,
        field: 'values.videos',
      },
      audio: {
        enabled: true,
        min: 0,
        max: 3,
        field: 'values.audioUrls',
      },
    });
  }
  if (kind === 'nova-grok-video-15') {
    return normalizeVideoInputSchema({
      images: {
        enabled: true,
        min: 1,
        max: 1,
        roles: ['firstFrame'],
        requireImageHost: true,
      },
      video: {
        enabled: false,
        min: 0,
        max: 0,
        field: '',
      },
      audio: {
        enabled: false,
        min: 0,
        max: 0,
        field: '',
      },
    });
  }
  if (kind === 'custom-video-api') {
    return normalizeVideoInputSchema({
      images: {
        enabled: true,
        min: 0,
        max: 9,
        roles: ['reference', 'firstFrame', 'lastFrame', 'keyframe'],
        requireImageHost: true,
      },
      video: {
        enabled: false,
        min: 0,
        max: 0,
        field: 'videos',
      },
      audio: {
        enabled: false,
        min: 0,
        max: 0,
        field: 'audios',
      },
    });
  }
  if (kind === 'xai-grok-video') {
    return normalizeVideoInputSchema({
      images: {
        enabled: true,
        min: 0,
        max: 1,
        roles: ['reference'],
        requireImageHost: false,
      },
    });
  }
  if (kind === 'google-video') {
    return normalizeVideoInputSchema({
      images: {
        enabled: true,
        min: 0,
        max: 3,
        roles: ['reference', 'firstFrame', 'lastFrame'],
        requireImageHost: true,
      },
    });
  }
  return cloneSchema(DEFAULT_VIDEO_INPUT_SCHEMA);
}

export function resolveVideoInputSchemaFromExtraParams(
  extraParams: unknown,
  modelId?: string
): VideoInputSchema {
  const params = asPlainRecord(extraParams);
  const fallback = defaultVideoInputSchemaForProviderKind(params?.providerKind);
  const providerSchema = normalizeVideoInputSchema(params?.videoInputSchema, fallback);
  const byModel = asPlainRecord(params?.videoInputSchemasByModel);
  if (modelId && byModel) {
    return normalizeVideoInputSchema(byModel[modelId], providerSchema);
  }
  return providerSchema;
}
