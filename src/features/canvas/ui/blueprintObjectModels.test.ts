import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { DIRECTOR_STUDIO_MODEL_CATALOG, DIRECTOR_STUDIO_MODEL_LABELS } from '@/features/canvas/domain/directorStudioModelCatalog';
import en from '@/i18n/locales/en.json';
import zh from '@/i18n/locales/zh.json';
import { createObjectMeshGroup } from './blueprintMeshFactory';
import { BLUEPRINT_SPRITE_PRESETS } from './blueprintPresets';

const objects = DIRECTOR_STUDIO_MODEL_CATALOG.filter((model) => model.itemCategory !== 'person');
const built: InstanceType<typeof THREE.Group>[] = [];

function build(presetId: string, height?: number) {
  const meters = height ?? BLUEPRINT_SPRITE_PRESETS[presetId]?.heightMeters;
  if (!meters) throw new Error(`Missing physical size for ${presetId}`);
  const group = createObjectMeshGroup('#60a5fa', meters, presetId);
  built.push(group);
  return group;
}

function meshes(group: InstanceType<typeof THREE.Group>) {
  const result: InstanceType<typeof THREE.Mesh>[] = [];
  group.traverse((node: InstanceType<typeof THREE.Mesh>) => {
    if (node.isMesh) result.push(node);
  });
  return result;
}

