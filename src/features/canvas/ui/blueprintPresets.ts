import { DIRECTOR_STUDIO_MODEL_CATALOG, DIRECTOR_STUDIO_MODEL_LABELS } from '@/features/canvas/domain/directorStudioModelCatalog';
import {
  BLUEPRINT_OBJECT_PRESET_LABELS,
  BLUEPRINT_PERSON_PRESET_LABELS,
} from '@/features/canvas/domain/blueprintPresetCatalog';

/**
 * Physical-size registry and legacy SVG sprite fallbacks.
 *
 * Procedural object models use total bounding-box height in meters. These
 * canonical heights preserve the factory's authored widths and depths; passing
 * a different height to createObjectMeshGroup uniformly resizes the whole model.
 * The SVGs remain available for legacy sprite callers, not model thumbnails.
 */

export interface BlueprintSpritePreset {
  id: string;
  label: string;
  category: 'person' | 'object';
  color: string;
  /** Full inline SVG markup with viewBox. */
  svg: string;
  /** World-space height in meters. Width is inferred from viewBox aspect. */
  heightMeters: number;
  /** Default viewBox aspect (w / h) — used to size the sprite plane. */
  aspect: number;
}

// ---------------------------------------------------------------------------
// SVG primitives — flat 2-tone silhouettes sized for 0.5 m grid readability.
// The stroke is dark / fill uses the preset color so colour chips and the
// 3D sprites visually match.
// ---------------------------------------------------------------------------

const SVG_MAN = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 200"><g fill="#3b82f6" stroke="#1e293b" stroke-width="3" stroke-linejoin="round"><circle cx="50" cy="30" r="18"/><path d="M 32 50 Q 32 58 36 64 L 36 115 Q 36 120 40 120 L 60 120 Q 64 120 64 115 L 64 64 Q 68 58 68 50 Z"/><rect x="38" y="120" width="10" height="60" rx="3"/><rect x="52" y="120" width="10" height="60" rx="3"/><rect x="26" y="66" width="8" height="50" rx="3"/><rect x="66" y="66" width="8" height="50" rx="3"/></g></svg>`;

const SVG_WOMAN = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 200"><g fill="#f472b6" stroke="#1e293b" stroke-width="3" stroke-linejoin="round"><circle cx="50" cy="28" r="17"/><path d="M 52 14 Q 62 14 68 22 L 70 40 L 60 40" fill="#4b1a33" opacity="0.55"/><path d="M 34 48 Q 34 58 38 64 L 38 95 L 28 150 L 72 150 L 62 95 L 62 64 Q 66 58 66 48 Z"/><rect x="40" y="150" width="8" height="30" rx="3"/><rect x="52" y="150" width="8" height="30" rx="3"/><rect x="26" y="66" width="8" height="46" rx="3"/><rect x="66" y="66" width="8" height="46" rx="3"/></g></svg>`;

const SVG_CHILD = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 200"><g fill="#fde68a" stroke="#78350f" stroke-width="3" stroke-linejoin="round"><circle cx="50" cy="42" r="24"/><path d="M 36 68 Q 36 74 40 78 L 40 120 Q 40 126 44 126 L 56 126 Q 60 126 60 120 L 60 78 Q 64 74 64 68 Z"/><rect x="40" y="126" width="8" height="46" rx="3"/><rect x="52" y="126" width="8" height="46" rx="3"/><rect x="30" y="80" width="7" height="36" rx="3"/><rect x="63" y="80" width="7" height="36" rx="3"/></g></svg>`;

const SVG_BOX = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><g stroke="#1e293b" stroke-width="3" stroke-linejoin="round"><polygon points="20,50 60,30 100,50 100,95 60,115 20,95" fill="#c4b5fd"/><polyline points="20,50 60,70 100,50" fill="none"/><line x1="60" y1="70" x2="60" y2="115"/><line x1="60" y1="52" x2="60" y2="70" stroke-dasharray="3,3" opacity="0.6"/></g></svg>`;

const SVG_TABLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 100"><g stroke="#1e293b" stroke-width="3" stroke-linejoin="round"><rect x="10" y="30" width="120" height="16" rx="3" fill="#d97706"/><rect x="20" y="46" width="8" height="46" rx="2" fill="#92400e"/><rect x="112" y="46" width="8" height="46" rx="2" fill="#92400e"/><rect x="60" y="46" width="8" height="46" rx="2" fill="#92400e" opacity="0.7"/><rect x="72" y="46" width="8" height="46" rx="2" fill="#92400e" opacity="0.7"/></g></svg>`;

