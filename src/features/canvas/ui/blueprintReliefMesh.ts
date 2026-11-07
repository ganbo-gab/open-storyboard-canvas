import * as THREE from 'three';
import {
  depthReliefParametersSchema,
  type DepthReliefMap,
  type DepthReliefParameters,
} from '@/features/stage/domain/depthRelief';
import { BLUEPRINT_PRESERVE_MATERIAL_COLOR } from './blueprintMeshFactory';

type ReliefImage = CanvasImageSource & { readonly width: number; readonly height: number };
type Group = InstanceType<typeof THREE.Group>;

export interface DepthReliefMeshParameters extends DepthReliefParameters {
  /** Maximum normalized inverse-depth span within a triangle. Larger jumps leave holes. */
  discontinuityThreshold?: number;
}

function validateDepth(depth: DepthReliefMap): void {
  if (!Number.isInteger(depth.width) || !Number.isInteger(depth.height)
    || depth.width < 1 || depth.height < 1 || depth.data.length !== depth.width * depth.height) {
    throw new Error('Invalid relief depth dimensions');
  }
  for (const value of depth.data) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Relief inverse depth must be in [0, 1]');
  }
}

/**
 * Builds a pinhole-projected 2.5D backdrop, not reconstructed metric geometry.
 * widthM is the front image-plane width; distant pixels expand along camera rays.
 * The source camera looks down -Z; the image faces +Z. No resources are borrowed.
 */
export function createDepthReliefMesh(
  image: ReliefImage,
  depth: DepthReliefMap,
  params: DepthReliefMeshParameters,
): Group {
  const { discontinuityThreshold = 0.15 } = params;
  const { widthM, depthM, fovDeg, segments } = depthReliefParametersSchema.parse({
    widthM: params.widthM, depthM: params.depthM, fovDeg: params.fovDeg, segments: params.segments,
  });
  if (!Number.isFinite(image.width) || !Number.isFinite(image.height) || image.width <= 0 || image.height <= 0) {
    throw new Error('Invalid relief image dimensions');
  }
  if (!Number.isFinite(discontinuityThreshold) || discontinuityThreshold <= 0 || discontinuityThreshold > 1) {
    throw new Error('Relief discontinuity threshold must be in (0, 1]');
  }
  validateDepth(depth);

  const aspect = image.width / image.height;
  const heightM = widthM / aspect;
  const rows = Math.max(1, Math.min(512, Math.round(segments / aspect)));
  const columns = segments;
  const count = (columns + 1) * (rows + 1);
  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const samples = new Float32Array(count);
  const cameraDistance = heightM / (2 * Math.tan(fovDeg * Math.PI / 360));
  let lowestY = Infinity;

  for (let row = 0; row <= rows; row += 1) {
    const v = row / rows;
    const sourceY = Math.min(depth.height - 1, Math.round(v * (depth.height - 1)));
    for (let column = 0; column <= columns; column += 1) {
      const u = column / columns;
      const index = row * (columns + 1) + column;
      // Nearest sampling deliberately preserves occlusion edges instead of smearing a ramp across them.
      const sourceX = Math.min(depth.width - 1, Math.round(u * (depth.width - 1)));
      const inverseDepth = depth.data[sourceY * depth.width + sourceX];
      const distance = (1 - inverseDepth) * depthM;
      const rayScale = (cameraDistance + distance) / cameraDistance;
      samples[index] = inverseDepth;
      positions[index * 3] = (u - 0.5) * widthM * rayScale;
      positions[index * 3 + 1] = (0.5 - v) * heightM * rayScale;
      positions[index * 3 + 2] = -distance;
      lowestY = Math.min(lowestY, positions[index * 3 + 1]);
      uvs[index * 2] = u;
      uvs[index * 2 + 1] = 1 - v;
    }
  }
  for (let index = 0; index < count; index += 1) positions[index * 3 + 1] -= lowestY;

  const indices: number[] = [];
  const addTriangle = (a: number, b: number, c: number) => {
    const span = Math.max(samples[a], samples[b], samples[c]) - Math.min(samples[a], samples[b], samples[c]);
    if (depthM === 0 || span <= discontinuityThreshold) indices.push(a, b, c);
  };
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const a = row * (columns + 1) + column;
      const b = a + 1;
      const c = a + columns + 1;
      const d = c + 1;
      addTriangle(a, c, b);
      addTriangle(b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const texture = new THREE.Texture(image);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, toneMapped: false });
  material.userData[BLUEPRINT_PRESERVE_MATERIAL_COLOR] = true;
  // Existing scene teardown disposes materials directly; make that release the owned texture too.
  let textureDisposed = false;
  material.addEventListener('dispose', () => {
    if (!textureDisposed) { textureDisposed = true; texture.dispose(); }
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  const group = new THREE.Group();
  group.name = 'depth-relief';
  group.add(mesh);
  return group;
}

const disposed = new WeakSet<Group>();

/** Releases only the group's owned GPU resources, never the caller's image bitmap. */
export function disposeDepthReliefMesh(group: Group): void {
  if (disposed.has(group)) return;
  disposed.add(group);
  group.traverse((object: InstanceType<typeof THREE.Object3D>) => {
    if (!object.isMesh) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) material.dispose();
  });
  group.clear();
}
