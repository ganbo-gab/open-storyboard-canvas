import { z } from 'zod';
import { type CameraControlOptions } from '@/features/canvas/domain/canvasNodes';
import { CAMERA_PROFILES, LENS_PROFILES } from './cameraPromptLibrary';

const STORAGE_KEY = 'storyboard-camera-presets';

const cameraPresetSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  camera: z.string().min(1),
  lens: z.string().min(1),
  focalLength: z.number().finite().positive(),
  aperture: z.number().finite().positive(),
  createdAt: z.number().finite().nonnegative(),
});
export type CameraPreset = z.infer<typeof cameraPresetSchema>;
const storedEntriesSchema = z.array(z.unknown());
const legacyCameras: Readonly<Record<string, string>> = {
  sony_venice: 'sony_venice_2',
  red_weapon_8k: 'red_v_raptor_8k',
  blackmagic_ursa: 'blackmagic_ursa_12k',
};
const legacyLenses: Readonly<Record<string, string>> = {
  anamorphic: 'anamorphic_cooke',
  canon_cne: 'canon_sumire_prime',
};

const DEFAULT_PRESETS: CameraPreset[] = [
  {
    id: 'default-1',
    name: '电影标准',
    camera: 'arri_alexa_mini_lf',
    lens: 'arri_signature_prime',
    focalLength: 35,
    aperture: 2.8,
    createdAt: 0,
  },
  {
    id: 'default-2',
    name: '人像特写',
    camera: 'sony_venice_2',
    lens: 'zeiss_supreme_prime',
    focalLength: 85,
    aperture: 1.4,
    createdAt: 0,
  },
  {
    id: 'default-3',
    name: '广角风光',
    camera: 'red_v_raptor_8k',
    lens: 'cooke_s7i',
    focalLength: 24,
    aperture: 8,
    createdAt: 0,
  },
  {
    id: 'default-4',
    name: '复古质感',
    camera: 'panavision_dxl2',
    lens: 'anamorphic_cooke',
    focalLength: 50,
    aperture: 4,
    createdAt: 0,
  },
];

function generateId(): string {
  return `preset-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Keep unsupported entries intact so a newer format or damaged item stays recoverable. */
function readStoredEntries(): unknown[] | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === null) return null;
    const value: unknown = JSON.parse(stored);
    const parsed = storedEntriesSchema.safeParse(value);
    if (!parsed.success) throw new Error('unsupported');
    return parsed.data;
  } catch {
    throw new Error('无法读取摄像机预设，原始数据已保留；请先恢复本机预设数据后再保存。');
  }
}

function decodePreset(value: unknown): CameraPreset | null {
  const parsed = cameraPresetSchema.safeParse(value);
  if (!parsed.success) return null;
  const camera = legacyCameras[parsed.data.camera] ?? parsed.data.camera;
  const lens = legacyLenses[parsed.data.lens] ?? parsed.data.lens;
  if (!CAMERA_PROFILES.some((profile) => profile.id === camera)
    || !LENS_PROFILES.some((profile) => profile.id === lens)) return null;
  return { ...parsed.data, camera, lens };
}

function saveEntries(entries: readonly unknown[]): void {
  try {
    // Migrate only recognized presets on explicit edits, retaining unknown fields/items.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.map((entry) => decodePreset(entry) ?? entry)));
  } catch {
    throw new Error('摄像机预设未保存成功，请检查本机存储空间和访问权限后重试。');
  }
}

export function getAllPresets(): CameraPreset[] {
  const entries = readStoredEntries();
  if (entries === null) saveEntries(DEFAULT_PRESETS);
  return (entries ?? DEFAULT_PRESETS).flatMap((entry) => {
    const preset = decodePreset(entry);
    return preset ? [preset] : [];
  });
}

export function getPresetById(id: string): CameraPreset | undefined {
  const presets = getAllPresets();
  return presets.find((p) => p.id === id);
}

export function savePreset(
  name: string,
  cameraControl: CameraControlOptions
): CameraPreset {
  const entries = readStoredEntries() ?? [...DEFAULT_PRESETS];
  const newPreset = decodePreset({
    id: generateId(),
    name: name.trim(),
    camera: cameraControl.camera,
    lens: cameraControl.lens,
    focalLength: cameraControl.focalLength,
    aperture: cameraControl.aperture,
    createdAt: Date.now(),
  });
  if (!newPreset) throw new Error('摄像机预设参数无效，请选择有效的机身、镜头、焦距和光圈。');
  saveEntries([newPreset, ...entries]);
  return newPreset;
}

export function updatePreset(
  id: string,
  updates: Partial<Pick<CameraPreset, 'name' | 'camera' | 'lens' | 'focalLength' | 'aperture'>>
): CameraPreset | null {
  const entries = readStoredEntries() ?? [...DEFAULT_PRESETS];
  const index = entries.findIndex((entry) => decodePreset(entry)?.id === id);
  if (index === -1) {
    return null;
  }
  const updated = decodePreset({ ...decodePreset(entries[index]), ...updates });
  if (!updated) throw new Error('摄像机预设参数无效，原配置已保留。');
  entries[index] = updated;
  saveEntries(entries);
  return updated;
}

export function deletePreset(id: string): boolean {
  const entries = readStoredEntries() ?? DEFAULT_PRESETS;
  const filtered = entries.filter((entry) => decodePreset(entry)?.id !== id);
  if (filtered.length === entries.length) {
    return false;
  }
  saveEntries(filtered);
  return true;
}

export function presetToCameraControl(preset: CameraPreset): CameraControlOptions {
  const normalized = decodePreset(preset);
  if (!normalized) throw new Error('此摄像机预设包含无法识别的参数，请重新选择机身和镜头。');
  return {
    enabled: true,
    camera: normalized.camera,
    lens: normalized.lens,
    focalLength: normalized.focalLength,
    aperture: normalized.aperture,
  };
}