const SVG_CHAIR = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 140"><g stroke="#1e293b" stroke-width="3" stroke-linejoin="round"><rect x="24" y="20" width="52" height="50" rx="4" fill="#92400e"/><rect x="20" y="70" width="60" height="10" rx="2" fill="#78350f"/><rect x="22" y="80" width="8" height="50" rx="2" fill="#78350f"/><rect x="70" y="80" width="8" height="50" rx="2" fill="#78350f"/></g></svg>`;

const SVG_PLANT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 160"><g stroke="#14532d" stroke-width="3" stroke-linejoin="round"><path d="M 50 85 Q 22 60 30 30 Q 48 40 50 72 Q 52 40 70 30 Q 78 60 50 85 Z" fill="#34d399"/><line x1="50" y1="72" x2="50" y2="110" stroke-width="4"/><path d="M 28 110 L 72 110 L 66 145 L 34 145 Z" fill="#7c2d12"/></g></svg>`;

const SVG_CAR = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 100"><g stroke="#1e293b" stroke-width="3" stroke-linejoin="round"><path d="M 20 70 Q 30 40 75 38 L 110 38 Q 140 40 160 60 L 165 70 Z" fill="#ef4444"/><rect x="20" y="70" width="145" height="12" rx="3" fill="#ef4444"/><circle cx="50" cy="86" r="12" fill="#1e293b"/><circle cx="135" cy="86" r="12" fill="#1e293b"/><circle cx="50" cy="86" r="4" fill="#9ca3af"/><circle cx="135" cy="86" r="4" fill="#9ca3af"/><path d="M 55 45 L 100 45 L 98 62 L 60 62 Z" fill="#dbeafe" opacity="0.75"/></g></svg>`;

// ---------------------------------------------------------------------------
// Public registry — id → preset. Keep ids stable; BlueprintItem.presetId
// stores them.
// ---------------------------------------------------------------------------

