import { useEffect, useState } from 'react';
import { Box, Building2, Car, Leaf, Shapes, UserRound } from 'lucide-react';
import * as THREE from 'three';

import type { DirectorStudioModelCatalogItem } from '@/features/canvas/domain/directorStudioModelCatalog';
import { createObjectMeshGroup } from './blueprintMeshFactory';
import { createPersonMeshGroup } from './personRig';
import { BLUEPRINT_SPRITE_PRESETS } from './blueprintPresets';

interface DirectorStudioModelThumbnailProps {
  model: DirectorStudioModelCatalogItem;
}

// One lazy context for the entire library, never one renderer per card.
let thumbnailRenderer: InstanceType<typeof THREE.WebGLRenderer> | null | undefined;
const thumbnailCache = new Map<string, string>();

function renderModelThumbnail(model: DirectorStudioModelCatalogItem): string | null {
  const key = `${model.presetId}:${model.color}:${JSON.stringify(model.bodyControls ?? null)}`;
  const cached = thumbnailCache.get(key);
  if (cached) return cached;
  if (thumbnailRenderer === null || typeof document === 'undefined') return null;
  // Avoid jsdom's unimplemented getContext and support browsers without WebGL.
  if (typeof WebGL2RenderingContext === 'undefined') return null;
  if (thumbnailRenderer === undefined) {
    try {
      thumbnailRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
      thumbnailRenderer.setSize(240, 180, false);
      thumbnailRenderer.setPixelRatio(1);
      thumbnailRenderer.setClearColor(0x000000, 0);
      thumbnailRenderer.outputColorSpace = THREE.SRGBColorSpace;
      thumbnailRenderer.domElement.addEventListener('webglcontextlost', () => {
        thumbnailRenderer?.dispose();
        thumbnailRenderer = null;
      });
    } catch {
      thumbnailRenderer = null;
      return null;
    }
  }
  const renderer = thumbnailRenderer;
  const height = BLUEPRINT_SPRITE_PRESETS[model.presetId]?.heightMeters ?? 1.75;
  const mesh = model.itemCategory === 'person'
    ? createPersonMeshGroup(model.color, height, model.presetId, model.bodyControls)
    : createObjectMeshGroup(model.color, height, model.presetId);
  const scene = new THREE.Scene();
  scene.add(mesh);
  scene.add(new THREE.HemisphereLight('#ffffff', '#64748b', 2.4));
  const keyLight = new THREE.DirectionalLight('#ffffff', 3.2);
  keyLight.position.set(4, 7, 5);
  scene.add(keyLight);
  const bounds = new THREE.Box3().setFromObject(mesh);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 0.01);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, radius * 0.01, radius * 12);
  // Positive X/+Z sees into the open front and right of every room shell.
  camera.position.copy(center).add(new THREE.Vector3(1.3, 1, 1.6).normalize().multiplyScalar(radius * 5));
  camera.lookAt(center);
  camera.updateMatrixWorld(true);
  const view = bounds.clone().applyMatrix4(camera.matrixWorldInverse);
  const halfHeight = Math.max((view.max.y - view.min.y) / 2, (view.max.x - view.min.x) / 2 / (4 / 3), 0.01) * 1.12;
  const viewCenter = view.getCenter(new THREE.Vector3());
  camera.left = viewCenter.x - halfHeight * 4 / 3;
  camera.right = viewCenter.x + halfHeight * 4 / 3;
  camera.top = viewCenter.y + halfHeight;
  camera.bottom = viewCenter.y - halfHeight;
  camera.updateProjectionMatrix();
  try {
    renderer.render(scene, camera);
    const dataUrl = renderer.domElement.toDataURL('image/png');
    thumbnailCache.set(key, dataUrl);
    return dataUrl;
  } catch {
    return null;
  } finally {
    const geometries = new Set<InstanceType<typeof THREE.BufferGeometry>>();
    const materials = new Set<InstanceType<typeof THREE.Material>>();
    mesh.traverse((node: { isMesh?: boolean; geometry?: InstanceType<typeof THREE.BufferGeometry>; material?: InstanceType<typeof THREE.Material> | InstanceType<typeof THREE.Material>[] }) => {
      if (!node.isMesh) return;
      if (node.geometry) geometries.add(node.geometry);
      const nodeMaterials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of nodeMaterials) if (material) materials.add(material);
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    scene.clear();
    renderer.renderLists.dispose();
  }
}

export function DirectorStudioModelThumbnail({ model }: DirectorStudioModelThumbnailProps) {
  const [thumbnail, setThumbnail] = useState<{ key: string; url: string } | null>(null);
  const key = `${model.presetId}:${model.color}:${JSON.stringify(model.bodyControls ?? null)}`;
  useEffect(() => {
    const url = renderModelThumbnail(model);
    setThumbnail(url ? { key, url } : null);
  }, [key, model]);
  const url = thumbnail?.key === key ? thumbnail.url : undefined;
  if (url) return <img src={url} alt="" aria-hidden="true" className="h-full w-full object-contain" draggable={false} />;

  const Icon = model.itemCategory === 'person' ? UserRound
    : model.categoryId === 'nature' ? Leaf
      : model.categoryId === 'vehicles' ? Car
        : model.categoryId === 'architecture' || model.categoryId === 'scenes' ? Building2
          : model.categoryId === 'basic' ? Shapes : Box;
  return (
    <div className="flex h-full w-full items-center justify-center" aria-hidden="true">
      <Icon className="h-12 w-12" strokeWidth={1.5} style={{ color: model.color }} />
    </div>
  );
}
