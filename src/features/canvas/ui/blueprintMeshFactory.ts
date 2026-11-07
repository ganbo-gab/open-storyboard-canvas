import * as THREE from 'three';


export const BLUEPRINT_PRESERVE_MATERIAL_COLOR = 'blueprintPreserveMaterialColor';

function preserveMaterialColor<T extends { userData: Record<string, unknown> }>(material: T): T {
  material.userData[BLUEPRINT_PRESERVE_MATERIAL_COLOR] = true;
  return material;
}

export function createPreservedMaterial(
  color: string | number | { r: number; g: number; b: number },
  options: { roughness?: number; metalness?: number; emissive?: string | number; emissiveIntensity?: number; transparent?: boolean; opacity?: number; depthWrite?: boolean } = {},
) {
  return preserveMaterialColor(new THREE.MeshStandardMaterial({
    color, roughness: 0.68, metalness: 0.04, ...options,
  }));
}

type ObjectPoint = [number, number, number];

function addObjectMesh(group: InstanceType<typeof THREE.Group>, material: InstanceType<typeof THREE.Material>, geometry: InstanceType<typeof THREE.BufferGeometry>, position: ObjectPoint) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

function addBox(group: InstanceType<typeof THREE.Group>, material: InstanceType<typeof THREE.Material>, size: ObjectPoint, position: ObjectPoint) {
  return addObjectMesh(group, material, new THREE.BoxGeometry(...size), position);
}

function addCylinder(group: InstanceType<typeof THREE.Group>, material: InstanceType<typeof THREE.Material>, top: number, bottom: number, height: number, position: ObjectPoint, segments = 24) {
  return addObjectMesh(group, material, new THREE.CylinderGeometry(top, bottom, height, segments), position);
}

function addObjectBeam(group: InstanceType<typeof THREE.Group>, material: InstanceType<typeof THREE.Material>, start: ObjectPoint, end: ObjectPoint, radius = 0.025) {
  const a = new THREE.Vector3(...start);
  const b = new THREE.Vector3(...end);
  const direction = b.clone().sub(a);
  const mesh = addCylinder(group, material, radius, radius, direction.length(), a.clone().add(b).multiplyScalar(0.5).toArray(), 12);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  return mesh;
}

/**
 * Procedural blocking models, authored in real-world meters, facing +Z.
 * heightM is the TOTAL bounding-box height, not a tabletop/seat elevation.
 * Recipes have canonical real dimensions; the final uniform scale honors a
 * caller-supplied height without distorting proportions. Registry heights in
 * blueprintPresets.ts select that canonical size. Every origin is floor-center.
 * Ground/slab meshes receive shadows only; all other meshes cast and receive.
 */