afterEach(() => {
  const geometries = new Set<InstanceType<typeof THREE.BufferGeometry>>();
  const materials = new Set<InstanceType<typeof THREE.Material>>();
  for (const group of built) for (const mesh of meshes(group)) {
    geometries.add(mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
  }
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  built.length = 0;
});

describe('Director Studio physical object library', () => {
  it.each(objects)('$presetId builds at canonical meter scale without the generic fallback', (model) => {
    const preset = BLUEPRINT_SPRITE_PRESETS[model.presetId];
    expect(preset, 'Every selectable model needs explicit size metadata').toBeDefined();
    const group = build(model.presetId);
    const bounds = new THREE.Box3().setFromObject(group);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const children = meshes(group);
    expect(group.userData.blueprintGenericFallback).toBe(false);
    expect(children.length).toBeGreaterThan(0);
    expect(children.length).toBeLessThan(120);
    expect(Math.abs(size.y / preset.heightMeters - 1)).toBeLessThan(0.15);
    // Also check the unscaled recipe, so a bad registry height cannot be hidden
    // by the factory's supported uniform height override.
    expect(Math.abs(group.userData.blueprintNativeHeightMeters / preset.heightMeters - 1)).toBeLessThan(0.15);
    expect(bounds.min.y).toBeCloseTo(0, 5);
    expect(center.x).toBeCloseTo(0, 5);
    expect(center.z).toBeCloseTo(0, 5);
    expect(Number.isFinite(size.x + size.y + size.z)).toBe(true);
    for (const mesh of children) {
      expect(mesh.receiveShadow).toBe(true);
      expect(mesh.castShadow).toBe(!mesh.userData.blueprintGround);
    }
  });

  const catalogPresets = Object.fromEntries(DIRECTOR_STUDIO_MODEL_CATALOG.map((model) => [model.presetId, true]));
  const legacyIds = Object.keys(DIRECTOR_STUDIO_MODEL_LABELS).filter((id) => !id.startsWith('person-') && !catalogPresets[id]);
  it.each(legacyIds)('keeps legacy preset %s recognizable and physically sized', (id) => {
    const group = build(id);
    expect(group.userData.blueprintGenericFallback).toBe(false);
    expect(meshes(group).length).toBeGreaterThan(1);
    expect(meshes(group).length).toBeLessThan(120);
    const size = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
    expect(size.y).toBeCloseTo(BLUEPRINT_SPRITE_PRESETS[id].heightMeters, 4);
  });

  it('provides both language labels for every selectable model and category', () => {
    for (const model of DIRECTOR_STUDIO_MODEL_CATALOG) {
      for (const locale of [en, zh]) {
        const labels = locale.directorStudio.modelLibrary.models as Record<string, { name: string; labelBase: string }>;
        expect(labels[model.id]?.name, model.id).toBeTruthy();
        expect(labels[model.id]?.labelBase, model.id).toBeTruthy();
        expect(locale.directorStudio.modelLibrary.categories).toHaveProperty(model.categoryId);
      }
    }
  });

  it('uses a 5 by 4 meter cutaway room with 2.7 meter walls', () => {
    const group = build('scene-living-room');
    const size = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
    expect(size.x).toBeCloseTo(5, 3);
    expect(size.z).toBeCloseTo(4, 3);
    expect(size.y).toBeCloseTo(2.8, 3);
    const walls = meshes(group).filter((mesh) => mesh.geometry.parameters?.height === 2.7);
    expect(walls).toHaveLength(2);
  });

  it('keeps seats at 45 cm, tables at 75 cm, and doors 2.1 by 0.9 meters', () => {
    const chair = build('chair');
    const seat = meshes(chair).find((mesh) => mesh.geometry.parameters?.width === 0.46 && mesh.geometry.parameters?.height === 0.06);
    const seatBounds = new THREE.Box3().setFromObject(seat);
    expect(seatBounds.max.y).toBeCloseTo(0.45, 3);
    const table = new THREE.Box3().setFromObject(build('table')).getSize(new THREE.Vector3());
    expect(table.y).toBeCloseTo(0.75, 3);
    const door = new THREE.Box3().setFromObject(build('door')).getSize(new THREE.Vector3());
    expect(door.y).toBeCloseTo(2.1, 3);
    expect(door.x).toBeCloseTo(0.9, 3);
  });

  it('makes cars and buses full length with headlights facing +Z', () => {
    for (const [id, length] of [['vehicle-sedan', 4.5], ['vehicle-bus', 11]] as const) {
      const group = build(id);
      const size = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
      expect(size.z).toBeGreaterThanOrEqual(length);
      expect(size.z).toBeLessThan(length * 1.05);
      const headlights = meshes(group).filter((mesh) => mesh.material.emissive?.getHexString() === 'fef3c7');
      expect(headlights).toHaveLength(2);
      for (const light of headlights) expect(light.getWorldPosition(new THREE.Vector3()).z).toBeGreaterThan(0);
    }
  });

  it('uses a closed wedge, open shelving, transparent glass, and emissive bulbs', () => {
    const ramp = meshes(build('ramp'));
    expect(ramp).toHaveLength(1);
    expect(ramp[0].geometry.type).toBe('ExtrudeGeometry');
    expect(ramp[0].rotation.x).toBe(0);
    expect(ramp[0].rotation.z).toBe(0);
    const shelf = build('bookshelf');
    shelf.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(new THREE.Vector3(0.35, 1.6, 2), new THREE.Vector3(0, 0, -1));
    expect(ray.intersectObject(shelf, true)).toHaveLength(0);
    const glass = meshes(build('window')).filter((mesh) => mesh.material.transparent);
    expect(glass.length).toBeGreaterThan(0);
    for (const pane of glass) expect(pane.material.opacity).toBeLessThan(0.35);
    for (const id of ['floor-lamp', 'table-lamp', 'street-lamp']) {
      expect(meshes(build(id)).some((mesh) => mesh.material.emissiveIntensity > 0)).toBe(true);
    }
  });

  it('makes cafe and restaurant layouts distinct and both generic scene types explicit', () => {
    const cafe = meshes(build('scene-shop-cafe'));
    const restaurant = meshes(build('scene-restaurant'));
    expect(cafe.length).not.toBe(restaurant.length);
    for (const id of ['ground-scene', 'aerial-scene']) {
      const group = build(id);
      expect(group.userData.blueprintGenericFallback).toBe(false);
      expect(meshes(group).length).toBeGreaterThan(2);
    }
  });

  it('uniformly scales an explicitly overridden height and keeps floor-center', () => {
    const natural = build('door');
    const doubled = build('door', 4.2);
    const a = new THREE.Box3().setFromObject(natural).getSize(new THREE.Vector3());
    const bounds = new THREE.Box3().setFromObject(doubled);
    const b = bounds.getSize(new THREE.Vector3());
    expect(b.x / a.x).toBeCloseTo(2);
    expect(b.y / a.y).toBeCloseTo(2);
    expect(b.z / a.z).toBeCloseTo(2);
    expect(bounds.min.y).toBeCloseTo(0);
  });
});
