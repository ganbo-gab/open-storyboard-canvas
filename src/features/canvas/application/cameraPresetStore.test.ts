import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAMERA_PROFILES, LENS_PROFILES } from './cameraPromptLibrary';
import { deletePreset, getAllPresets, getPresetById, presetToCameraControl, savePreset, updatePreset } from './cameraPresetStore';

const key = 'storyboard-camera-presets';
const options = { enabled: true, camera: 'arri_alexa_mini_lf', lens: 'arri_signature_prime', focalLength: 50, aperture: 4 };
const existing = { id: 'portrait', name: 'Portrait', camera: 'sony_venice', lens: 'anamorphic', focalLength: 85, aperture: 1.4, createdAt: 1 };
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return { getItem: name => values.get(name) ?? null, setItem: (name, value) => { values.set(name, value); }, removeItem: name => { values.delete(name); },
    clear: () => values.clear(), key: index => [...values.keys()][index] ?? null, get length() { return values.size; } };
}
beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('camera preset persistence and migration', () => {
  it('initializes supported defaults only once and keeps an explicitly empty library empty', () => {
    const defaults = getAllPresets();
    expect(defaults.length).toBeGreaterThan(0);
    for (const preset of defaults) {
      expect(CAMERA_PROFILES.some(profile => profile.id === preset.camera)).toBe(true);
      expect(LENS_PROFILES.some(profile => profile.id === preset.lens)).toBe(true);
      expect(deletePreset(preset.id)).toBe(true);
    }
    expect(localStorage.getItem(key)).toBe('[]');
    expect(getAllPresets()).toEqual([]);
    const saved = savePreset('After clearing', options);
    expect(getAllPresets()).toEqual([saved]);
  });

  it.each([
    ['sony_venice', 'anamorphic', 'sony_venice_2', 'anamorphic_cooke'],
    ['red_weapon_8k', 'canon_cne', 'red_v_raptor_8k', 'canon_sumire_prime'],
    ['blackmagic_ursa', 'cooke_s7i', 'blackmagic_ursa_12k', 'cooke_s7i'],
  ])('migrates legacy %s/%s for consumers without overwriting the original during reads', (camera, lens, nextCamera, nextLens) => {
    const stored = JSON.stringify([{ ...existing, camera, lens }]);
    localStorage.setItem(key, stored);
    expect(getPresetById(existing.id)).toEqual({ ...existing, camera: nextCamera, lens: nextLens });
    expect(presetToCameraControl({ ...existing, camera, lens })).toEqual({ enabled: true, camera: nextCamera, lens: nextLens, focalLength: 85, aperture: 1.4 });
    expect(localStorage.getItem(key)).toBe(stored);
  });

  it('preserves unknown entries and extra fields through saves, updates and deletions', () => {
    const withExtra = { ...existing, futureNotes: { color: 'warm' } };
    const future = { ...existing, id: 'future', camera: 'future_camera', custom: true };
    const damaged = { ...existing, id: 'damaged', focalLength: '85' };
    const unknown = [future, damaged, null, 'reserved'];
    localStorage.setItem(key, JSON.stringify([withExtra, ...unknown]));
    expect(getAllPresets()).toEqual([{ ...withExtra, camera: 'sony_venice_2', lens: 'anamorphic_cooke' }]);
    const added = savePreset('New', options);
    expect(updatePreset(existing.id, { name: 'Renamed' })).toEqual({ ...withExtra, name: 'Renamed', camera: 'sony_venice_2', lens: 'anamorphic_cooke' });
    expect(deletePreset(existing.id)).toBe(true);
    expect(deletePreset(added.id)).toBe(true);
    const raw: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    expect(raw).toEqual(unknown);
    expect(getAllPresets()).toEqual([]);
    expect(deletePreset('future')).toBe(false);
  });

  it.each(['{bad json', 'null', '{}', '"future format"', '{"version":2,"presets":[]}'])('retains unsupported root data %s and blocks destructive writes', raw => {
    localStorage.setItem(key, raw);
    expect(() => getAllPresets()).toThrow(/原始数据已保留/);
    expect(() => savePreset('New', options)).toThrow();
    expect(() => updatePreset(existing.id, { name: 'Changed' })).toThrow();
    expect(() => deletePreset(existing.id)).toThrow();
    expect(localStorage.getItem(key)).toBe(raw);
  });

  it('does not initialize defaults when every stored item is unsupported', () => {
    const raw = JSON.stringify([{}, false, { ...existing, camera: 'future_camera' }]);
    localStorage.setItem(key, raw);
    expect(getAllPresets()).toEqual([]);
    expect(localStorage.getItem(key)).toBe(raw);
  });

  it('rejects invalid changes without modifying stored values', () => {
    localStorage.setItem(key, JSON.stringify([existing]));
    const original = localStorage.getItem(key);
    for (const invalid of [{ ...options, focalLength: -1 }, { ...options, aperture: Infinity }, { ...options, camera: 'future_camera' }]) {
      expect(() => savePreset('Invalid', invalid)).toThrow(/参数无效/);
    }
    expect(() => savePreset('   ', options)).toThrow(/参数无效/);
    expect(() => updatePreset(existing.id, { focalLength: NaN })).toThrow(/参数无效/);
    expect(() => presetToCameraControl({ ...existing, lens: 'future_lens' })).toThrow(/无法识别/);
    expect(localStorage.getItem(key)).toBe(original);
  });

  it('reports quota and access failures without claiming a successful save', () => {
    localStorage.setItem(key, JSON.stringify([existing]));
    const original = localStorage.getItem(key);
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(() => savePreset('New', options)).toThrow(/未保存成功/);
    expect(() => updatePreset(existing.id, { name: 'Renamed' })).toThrow(/未保存成功/);
    expect(() => deletePreset(existing.id)).toThrow(/未保存成功/);
    expect(localStorage.getItem(key)).toBe(original);
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(() => getAllPresets()).toThrow(/无法读取/);
  });
});