export function createObjectMeshGroup(color: string | number | { r: number; g: number; b: number }, heightM: number, presetId: string | undefined): InstanceType<typeof THREE.Group> {
  const group = new THREE.Group();
  group.name = presetId ?? 'generic-object';
  group.userData.blueprintPresetId = presetId;
  group.userData.blueprintGenericFallback = false;
  const materials = new Map<string, InstanceType<typeof THREE.MeshStandardMaterial>>();
  const primary = new THREE.MeshStandardMaterial({ color, roughness: 0.65, metalness: 0.04 });
  const material = (shade: string, kind: 'solid' | 'glass' | 'light' = 'solid') => {
    const key = `${shade}:${kind}`;
    if (!materials.has(key)) {
      materials.set(key, createPreservedMaterial(shade, kind === 'glass'
        ? { transparent: true, opacity: 0.22, depthWrite: false, roughness: 0.12, metalness: 0.08 }
        : kind === 'light' ? { emissive: shade, emissiveIntensity: 0.8, roughness: 0.28 } : {}));
    }
    return materials.get(key);
  };
  const box = (size: ObjectPoint, position: ObjectPoint, mat = primary) => addBox(group, mat, size, position);
  const cylinder = (top: number, bottom: number, h: number, position: ObjectPoint, mat = primary, segments = 24) => addCylinder(group, mat, top, bottom, h, position, segments);
  const ellipsoid = (size: ObjectPoint, position: ObjectPoint, mat = primary, segments = 24) => {
    const mesh = addObjectMesh(group, mat, new THREE.SphereGeometry(1, segments, 16), position);
    mesh.scale.set(...size);
    return mesh;
  };
  const beam = (a: ObjectPoint, b: ObjectPoint, radius = 0.025, mat = primary) => addObjectBeam(group, mat, a, b, radius);
  const ground = (w: number, d: number, h = 0.1, mat = primary, x = 0, z = 0) => {
    const mesh = box([w, h, d], [x, h / 2, z], mat);
    mesh.castShadow = false;
    mesh.userData.blueprintGround = true;
    return mesh;
  };
  const place = (id: string, h: number, x: number, z: number, y = 0, rotation = 0) => {
    const child = createObjectMeshGroup(color, h, id);
    child.position.set(x, y, z);
    child.rotation.y = rotation;
    group.add(child);
    return child;
  };
  const windowFrame = (w: number, h: number, x: number, y: number, z: number) => {
    const frame = material('#475569');
    box([w - 0.08, h - 0.08, 0.018], [x, y, z], material('#bae6fd', 'glass'));
    for (const side of [-1, 1]) {
      box([0.045, h, 0.09], [x + side * (w - 0.045) / 2, y, z], frame);
      box([w, 0.045, 0.09], [x, y + side * (h - 0.045) / 2, z], frame);
    }
    box([0.035, h - 0.08, 0.09], [x, y, z], frame);
  };
  const roomShell = (w = 5, d = 4, h = 2.7) => {
    ground(w, d);
    box([w, h, 0.12], [0, 0.1 + h / 2, -d / 2 + 0.06]);
    box([0.12, h, d - 0.12], [-w / 2 + 0.06, 0.1 + h / 2, 0.06]);
    box([w - 0.12, 0.1, 0.035], [0.06, 0.15, -d / 2 + 0.14], material('#cbd5e1'));
  };
  const wheel = (x: number, z: number, r: number, width = 0.2) => {
    const tire = cylinder(r, r, width, [x, r, z], material('#172033'), 32);
    tire.rotation.z = Math.PI / 2;
    const hub = cylinder(r * 0.45, r * 0.45, width + 0.015, [x, r, z], material('#94a3b8'), 20);
    hub.rotation.z = Math.PI / 2;
  };
  const lights = (w: number, length: number, y: number) => {
    for (const side of [-1, 1]) {
      box([0.28, 0.14, 0.035], [side * w * 0.32, y, length / 2], material('#fef3c7', 'light'));
      box([0.24, 0.13, 0.035], [side * w * 0.32, y, -length / 2], material('#ef4444', 'light'));
    }
  };
  const car = (w = 1.8, length = 4.5, h = 1.5) => {
    box([w, 0.65, length], [0, 0.65, 0]);
    // A glazed cabin with separate roof/pillars, not an opaque window box.
    box([w * 0.88, 0.08, length * 0.48], [0, h - 0.04, -0.2]);
    box([w * 0.86, h - 0.97, length * 0.47], [0, (h + 0.97) / 2, -0.2], material('#bae6fd', 'glass'));
    for (const side of [-1, 1]) {
      for (const z of [-length * 0.28, length * 0.2]) box([0.06, h - 0.95, 0.07], [side * w * 0.43, (h + 0.95) / 2, z]);
      box([0.05, 0.4, 0.05], [side * w * 0.44, 1.16, -0.2]);
      box([0.16, 0.025, 0.04], [side * w * 0.51, 0.93, 0.1], material('#cbd5e1'));
      for (const z of [-length * 0.32, length * 0.32]) wheel(side * w * 0.49, z, 0.32);
    }
    lights(w, length, 0.7);
  };
  const road = (crosswalk = false) => {
    ground(7, 10, 0.1, material('#475569'));
    if (crosswalk) {
      for (let x = -2.7; x < 3; x += 0.9) box([0.45, 0.012, 3], [x, 0.106, 0], material('#f8fafc'));
    } else {
      for (const z of [-3.3, 0, 3.3]) box([0.12, 0.012, 1.7], [0, 0.106, z], material('#f8fafc'));
    }
  };
  const id = presetId ?? 'generic-object';
  if (id.startsWith('scene-')) {
    const scene = id.slice(6);
    const rooms = ['living-room', 'kitchen', 'bedroom', 'office', 'classroom', 'hospital-room', 'shop-cafe', 'restaurant'];
    if (rooms.includes(scene)) {
      roomShell();
      if (scene === 'living-room') {
        place('sofa', 0.9, -0.6, -0.9, 0.1);
        place('table', 0.45, -0.6, 0.55, 0.1);
        place('monitor-tv', 1.05, 1.3, -1.55, 0.1);
        place('plant', 1.4, 1.7, 1.2, 0.1);
      } else if (scene === 'kitchen') {
        box([3, 0.85, 0.65], [-0.6, 0.525, -1.5], material('#f8fafc'));
        box([3.1, 0.05, 0.72], [-0.6, 0.975, -1.5], material('#475569'));
        box([0.8, 1.9, 0.72], [1.5, 1.05, -1.5], material('#cbd5e1'));
        for (const x of [-1.3, -0.5, 0.3]) box([0.65, 0.65, 0.32], [x, 2, -1.7], material('#f8fafc'));
        box([0.65, 0.025, 0.4], [-1.2, 1.01, -1.5], material('#94a3b8'));
        for (const x of [-0.15, 0.15]) for (const z of [-1.35, -1.65]) cylinder(0.1, 0.1, 0.018, [x, 1.01, z], material('#111827'));
        beam([-1.4, 1, -1.7], [-1.4, 1.3, -1.7], 0.025, material('#94a3b8'));
      } else if (scene === 'bedroom') {
        place('bed', 1, -0.5, -0.25, 0.1);
        place('cabinet', 1.8, 1.7, -1.2, 0.1);
        place('table', 0.55, -1.7, -0.9, 0.1);
        place('table-lamp', 0.45, -1.7, -0.9, 0.65);
      } else if (scene === 'office' || scene === 'classroom') {
        box([2.6, 1, 0.06], [0, 1.85, -1.83], material(scene === 'classroom' ? '#14532d' : '#334155'));
        for (const z of scene === 'classroom' ? [-0.5, 1] : [0.3]) for (const x of [-1.15, 1.05]) {
          place('desk', 0.75, x, z, 0.1);
          place('chair', 0.9, x, z + 0.65, 0.1, Math.PI);
        }
      } else if (scene === 'hospital-room') {
        place('bed', 1, -0.7, 0, 0.1);
        for (const x of [-1.42, 0.02]) box([0.035, 0.25, 1.8], [x, 0.95, 0], material('#94a3b8'));
        beam([0.7, 0.1, -0.5], [0.7, 2.2, -0.5], 0.025, material('#94a3b8'));
        box([0.16, 0.3, 0.08], [0.7, 1.9, -0.5], material('#bae6fd', 'glass'));
        box([0.42, 0.12, 0.035], [1.25, 1.7, -1.8], material('#ef4444'));
        box([0.12, 0.42, 0.035], [1.25, 1.7, -1.8], material('#ef4444'));
      } else if (scene === 'shop-cafe') {
        box([3, 1, 0.7], [-0.5, 0.6, -1.15], material('#92400e'));
        box([3.1, 0.06, 0.82], [-0.5, 1.13, -1.15], material('#334155'));
        box([0.6, 0.42, 0.4], [-1.2, 1.37, -1.15], material('#94a3b8'));
        for (const x of [-1.3, 0.8]) {
          cylinder(0.36, 0.36, 0.05, [x, 0.825, 0.85], material('#92400e'));
          cylinder(0.045, 0.045, 0.7, [x, 0.45, 0.85], material('#475569'));
          cylinder(0.25, 0.25, 0.04, [x, 0.12, 0.85], material('#475569'));
          place('stool', 0.45, x + 0.55, 0.85, 0.1);
          place('cup', 0.11, x, 0.85, 0.85);
        }
      } else {
        for (const x of [-1.2, 1]) {
          place('table', 0.75, x, 0.1, 0.1);
          for (const z of [-0.7, 0.9]) place('chair', 0.9, x, z, 0.1, z > 0 ? Math.PI : 0);
          for (const z of [-0.15, 0.35]) place('food-plate', 0.07, x, z, 0.85);
        }
        box([3.6, 0.9, 0.5], [0, 0.55, -1.6], material('#78350f'));
        for (const x of [-1.2, 1.2]) {
          beam([x, 2.8, 0.1], [x, 2.3, 0.1], 0.012, material('#475569'));
          cylinder(0.14, 0.24, 0.2, [x, 2.25, 0.1]);
          ellipsoid([0.07, 0.07, 0.07], [x, 2.15, 0.1], material('#fef3c7', 'light'));
        }
      }
    } else if (scene === 'street-corner') {
      road(true);
      ground(2, 10, 0.22, material('#cbd5e1'), -4.5);
      place('street-lamp', 4, -4.4, -2, 0.22);
      place('traffic-light', 3.2, 3.1, -2, 0.1);
    } else if (scene === 'parking-lot') {
      ground(10, 8, 0.1, material('#475569'));
      for (const x of [-3.75, -1.25, 1.25, 3.75]) box([0.06, 0.012, 5], [x, 0.106, -0.5], material('#f8fafc'));
      place('vehicle-sedan', 1.5, 0, -0.5, 0.1);
    } else if (scene === 'park-path') {
      ground(8, 6, 0.1, material('#4d7c0f'));
      ground(2, 6, 0.12, material('#d6d3d1'));
      place('tree-deciduous', 5, -2.5, -1.5, 0.1);
      place('tree-pine', 4.5, 2.5, -1.5, 0.1);
      place('bench', 0.85, 2.1, 1.5, 0.1, -Math.PI / 2);
    } else if (scene === 'warehouse') {
      roomShell(8, 6, 4.1);
      for (const x of [-2.7, 0, 2.7]) {
        const shelf = place('bookshelf', 3.3, x, -2.5, 0.1);
        shelf.scale.x *= 1.5;
        place('crate-stack', 1.3, x, 0.5, 0.1);
      }
    } else if (scene.includes('gate') || scene === 'paifang') {
      place('archway', 5, 0, 0);
      for (const side of [-1, 1]) {
        box([2.2, 5, 2], [side * 3.5, 2.5, 0]);
        box([2.7, 0.3, 2.5], [side * 3.5, 5.15, 0], material('#78350f'));
      }
      box([9.8, 0.35, 2.5], [0, 5.65, 0], material('#78350f'));
    } else if (scene.includes('wall')) {
      box([10, 4, 1.2], [0, 2, 0]);
      for (let x = -4.5; x <= 4.5; x += 1.5) box([0.8, 0.65, 1.3], [x, 4.325, 0]);
    } else if (scene.includes('tower')) {
      cylinder(2, 2.3, 8, [0, 4, 0], primary, 8);
      for (const y of [3, 6, 8]) cylinder(2.6, 2.6, 0.25, [0, y, 0], material('#78350f'), 8);
      addObjectMesh(group, material('#78350f'), new THREE.ConeGeometry(3, 2, 8), [0, 9, 0]);
      windowFrame(0.7, 1.2, 0, 6.8, 2.02);
    } else if (scene === 'house-exterior' || scene.includes('villa') || scene === 'main-hall') {
      const villa = scene.includes('villa');
      const w = villa ? 9 : scene === 'main-hall' ? 12 : 6;
      const h = villa ? 5.6 : 3.6;
      box([w, h, 5], [0, h / 2, 0]);
      const roof = addObjectMesh(group, material('#92400e'), new THREE.ConeGeometry(1, 1, 4), [0, h + 1.1, 0]);
      roof.rotation.y = Math.PI / 4;
      roof.scale.set(w * 0.78, 2.2, 5 * 0.78);
      box([0.9, 2.1, 0.08], [0, 1.05, 2.54], material('#78350f'));
      for (const x of [-w * 0.3, w * 0.3]) {
        windowFrame(1.3, 1.2, x, 1.7, 2.56);
        if (villa) windowFrame(1.3, 1.2, x, 4.3, 2.56);
      }
      if (scene === 'villa-02') box([3.5, 0.2, 1.4], [0, 3.1, 3.1], material('#94a3b8'));
    } else {
      // Legacy city/building/concept sets keep readable, full-size massing.
      ground(16, 12, 0.15, material('#64748b'));
      const apartment = scene === 'apartment-exterior';
      const footprints = apartment ? [[0, 0, 7, 11.85, 5]] : [[-4, -2, 4, 12, 4], [3, 1, 5, 8, 5], [4, -4, 3, 15, 3]];
      for (const [x, z, w, h, d] of footprints) {
        box([w, h, d], [x, h / 2 + 0.15, z]);
        for (let y = 1.8; y < h; y += 2.8) for (const dx of [-w * 0.27, w * 0.27]) {
          box([1, 1.25, 0.025], [x + dx, y, z + d / 2 + 0.025], material('#bae6fd', 'glass'));
          box([1.1, 0.06, 0.08], [x + dx, y + 0.65, z + d / 2 + 0.035], material('#cbd5e1'));
        }
      }
    }
  } else if (id.startsWith('vehicle-') || id === 'car') {
    const vehicle = id === 'car' ? 'sedan' : id.slice(8);
    if (['sedan', 'sedan-01', 'suv', 'taxi', 'police-car'].includes(vehicle)) {
      car(vehicle === 'suv' ? 1.95 : 1.8, vehicle === 'suv' ? 4.7 : 4.5, vehicle === 'suv' ? 1.8 : 1.5);
      if (vehicle === 'taxi') box([0.45, 0.16, 0.2], [0, 1.58, -0.2], material('#fef3c7', 'light'));
      if (vehicle === 'police-car') {
        box([0.8, 0.12, 0.22], [0, 1.56, -0.2], material('#1d4ed8', 'light'));
        box([0.4, 0.12, 0.23], [-0.2, 1.56, -0.2], material('#ef4444', 'light'));
      }
    } else if (['bus', 'van', 'ambulance', 'truck', 'subway-car', 'locomotive'].includes(vehicle)) {
      const length = vehicle === 'bus' ? 11 : vehicle === 'subway-car' ? 20 : vehicle === 'truck' ? 7 : vehicle === 'locomotive' ? 16 : 5.4;
      const w = vehicle === 'van' || vehicle === 'ambulance' ? 2 : 2.5;
      const h = vehicle === 'bus' ? 3.2 : vehicle === 'subway-car' ? 3.6 : vehicle === 'truck' ? 3.4 : vehicle === 'locomotive' ? 4.2 : 2.5;
      const r = vehicle === 'subway-car' ? 0.45 : 0.42;
      box([w, h - 0.5, length], [0, (h + 0.5) / 2, 0]);
      const count = Math.max(2, Math.floor(length / 1.6));
      if (vehicle !== 'truck') for (let i = 0; i < count; i += 1) for (const side of [-1, 1]) {
        box([0.025, 0.75, length / count * 0.72], [side * (w / 2 + 0.012), h - 0.8, -length / 2 + (i + 0.5) * length / count], material('#bae6fd', 'glass'));
      }
      box([w * 0.85, 0.85, 0.025], [0, h - 0.85, length / 2 + 0.012], material('#bae6fd', 'glass'));
      for (const side of [-1, 1]) for (const z of [-length * 0.34, length * 0.34]) wheel(side * w * 0.48, z, r, 0.25);
      lights(w, length, 0.9);
      if (vehicle === 'truck') {
        box([w + 0.08, 0.08, length * 0.68], [0, h + 0.04, -length * 0.15], material('#cbd5e1'));
        box([w + 0.025, 0.1, 0.06], [0, 0.8, length * 0.27], material('#111827'));
      }
      if (vehicle === 'ambulance') {
        box([0.8, 0.13, 0.25], [0, h + 0.065, length * 0.25], material('#38bdf8', 'light'));
        for (const side of [-1, 1]) {
          box([0.035, 0.18, 0.65], [side * (w / 2 + 0.03), 1.45, -0.5], material('#ef4444'));
          box([0.035, 0.65, 0.18], [side * (w / 2 + 0.03), 1.45, -0.5], material('#ef4444'));
        }
      }
    } else if (['bicycle', 'motorcycle', 'e-scooter'].includes(vehicle)) {
      const bike = vehicle === 'bicycle';
      const scooter = vehicle === 'e-scooter';
      const r = bike ? 0.34 : scooter ? 0.14 : 0.31;
      const span = scooter ? 0.5 : 0.7;
      wheel(0, -span, r, bike ? 0.04 : 0.12);
      wheel(0, span, r, bike ? 0.04 : 0.12);
      if (bike) {
        for (const [a, b] of [ [[0, r, -span], [0, 0.8, -0.2]], [[0, r, -span], [0, 0.36, 0.1]], [[0, 0.8, -0.2], [0, 0.36, 0.1]], [[0, 0.36, 0.1], [0, 0.85, 0.45]], [[0, 0.8, -0.2], [0, 0.85, 0.45]] ] as [ObjectPoint, ObjectPoint][]) beam(a, b);
      } else box([0.3, scooter ? 0.07 : 0.4, 0.95], [0, scooter ? 0.2 : 0.55, -0.05]);
      beam([0, r, span], [0, 1.05, span - 0.15], 0.025, material('#94a3b8'));
      beam([-0.28, 1.05, span - 0.15], [0.28, 1.05, span - 0.15], 0.025, material('#111827'));
      if (!scooter) box([0.22, 0.07, 0.34], [0, 0.92, -0.25], material('#111827'));
    } else if (vehicle === 'helicopter') {
      ellipsoid([0.85, 0.8, 2], [0, 1.6, 1]);
      ellipsoid([0.78, 0.65, 0.85], [0, 1.7, 2.15], material('#bae6fd', 'glass'));
      beam([0, 1.7, -0.5], [0, 2, -4.5], 0.16);
      box([0.08, 1.4, 0.9], [0, 2.5, -4.2]);
      cylinder(0.075, 0.075, 0.65, [0, 2.7, 0.5], material('#94a3b8'));
      box([9.5, 0.06, 0.18], [0, 3.05, 0.5], material('#475569'));
      box([0.18, 0.06, 9.5], [0, 3.05, 0.5], material('#475569'));
      beam([0.15, 1.5, -4.35], [0.15, 2.5, -4.35], 0.04, material('#475569'));
      for (const x of [-0.8, 0.8]) {
        beam([x, 0.08, -0.5], [x, 0.08, 2.5], 0.06, material('#475569'));
        for (const z of [0, 1.7]) beam([x, 0.08, z], [x * 0.65, 1.05, z], 0.045, material('#94a3b8'));
      }
    } else if (vehicle === 'airplane') {
      const fuselage = ellipsoid([0.65, 0.7, 3.8], [0, 1.35, 0]);
      fuselage.name = 'fuselage';
      box([10.2, 0.13, 1.5], [0, 1.3, -0.2]);
      box([3.7, 0.09, 0.8], [0, 1.65, -3]);
      box([0.1, 1.5, 1], [0, 2.25, -3]);
      ellipsoid([0.5, 0.25, 0.8], [0, 1.9, 1.1], material('#bae6fd', 'glass'));
      for (const x of [-1.1, 1.1]) {
        wheel(x, 0.2, 0.22, 0.14);
        beam([x, 0.22, 0.2], [x * 0.4, 1.25, 0.2], 0.035, material('#475569'));
      }
      wheel(0, -2.8, 0.16, 0.1);
      box([0.08, 1.8, 0.12], [0, 1.35, 3.85], material('#475569'));
    } else if (['boat', 'yacht', 'ship', 'submarine'].includes(vehicle)) {
      const sub = vehicle === 'submarine';
      const length = vehicle === 'ship' ? 24 : vehicle === 'boat' ? 4.5 : sub ? 18 : 9;
      const width = vehicle === 'ship' ? 6 : vehicle === 'boat' ? 1.9 : sub ? 3 : 3;
      const hullH = vehicle === 'ship' ? 2.4 : sub ? 3 : 1.1;
      ellipsoid([width / 2, hullH / 2, length / 2], [0, hullH / 2, 0]);
      if (sub) {
        box([1, 1.3, 2.5], [0, 3.05, -1]);
        beam([0, 3.7, -1], [0, 4.4, -1], 0.06, material('#94a3b8'));
        box([4.5, 0.12, 1.3], [0, 1.5, -6]);
      } else {
        box([width * 0.85, 0.1, length * 0.8], [0, hullH * 0.75, 0], material('#d6d3d1'));
        if (vehicle !== 'boat') {
          box([width * 0.62, vehicle === 'ship' ? 3.2 : 1.5, length * 0.35], [0, hullH + (vehicle === 'ship' ? 1.3 : 0.5), -length * 0.1], material('#f8fafc'));
          windowFrame(width * 0.5, 0.6, 0, hullH + 0.65, length * 0.08);
          beam([0, hullH + 1.2, -length * 0.1], [0, hullH + 2.4, -length * 0.1], 0.045, material('#94a3b8'));
        } else {
          for (const z of [-0.8, 0.5]) box([width * 0.8, 0.12, 0.3], [0, 0.85, z], material('#78350f'));
        }
        for (const side of [-1, 1]) beam([side * width * 0.43, hullH, -length * 0.33], [side * width * 0.43, hullH, length * 0.33], 0.025, material('#94a3b8'));
      }
    } else if (vehicle === 'tank') {
      box([3.4, 1.2, 6], [0, 1, 0]);
      for (const x of [-1.7, 1.7]) box([0.5, 0.75, 6.2], [x, 0.375, 0], material('#172033'));
      cylinder(1.2, 1.4, 0.8, [0, 2, -0.3]);
      beam([0, 2.1, 0.3], [0, 2.1, 4.5], 0.12, material('#475569'));
    } else if (vehicle === 'sedan-chair') {
      box([1.1, 1.65, 1.1], [0, 1.1, 0]);
      box([1.4, 0.15, 1.4], [0, 2, 0], material('#92400e'));
      windowFrame(0.65, 0.8, 0, 1.2, 0.57);
      for (const x of [-0.75, 0.75]) beam([x, 0.5, -2], [x, 0.5, 2], 0.055, material('#78350f'));
    } else {
      group.userData.blueprintGenericFallback = true;
      box([1, 1, 1], [0, 0.5, 0]);
    }
  } else {
    switch (id) {
      case 'cube': case 'box': case 'generic-object':
        box([1, 1, 1], [0, 0.5, 0]);
        break;
      case 'sphere': ellipsoid([0.5, 0.5, 0.5], [0, 0.5, 0]); break;
      case 'cylinder': cylinder(0.4, 0.4, 1, [0, 0.5, 0]); break;
      case 'cone': addObjectMesh(group, primary, new THREE.ConeGeometry(0.5, 1, 32), [0, 0.5, 0]); break;
      case 'torus': addObjectMesh(group, primary, new THREE.TorusGeometry(0.38, 0.12, 16, 48), [0, 0.5, 0]); break;
      case 'pipe': {
        const mesh = addObjectMesh(group, primary, new THREE.CylinderGeometry(0.3, 0.3, 2, 32, 1, true), [0, 0.3, 0]);
        mesh.rotation.x = Math.PI / 2;
        primary.side = THREE.DoubleSide;
        break;
      }
      case 'plane': case 'floor-slab': ground(id === 'plane' ? 2 : 5, id === 'plane' ? 2 : 4, id === 'plane' ? 0.04 : 0.2); break;
      case 'disc': {
        const mesh = cylinder(1, 1, 0.06, [0, 0.03, 0], primary, 48);
        mesh.castShadow = false;
        mesh.userData.blueprintGround = true;
        break;
      }
      case 'ramp': {
        // Closed triangular prism: level bottom, sloping top, no floating slab.
        const shape = new THREE.Shape();
        shape.moveTo(-1.5, 0); shape.lineTo(1.5, 0); shape.lineTo(1.5, 1); shape.closePath();
        const geometry = new THREE.ExtrudeGeometry(shape, { depth: 1.5, bevelEnabled: false });
        const mesh = addObjectMesh(group, primary, geometry, [0, 0, 0]);
        mesh.rotation.y = Math.PI / 2;
        mesh.position.x = -0.75;
        break;
      }
      case 'table': case 'desk': {
        const w = id === 'desk' ? 1.4 : 1.5;
        box([w, 0.05, 0.8], [0, 0.725, 0]);
        for (const x of [-w * 0.43, w * 0.43]) for (const z of [-0.31, 0.31]) box([0.065, 0.7, 0.065], [x, 0.35, z]);
        if (id === 'desk') {
          box([0.35, 0.32, 0.62], [0.44, 0.53, 0]);
          box([0.15, 0.025, 0.025], [0.44, 0.58, 0.325], material('#94a3b8'));
        }
        break;
      }
      case 'chair': case 'folding-chair': case 'official-chair': case 'office-chair': case 'ergonomic-chair': {
        const office = id.includes('office') || id.includes('ergonomic');
        const h = office ? 1.15 : id === 'official-chair' ? 1.1 : 0.9;
        box([0.46, 0.06, 0.46], [0, 0.42, 0]);
        box([0.46, h - 0.48, 0.055], [0, (h + 0.48) / 2, -0.205]);
        if (office) {
          cylinder(0.035, 0.035, 0.36, [0, 0.21, 0], material('#94a3b8'));
          for (let i = 0; i < 5; i += 1) {
            const angle = i * Math.PI * 2 / 5;
            const x = Math.cos(angle) * 0.3, z = Math.sin(angle) * 0.3;
            beam([0, 0.09, 0], [x, 0.07, z], 0.025, material('#475569'));
            ellipsoid([0.035, 0.04, 0.035], [x, 0.04, z], material('#172033'), 12);
          }
          for (const x of [-0.3, 0.3]) {
            box([0.05, 0.04, 0.3], [x, 0.65, 0]);
            beam([x, 0.45, 0], [x, 0.65, 0], 0.02, material('#94a3b8'));
          }
        } else {
          for (const x of [-0.19, 0.19]) for (const z of [-0.19, 0.19]) box([0.045, 0.39, 0.045], [x, 0.195, z]);
          if (id === 'official-chair') box([0.62, 0.065, 0.07], [0, 1.0675, -0.205]);
        }
        break;
      }
      case 'stool': case 'drum-stool':
        cylinder(0.2, 0.2, 0.05, [0, 0.425, 0]);
        for (const x of [-0.13, 0.13]) for (const z of [-0.13, 0.13]) beam([x, 0, z], [x * 0.8, 0.4, z * 0.8], 0.025);
        break;
      case 'sofa':
        box([1.8, 0.3, 0.85], [0, 0.25, 0]);
        box([2, 0.55, 0.15], [0, 0.625, -0.35]);
        for (const x of [-0.95, 0.95]) box([0.2, 0.4, 0.9], [x, 0.45, 0]);
        for (const x of [-0.45, 0.45]) box([0.85, 0.12, 0.65], [x, 0.46, 0.06]);
        for (const x of [-0.8, 0.8]) for (const z of [-0.3, 0.3]) cylinder(0.035, 0.035, 0.1, [x, 0.05, z], material('#78350f'));
        break;
      case 'bed':
        box([1.6, 0.28, 2.05], [0, 0.27, 0]);
        box([1.65, 1, 0.09], [0, 0.5, -1]);
        box([1.55, 0.18, 2], [0, 0.5, 0], material('#f8fafc'));
        box([1.56, 0.035, 1.15], [0, 0.6075, 0.4]);
        for (const x of [-0.4, 0.4]) box([0.6, 0.12, 0.4], [x, 0.65, -0.65], material('#f8fafc'));
        for (const x of [-0.65, 0.65]) for (const z of [-0.85, 0.85]) box([0.08, 0.13, 0.08], [x, 0.065, z], material('#78350f'));
        break;
      case 'cabinet':
        box([1, 1.8, 0.5], [0, 0.9, 0]);
        for (const x of [-0.25, 0.25]) {
          box([0.475, 1.73, 0.035], [x, 0.9, 0.27]);
          box([0.025, 0.18, 0.04], [x * 0.2, 1, 0.31], material('#94a3b8'));
        }
        break;
      case 'bookshelf':
        // Open front and back: real shelves, not stripes on an opaque cabinet.
        for (const x of [-0.475, 0.475]) box([0.05, 1.8, 0.35], [x, 0.9, 0]);
        for (const y of [0.025, 0.46, 0.9, 1.34, 1.775]) box([0.9, 0.05, 0.35], [0, y, 0]);
        for (const [x, y, shade] of [[-0.3, 0.625, '#60a5fa'], [-0.18, 0.625, '#f97316'], [0.14, 1.06, '#22c55e'], [0.25, 1.06, '#a78bfa']] as const) box([0.09, 0.28, 0.22], [x, y, 0], material(shade));
        break;
      case 'door':
        box([0.9, 2.1, 0.045], [0, 1.05, 0]);
        for (const y of [0.55, 1.5]) box([0.7, 0.65, 0.015], [0, y, 0.03]);
        beam([0.28, 1, 0.06], [0.4, 1, 0.06], 0.015, material('#facc15'));
        break;
      case 'window': windowFrame(1.5, 1.2, 0, 0.6, 0); break;
      case 'lamp': case 'floor-lamp': case 'table-lamp': {
        const h = id === 'table-lamp' ? 0.5 : 1.65;
        cylinder(0.18, 0.2, 0.035, [0, 0.0175, 0], material('#475569'));
        cylinder(0.018, 0.018, h - 0.22, [0, (h - 0.22) / 2, 0], material('#94a3b8'));
        const shade = addObjectMesh(group, primary, new THREE.CylinderGeometry(0.12, 0.25, 0.28, 32, 1, true), [0, h - 0.14, 0]);
        shade.material.side = THREE.DoubleSide;
        ellipsoid([0.055, 0.07, 0.055], [0, h - 0.2, 0], material('#fef3c7', 'light'));
        break;
      }
      case 'plant':
        cylinder(0.19, 0.14, 0.3, [0, 0.15, 0], material('#9a3412'));
        beam([0, 0.3, 0], [0, 1.25, 0], 0.025, material('#166534'));
        for (const [x, y, z] of [[-0.18, 0.9, 0], [0.2, 1.1, -0.04], [0, 1.2, 0.13]]) ellipsoid([0.22, 0.2, 0.13], [x, y, z], material('#22c55e'));
        break;
      case 'laptop':
        box([0.34, 0.018, 0.23], [0, 0.009, 0]);
        box([0.34, 0.22, 0.016], [0, 0.12, -0.105]);
        box([0.3, 0.18, 0.004], [0, 0.12, -0.095], material('#172033'));
        box([0.27, 0.003, 0.1], [0, 0.02, -0.01], material('#475569'));
        break;
      case 'phone':
        box([0.075, 0.155, 0.009], [0, 0.0775, 0]);
        box([0.066, 0.14, 0.002], [0, 0.078, 0.0055], material('#172033'));
        break;
      case 'cup': {
        const mesh = addObjectMesh(group, primary, new THREE.CylinderGeometry(0.045, 0.036, 0.11, 32, 1, true), [0, 0.055, 0]);
        mesh.material.side = THREE.DoubleSide;
        cylinder(0.035, 0.035, 0.006, [0, 0.003, 0]);
        addObjectMesh(group, primary, new THREE.TorusGeometry(0.03, 0.007, 12, 24), [0.05, 0.06, 0]);
        break;
      }
      case 'suitcase': case 'backpack':
        box(id === 'suitcase' ? [0.42, 0.58, 0.24] : [0.33, 0.43, 0.18], [0, id === 'suitcase' ? 0.34 : 0.215, 0]);
        box([0.15, 0.035, 0.035], [0, id === 'suitcase' ? 0.67 : 0.46, 0], material('#172033'));
        if (id === 'suitcase') for (const x of [-0.16, 0.16]) ellipsoid([0.035, 0.04, 0.035], [x, 0.04, 0], material('#172033'), 12);
        else {
          box([0.26, 0.18, 0.06], [0, 0.15, 0.12]);
          for (const x of [-0.11, 0.11]) box([0.04, 0.36, 0.035], [x, 0.23, -0.11], material('#172033'));
        }
        break;
      case 'monitor-tv':
        box([1.15, 0.68, 0.055], [0, 0.71, 0]);
        box([1.07, 0.6, 0.01], [0, 0.71, 0.035], material('#172033'));
        cylinder(0.025, 0.025, 0.35, [0, 0.2, 0], material('#94a3b8'));
        box([0.5, 0.05, 0.25], [0, 0.025, 0], material('#475569'));
        break;
      case 'book':
        box([0.16, 0.024, 0.23], [0, 0.014, 0], material('#f8fafc'));
        for (const y of [0.002, 0.028]) box([0.17, 0.004, 0.24], [0, y, 0]);
        box([0.008, 0.03, 0.24], [-0.081, 0.015, 0]);
        break;
      case 'bottle':
        cylinder(0.035, 0.04, 0.2, [0, 0.1, 0], material('#7dd3fc', 'glass'));
        cylinder(0.015, 0.035, 0.05, [0, 0.225, 0], material('#7dd3fc', 'glass'));
        cylinder(0.015, 0.015, 0.05, [0, 0.275, 0]);
        break;
      case 'umbrella': {
        beam([0, 0, 0], [0, 1.08, 0], 0.012, material('#475569'));
        const canopy = addObjectMesh(group, primary, new THREE.SphereGeometry(0.65, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), [0, 0.9, 0]);
        canopy.scale.y = 0.35;
        primary.side = THREE.DoubleSide;
        for (let i = 0; i < 8; i += 1) beam([0, 1.12, 0], [Math.cos(i * Math.PI / 4) * 0.65, 0.9, Math.sin(i * Math.PI / 4) * 0.65], 0.006, material('#94a3b8'));
        break;
      }
      case 'guitar':
        ellipsoid([0.19, 0.23, 0.06], [0, 0.24, 0]);
        ellipsoid([0.14, 0.16, 0.055], [0, 0.5, 0]);
        box([0.055, 0.49, 0.035], [0, 0.76, 0], material('#78350f'));
        box([0.09, 0.15, 0.04], [0, 1.04, 0]);
        ellipsoid([0.055, 0.055, 0.005], [0, 0.43, 0.06], material('#172033'));
        for (const x of [-0.012, 0.012]) beam([x, 0.2, 0.065], [x, 1.04, 0.025], 0.002, material('#cbd5e1'));
        break;
      case 'camera-tripod':
        for (let i = 0; i < 3; i += 1) beam([Math.cos(i * Math.PI * 2 / 3) * 0.55, 0, Math.sin(i * Math.PI * 2 / 3) * 0.55], [0, 1.3, 0], 0.025, material('#475569'));
        box([0.28, 0.2, 0.22], [0, 1.45, 0]);
        cylinder(0.065, 0.065, 0.2, [0, 1.45, 0.2], material('#172033')).rotation.x = Math.PI / 2;
        box([0.12, 0.045, 0.15], [0, 1.5725, -0.02]);
        break;
      case 'crate-stack':
        for (const [x, y, z] of [[-0.35, 0.3, 0], [0.35, 0.3, 0], [0, 0.9, -0.05]]) {
          box([0.62, 0.6, 0.62], [x, y, z]);
          for (const dx of [-0.24, 0.24]) box([0.045, 0.6, 0.025], [x + dx, y, z + 0.325], material('#78350f'));
          for (const dy of [-0.24, 0.24]) box([0.62, 0.045, 0.025], [x, y + dy, z + 0.325], material('#78350f'));
        }
        break;
      case 'knife': case 'sword': {
        const bladeH = id === 'knife' ? 0.22 : 0.75;
        const shape = new THREE.Shape();
        shape.moveTo(-0.025, 0); shape.lineTo(0.025, 0); shape.lineTo(0.025, bladeH * 0.8); shape.lineTo(0, bladeH); shape.lineTo(-0.025, bladeH * 0.8); shape.closePath();
        addObjectMesh(group, material('#cbd5e1'), new THREE.ExtrudeGeometry(shape, { depth: 0.008, bevelEnabled: false }), [0, 0.12, -0.004]);
        box([0.035, 0.12, 0.025], [0, 0.06, 0], material('#78350f'));
        box([id === 'sword' ? 0.18 : 0.065, 0.018, 0.03], [0, 0.12, 0]);
        break;
      }
      case 'pistol-prop':
        box([0.035, 0.045, 0.19], [0, 0.13, 0.025], material('#475569'));
        box([0.032, 0.1, 0.045], [0, 0.065, -0.035], material('#172033'));
        beam([-0.018, 0.105, -0.012], [-0.018, 0.055, 0.04], 0.006, material('#475569'));
        beam([-0.018, 0.055, 0.04], [-0.018, 0.105, 0.055], 0.006, material('#475569'));
        cylinder(0.012, 0.012, 0.006, [0, 0.13, 0.123], material('#172033')).rotation.x = Math.PI / 2;
        break;
      case 'food-plate':
        cylinder(0.14, 0.115, 0.022, [0, 0.011, 0], material('#f8fafc'), 40);
        ellipsoid([0.075, 0.04, 0.065], [0, 0.045, 0], material('#d97706'));
        for (const x of [-0.065, 0.065]) ellipsoid([0.03, 0.018, 0.035], [x, 0.035, 0.03], material('#22c55e'), 16);
        break;
      case 'wall-segment': box([3, 2.7, 0.18], [0, 1.35, 0]); break;
      case 'wall-doorway':
        for (const x of [-1.025, 1.025]) box([0.95, 2.7, 0.18], [x, 1.35, 0]);
        box([1.1, 0.6, 0.18], [0, 2.4, 0]);
        break;
      case 'wall-window':
        for (const x of [-1.15, 1.15]) box([0.7, 2.7, 0.18], [x, 1.35, 0]);
        box([1.6, 0.9, 0.18], [0, 0.45, 0]);
        box([1.6, 0.6, 0.18], [0, 2.4, 0]);
        windowFrame(1.6, 1.2, 0, 1.5, 0);
        break;
      case 'stairs':
        for (let i = 0; i < 12; i += 1) box([1.2, (i + 1) * 0.175, 0.28], [0, (i + 1) * 0.0875, 1.54 - i * 0.28]);
        break;
      case 'column':
        cylinder(0.27, 0.27, 0.15, [0, 0.075, 0]);
        cylinder(0.18, 0.21, 2.4, [0, 1.35, 0]);
        cylinder(0.3, 0.3, 0.15, [0, 2.625, 0]);
        break;
      case 'railing':
        for (let i = 0; i <= 10; i += 1) cylinder(0.018, 0.018, 1.05, [-1.5 + i * 0.3, 0.525, 0], material('#475569'), 12);
        for (const y of [0.15, 1.08]) beam([-1.55, y, 0], [1.55, y, 0], 0.025, material('#475569'));
        break;
      case 'archway': {
        for (const x of [-1.05, 1.05]) box([0.3, 1.7, 0.45], [x, 0.85, 0]);
        const shape = new THREE.Shape();
        shape.absarc(0, 1.7, 1.2, 0, Math.PI, false);
        shape.lineTo(-0.9, 1.7);
        shape.absarc(0, 1.7, 0.9, Math.PI, 0, true);
        shape.closePath();
        addObjectMesh(group, primary, new THREE.ExtrudeGeometry(shape, { depth: 0.45, bevelEnabled: false, curveSegments: 28 }), [0, 0, -0.225]);
        break;
      }
      case 'road-segment': road(); break;
      case 'crosswalk': road(true); break;
      case 'street-lamp':
        cylinder(0.055, 0.09, 3.8, [0, 1.9, 0], material('#475569'));
        beam([0, 3.77, 0], [0, 3.95, 0.8], 0.045, material('#475569'));
        box([0.32, 0.1, 0.55], [0, 3.95, 0.9], material('#475569'));
        box([0.25, 0.025, 0.45], [0, 3.89, 0.9], material('#fef3c7', 'light'));
        cylinder(0.18, 0.18, 0.08, [0, 0.04, 0], material('#475569'));
        break;
      case 'traffic-light':
        cylinder(0.045, 0.065, 2.7, [0, 1.35, 0], material('#475569'));
        box([0.32, 0.9, 0.25], [0, 2.75, 0], material('#172033'));
        for (const [y, shade] of [[3.03, '#ef4444'], [2.75, '#facc15'], [2.47, '#22c55e']] as const) cylinder(0.09, 0.09, 0.025, [0, y, 0.14], material(shade, 'light')).rotation.x = Math.PI / 2;
        break;
      case 'bench':
        for (const z of [-0.16, 0, 0.16]) box([1.6, 0.055, 0.12], [0, 0.425, z], material('#92400e'));
        for (const y of [0.61, 0.79]) box([1.6, 0.12, 0.055], [0, y, -0.22], material('#92400e'));
        for (const x of [-0.58, 0.58]) {
          beam([x, 0, -0.18], [x, 0.85, -0.22], 0.03, material('#475569'));
          beam([x, 0, 0.18], [x, 0.43, 0.18], 0.03, material('#475569'));
        }
        break;
      case 'bus-stop':
        for (const x of [-1.5, 1.5]) for (const z of [-0.6, 0.6]) beam([x, 0, z], [x, 2.4, z], 0.035, material('#475569'));
        box([3.3, 0.12, 1.5], [0, 2.46, 0]);
        box([2.9, 1.9, 0.025], [0, 1.25, -0.6], material('#bae6fd', 'glass'));
        place('bench', 0.85, 0, -0.1);
        box([0.5, 0.65, 0.04], [1.1, 1.6, -0.55], material('#f8fafc'));
        break;
      case 'trash-bin':
        cylinder(0.22, 0.2, 0.8, [0, 0.4, 0]);
        cylinder(0.24, 0.24, 0.06, [0, 0.83, 0], material('#475569'));
        box([0.26, 0.1, 0.03], [0, 0.69, 0.205], material('#172033'));
        break;
      case 'fire-hydrant':
        cylinder(0.1, 0.14, 0.65, [0, 0.325, 0]);
        ellipsoid([0.12, 0.1, 0.12], [0, 0.65, 0]);
        beam([-0.23, 0.45, 0], [0.23, 0.45, 0], 0.07);
        cylinder(0.2, 0.2, 0.04, [0, 0.02, 0], material('#475569'));
        break;
      case 'road-sign':
        cylinder(0.025, 0.035, 2.5, [0, 1.25, 0], material('#94a3b8'));
        box([0.8, 0.6, 0.04], [0, 2.45, 0]);
        box([0.5, 0.08, 0.015], [0, 2.45, 0.03], material('#f8fafc'));
        break;
      case 'tree-deciduous':
        cylinder(0.14, 0.24, 2.5, [0, 1.25, 0], material('#78350f'));
        for (const [x, z] of [[-0.7, 0.2], [0.65, -0.35], [0, 0.5]]) {
          beam([0, 1.8, 0], [x, 3.1, z], 0.08, material('#78350f'));
          ellipsoid([1.15, 1.35, 1.1], [x, 3.65, z], material('#4d7c0f'));
        }
        break;
      case 'tree-pine':
        cylinder(0.12, 0.2, 1.5, [0, 0.75, 0], material('#78350f'));
        for (const [r, h, y] of [[1.25, 2.4, 2], [1, 2, 3], [0.7, 1.6, 3.7]]) addObjectMesh(group, material('#166534'), new THREE.ConeGeometry(r, h, 28), [0, y, 0]);
        break;
      case 'bush':
        for (const x of [-0.4, 0, 0.4]) ellipsoid([0.5, x === 0 ? 0.5 : 0.4, 0.45], [x, x === 0 ? 0.5 : 0.4, 0], material('#4d7c0f'));
        break;
      case 'rock': {
        const mesh = addObjectMesh(group, material('#78716c'), new THREE.DodecahedronGeometry(1, 0), [0, 0.5, 0]);
        mesh.scale.set(0.9, 0.65, 0.7);
        mesh.rotation.y = 0.34;
        break;
      }
      case 'grass-patch':
        ground(3, 3, 0.05, material('#4d7c0f'));
        for (let i = 0; i < 24; i += 1) {
          const x = ((i * 7) % 11) / 4 - 1.2, z = ((i * 5) % 13) / 5 - 1.2;
          addObjectMesh(group, material('#65a30d'), new THREE.ConeGeometry(0.035, 0.18, 4), [x, 0.14, z]);
        }
        break;
      case 'pond':
        ground(4, 3, 0.06, material('#78716c'));
        const water = ellipsoid([1.9, 0.025, 1.4], [0, 0.07, 0], material('#38bdf8', 'glass'), 40);
        water.castShadow = false;
        water.userData.blueprintGround = true;
        break;
      case 'hill': case 'terrain':
        ground(8, 6, 0.1, material('#4d7c0f'));
        {
          const mound = addObjectMesh(group, material('#65a30d'), new THREE.SphereGeometry(1, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), [0, 0.1, 0]);
          mound.scale.set(3.5, 1.5, 2.5);
        }
        break;
      case 'ground-scene':
        ground(10, 8, 0.1, material('#4d7c0f'));
        ground(2, 8, 0.12, material('#d6d3d1'));
        place('rock', 0.65, -3, -1, 0.1);
        place('bush', 0.9, 3, -2, 0.1);
        break;
      case 'aerial-scene':
        // Cloud volumes give a readable aerial set without a misleading solid cube.
        for (const [x, y, z] of [[-3, 0.8, -1], [2.5, 2.7, -2], [0.2, 1.7, 2]]) {
          ellipsoid([1.6, 0.55, 1], [x, y, z], material('#f1f5f9'));
          ellipsoid([0.9, 0.7, 0.8], [x - 0.5, y + 0.35, z], material('#f8fafc'));
          ellipsoid([0.75, 0.6, 0.8], [x + 0.6, y + 0.2, z], material('#f8fafc'));
        }
        break;
      case 'screen':
        for (const x of [-0.52, 0, 0.52]) {
          box([0.5, 1.7, 0.04], [x, 0.85, x === 0 ? -0.08 : 0]);
          for (const dx of [-0.23, 0.23]) box([0.03, 1.7, 0.06], [x + dx, 0.85, 0], material('#78350f'));
        }
        break;
      case 'shield':
        ellipsoid([0.32, 0.5, 0.065], [0, 0.5, 0]);
        ellipsoid([0.08, 0.08, 0.04], [0, 0.5, 0.075], material('#94a3b8'));
        beam([-0.1, 0.5, -0.1], [0.1, 0.5, -0.1], 0.02, material('#78350f'));
        break;
      case 'bow':
        addObjectMesh(group, primary, new THREE.TorusGeometry(0.6, 0.025, 12, 40, Math.PI), [0, 0.6, 0]).rotation.z = -Math.PI / 2;
        beam([0, 0, 0], [0, 1.2, 0], 0.005, material('#f8fafc'));
        break;
      default:
        group.userData.blueprintGenericFallback = true;
        box([1, 1, 1], [0, 0.5, 0]);
    }
  }
  const bounds = new THREE.Box3().setFromObject(group);
  const center = bounds.getCenter(new THREE.Vector3());
  const nativeHeight = bounds.max.y - bounds.min.y;
  const scale = Number.isFinite(heightM) && heightM > 0 && nativeHeight > 0 ? heightM / nativeHeight : 1;
  const origin = new THREE.Vector3(center.x, bounds.min.y, center.z);
  for (const child of group.children) child.position.sub(origin);
  group.scale.setScalar(scale);
  group.userData.blueprintNativeHeightMeters = nativeHeight;
  return group;
}