export const BLUEPRINT_SPRITE_PRESETS: Record<string, BlueprintSpritePreset> = {
  man: { id: 'man', label: BLUEPRINT_PERSON_PRESET_LABELS.man, category: 'person', color: '#60a5fa', svg: SVG_MAN, heightMeters: 1.8, aspect: 100 / 200 },
  woman: { id: 'woman', label: BLUEPRINT_PERSON_PRESET_LABELS.woman, category: 'person', color: '#f472b6', svg: SVG_WOMAN, heightMeters: 1.7, aspect: 100 / 200 },
  child: { id: 'child', label: BLUEPRINT_PERSON_PRESET_LABELS.child, category: 'person', color: '#fde68a', svg: SVG_CHILD, heightMeters: 1.2, aspect: 100 / 200 },
  elder: { id: 'elder', label: BLUEPRINT_PERSON_PRESET_LABELS.elder, category: 'person', color: '#cbd5e1', svg: SVG_MAN, heightMeters: 1.62, aspect: 100 / 200 },
  tallMan: { id: 'tallMan', label: BLUEPRINT_PERSON_PRESET_LABELS.tallMan, category: 'person', color: '#38bdf8', svg: SVG_MAN, heightMeters: 2.05, aspect: 92 / 200 },
  shortMan: { id: 'shortMan', label: BLUEPRINT_PERSON_PRESET_LABELS.shortMan, category: 'person', color: '#93c5fd', svg: SVG_MAN, heightMeters: 1.5, aspect: 112 / 200 },
  heavyMan: { id: 'heavyMan', label: BLUEPRINT_PERSON_PRESET_LABELS.heavyMan, category: 'person', color: '#818cf8', svg: SVG_MAN, heightMeters: 1.76, aspect: 130 / 200 },
  slimWoman: { id: 'slimWoman', label: BLUEPRINT_PERSON_PRESET_LABELS.slimWoman, category: 'person', color: '#f9a8d4', svg: SVG_WOMAN, heightMeters: 1.72, aspect: 82 / 200 },
  tallWoman: { id: 'tallWoman', label: BLUEPRINT_PERSON_PRESET_LABELS.tallWoman, category: 'person', color: '#fb7185', svg: SVG_WOMAN, heightMeters: 1.9, aspect: 90 / 200 },
  box: { id: 'box', label: BLUEPRINT_OBJECT_PRESET_LABELS.box, category: 'object', color: '#a78bfa', svg: SVG_BOX, heightMeters: 1.0, aspect: 120 / 120 },
  table: { id: 'table', label: BLUEPRINT_OBJECT_PRESET_LABELS.table, category: 'object', color: '#d97706', svg: SVG_TABLE, heightMeters: 0.75, aspect: 140 / 100 },
  chair: { id: 'chair', label: BLUEPRINT_OBJECT_PRESET_LABELS.chair, category: 'object', color: '#92400e', svg: SVG_CHAIR, heightMeters: 0.9, aspect: 100 / 140 },
  plant: { id: 'plant', label: BLUEPRINT_OBJECT_PRESET_LABELS.plant, category: 'object', color: '#34d399', svg: SVG_PLANT, heightMeters: 1.4, aspect: 100 / 160 },
  car: { id: 'car', label: BLUEPRINT_OBJECT_PRESET_LABELS.car, category: 'object', color: '#ef4444', svg: SVG_CAR, heightMeters: 1.5, aspect: 180 / 100 },
  sofa: { id: 'sofa', label: BLUEPRINT_OBJECT_PRESET_LABELS.sofa, category: 'object', color: '#f59e0b', svg: SVG_CHAIR, heightMeters: 0.9, aspect: 180 / 110 },
  lamp: { id: 'lamp', label: BLUEPRINT_OBJECT_PRESET_LABELS.lamp, category: 'object', color: '#fde047', svg: SVG_PLANT, heightMeters: 1.65, aspect: 70 / 160 },
  door: { id: 'door', label: BLUEPRINT_OBJECT_PRESET_LABELS.door, category: 'object', color: '#a16207', svg: SVG_BOX, heightMeters: 2.1, aspect: 70 / 200 },
  window: { id: 'window', label: BLUEPRINT_OBJECT_PRESET_LABELS.window, category: 'object', color: '#7dd3fc', svg: SVG_BOX, heightMeters: 1.2, aspect: 140 / 100 },
  bed: { id: 'bed', label: BLUEPRINT_OBJECT_PRESET_LABELS.bed, category: 'object', color: '#c084fc', svg: SVG_TABLE, heightMeters: 1, aspect: 180 / 100 },
  phone: { id: 'phone', label: BLUEPRINT_OBJECT_PRESET_LABELS.phone, category: 'object', color: '#94a3b8', svg: SVG_BOX, heightMeters: 0.155, aspect: 60 / 120 },
  cup: { id: 'cup', label: BLUEPRINT_OBJECT_PRESET_LABELS.cup, category: 'object', color: '#f8fafc', svg: SVG_BOX, heightMeters: 0.11, aspect: 80 / 100 },
};

