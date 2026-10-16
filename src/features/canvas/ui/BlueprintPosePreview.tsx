import { memo, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

import type { BlueprintActionPose } from '@/features/canvas/domain/canvasNodes';
import { createPersonMeshGroup, applyPersonActionTransform } from './blueprintMeshFactory';
import {
  applyGltfPersonAction,
  createGltfPersonMesh,
  ensurePersonTemplate,
  isGltfPersonTemplateReady,
  onGltfPersonTemplateReady,
} from './blueprintGltfFactory';

const SHOULD_USE_GLTF = () => (globalThis as any).__BLUEPRINT_USE_GLTF__ === true;

/**
 * Tiny Three.js viewport that renders a single humanoid figure with the
 * given pose applied. Used inside the custom-action modal so the user
 * sees their slider tweaks land on a real 3D body in real time. We keep
 * the renderer/scene/camera around for the lifetime of the component
 * and only rebuild the figure when the pose object reference changes.
 *
 * The camera is parked at a fixed three-quarter angle so the figure's
 * face, torso, and limbs all stay legible — no orbit controls because
 * the user is here to design a pose, not roam the scene.
 */
export interface BlueprintPosePreviewProps {
  pose: BlueprintActionPose;
  /** Color used for the figure's skin / body. Defaults to a neutral teal
   *  so the preview reads independently of whatever color the actual
   *  blueprint subject carries. */
  color?: string;
  /** Optional fixed pixel dimensions; defaults to 200×300. */
  width?: number;
  height?: number;
}

export const BlueprintPosePreview = memo(function BlueprintPosePreview({
  pose,
  color = '#6ee7b7',
  width = 220,
  height = 300,
}: BlueprintPosePreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<any>(null);
  const sceneRef = useRef<any>(null);
  const cameraRef = useRef<any>(null);
  const figureRef = useRef<any>(null);
  const turntableRef = useRef<any>(null);
  const animationRef = useRef<number | null>(null);
  // Track GLTF availability so the preview swaps from procedural fallback
  // to the real figure once the bundled GLB has loaded — only when the
  // explicit `__BLUEPRINT_USE_GLTF__` opt-in is set (otherwise we stay
  // procedural and skip the GLB load entirely).
  const [gltfReady, setGltfReady] = useState(isGltfPersonTemplateReady());
  useEffect(() => {
    if (gltfReady) return;
    if (!SHOULD_USE_GLTF()) return;
    const cleanup = onGltfPersonTemplateReady(() => setGltfReady(true));
    void ensurePersonTemplate().catch(() => {/* fallback already in place */});
    return cleanup;
  }, [gltfReady]);

  // ── One-time init: scene, lights, camera, renderer, ground.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0e0e0e');
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(36, width / height, 0.1, 50);
    camera.position.set(2.6, 1.55, 3.2);
    camera.lookAt(0, 0.85, 0);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Lighting kit: warm key + cool rim + ambient — same recipe the main
    // BlueprintScene uses, scaled down for this small viewport.
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight('#fef3c7', 0.85);
    key.position.set(2.4, 4, 3);
    scene.add(key);
    const rim = new THREE.DirectionalLight('#a5b4fc', 0.4);
    rim.position.set(-3, 2.5, -2.5);
    scene.add(rim);

    // Subtle floor disk so the figure has something to stand on.
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(2.2, 36),
      new THREE.MeshStandardMaterial({ color: '#1f2937', metalness: 0.15, roughness: 0.85 }),
    );
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);

    // The turntable group lets us spin the figure around for visual
    // appeal without recomputing the camera every frame.
    const turntable = new THREE.Group();
    scene.add(turntable);
    turntableRef.current = turntable;

    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
      renderer.dispose();
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
      // Disposing geometries/materials in the scene to avoid GPU leaks.
      scene.traverse((obj: any) => {
        if (obj.geometry?.dispose) obj.geometry.dispose();
        if (obj.material?.dispose) obj.material.dispose();
      });
      figureRef.current = null;
      turntableRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
      rendererRef.current = null;
    };
  }, [width, height]);

  // ── Rebuild figure when color or GLTF readiness changes (cheap recolor
  //    via a fresh build keeps the bone neutrals correct across variants).
  useEffect(() => {
    const turntable = turntableRef.current;
    if (!turntable) return;
    if (figureRef.current) {
      turntable.remove(figureRef.current);
      figureRef.current.traverse((obj: any) => {
        if (obj.geometry?.dispose) obj.geometry.dispose();
        if (obj.material?.dispose) obj.material.dispose();
      });
    }
    const tint = new THREE.Color(color);
    const useGltf = gltfReady && SHOULD_USE_GLTF();
    const figure = (useGltf ? createGltfPersonMesh(tint, 1.75) : null)
      ?? createPersonMeshGroup(tint, 1.75, 'man');
    turntable.add(figure);
    figureRef.current = figure;
  }, [color, gltfReady]);

  // ── Re-pose whenever the pose prop or GLTF readiness changes. We use
  //    the matching factory's pose applier so axis semantics stay consistent.
  useEffect(() => {
    const figure = figureRef.current;
    if (!figure) return;
    if (figure.userData?.gltfVariant) {
      applyGltfPersonAction(figure, '__custom_preview__', {
        customPoses: { __custom_preview__: pose },
      });
    } else {
      applyPersonActionTransform(figure, '__custom_preview__', {
        customPoses: { __custom_preview__: pose },
      });
    }
  }, [pose, gltfReady]);

  // ── Animation loop: gentle rotation + render.
  useEffect(() => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    const turntable = turntableRef.current;
    if (!renderer || !scene || !camera || !turntable) return;

    let prev = performance.now();
    const tick = (now: number) => {
      const dt = (now - prev) / 1000;
      prev = now;
      turntable.rotation.y += dt * 0.4; // ~23°/s — slow enough not to dizzy
      renderer.render(scene, camera);
      animationRef.current = requestAnimationFrame(tick);
    };
    animationRef.current = requestAnimationFrame(tick);
    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{ width, height }}
      className="overflow-hidden rounded-lg border border-white/10 bg-black/40"
    />
  );
});