/** Canonical meter heights for procedural models without a legacy sprite. */
export const BLUEPRINT_OBJECT_HEIGHT_METERS: Readonly<Record<string, number>> = {
  cube: 1, sphere: 1, cylinder: 1, cone: 1, torus: 1,
  plane: 0.04, disc: 0.06, ramp: 1, pipe: 0.6, terrain: 1.6,
  'generic-object': 1,
  desk: 0.75, 'office-chair': 1.15, 'ergonomic-chair': 1.15,
  'folding-chair': 0.9, 'official-chair': 1.1, stool: 0.45, 'drum-stool': 0.45,
  cabinet: 1.8, bookshelf: 1.8, screen: 1.7,
  'floor-lamp': 1.65, 'table-lamp': 0.5, laptop: 0.23,
  suitcase: 0.69, 'monitor-tv': 1.05,
  book: 0.03, bottle: 0.3, backpack: 0.48, umbrella: 1.15, guitar: 1.12,
  'camera-tripod': 1.6, 'crate-stack': 1.2,
  knife: 0.34, sword: 0.87, 'pistol-prop': 0.14, 'food-plate': 0.085,
  shield: 1, bow: 1.2,
  'wall-segment': 2.7, 'wall-doorway': 2.7, 'wall-window': 2.7,
  'floor-slab': 0.2, stairs: 2.1, column: 2.7, railing: 1.1, archway: 2.9,
  'road-segment': 0.112, crosswalk: 0.112, 'street-lamp': 4,
  'traffic-light': 3.2, bench: 0.85, 'bus-stop': 2.52,
  'trash-bin': 0.86, 'fire-hydrant': 0.75, 'road-sign': 2.75,
  'tree-deciduous': 5, 'tree-pine': 4.5, bush: 1, rock: 1.2,
  'grass-patch': 0.23, pond: 0.095, hill: 1.6,
  'ground-scene': 1, 'aerial-scene': 3.5,
  'scene-living-room': 2.8, 'scene-kitchen': 2.8, 'scene-bedroom': 2.8,
  'scene-office': 2.8, 'scene-classroom': 2.8, 'scene-hospital-room': 2.8,
  'scene-shop-cafe': 2.8, 'scene-restaurant': 2.8,
  'scene-street-corner': 4.22, 'scene-parking-lot': 1.6, 'scene-park-path': 5.1,
  'scene-warehouse': 4.2, 'scene-house-exterior': 5.8, 'scene-apartment-exterior': 12,
  'scene-villa-01': 7.8, 'scene-villa-02': 7.8, 'scene-city-cluster': 15.15,
  'scene-octagonal-tower': 10, 'scene-city-gate': 5.825, 'scene-city-wall': 4.65,
  'scene-main-hall': 5.8, 'scene-paifang': 5.825,
  'scene-building-01': 15.15, 'scene-building-02': 15.15,
  'scene-concept-scene': 15.15, 'scene-concept-scene-01': 15.15,
  'vehicle-sedan': 1.5, 'vehicle-sedan-01': 1.5, 'vehicle-suv': 1.8,
  'vehicle-taxi': 1.66, 'vehicle-police-car': 1.62,
  'vehicle-van': 2.5, 'vehicle-ambulance': 2.63, 'vehicle-bus': 3.2,
  'vehicle-truck': 3.48, 'vehicle-subway-car': 3.6, 'vehicle-locomotive': 4.2,
  'vehicle-bicycle': 1.08, 'vehicle-motorcycle': 1.08, 'vehicle-e-scooter': 1.08,
  'vehicle-helicopter': 3.2, 'vehicle-airplane': 3,
  'vehicle-boat': 1.125, 'vehicle-yacht': 3.5, 'vehicle-ship': 5.3,
  'vehicle-submarine': 4.46, 'vehicle-tank': 2.4, 'vehicle-sedan-chair': 1.825,
};

const catalogByPreset = Object.fromEntries(DIRECTOR_STUDIO_MODEL_CATALOG.map((model) => [model.presetId, model]));
for (const [id, heightMeters] of Object.entries(BLUEPRINT_OBJECT_HEIGHT_METERS)) {
  const model = catalogByPreset[id];
  BLUEPRINT_SPRITE_PRESETS[id] = {
    id, label: DIRECTOR_STUDIO_MODEL_LABELS[id] ?? id, category: 'object',
    color: model?.color ?? '#94a3b8', svg: SVG_BOX, heightMeters, aspect: 1,
  };
}

/** Build a reusable Three.js sprite from a preset id. Returns null if the
 *  id doesn't exist in the registry. Caller owns the returned Sprite +
 *  SpriteMaterial and should dispose them on unmount / replacement. */
export function svgPresetToDataUrl(id: string): string | null {
  const preset = BLUEPRINT_SPRITE_PRESETS[id];
  if (!preset) return null;
  return `data:image/svg+xml;utf8,${encodeURIComponent(preset.svg)}`;
}
