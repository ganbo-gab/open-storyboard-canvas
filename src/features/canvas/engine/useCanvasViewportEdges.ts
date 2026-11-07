import { useEffect, type RefObject } from 'react';
import { useStoreApi } from '@xyflow/react';
import { useCanvasStore } from '@/stores/canvasStore';
import { isCanvasViewportInteractionActive } from '../application/canvasViewportCommit';
import { getSharedCanvasGeometryIndex } from '../application/canvasGraphIndex';
import { buildViewportEdgeGeometry } from '../edges/viewportEdgeGeometry';
import { createViewportEdgeRenderer } from '../edges/viewportEdgeRenderer';
import { collectViewportEdgeSnapshot, MIN_VIEWPORT_EDGES, readViewportEdgeStroke } from '../edges/viewportEdgeSnapshot';
import type { ViewportEdgeInput } from '../edges/viewportEdgeGeometry';

/** Cached GPU ink avoids SVG repaint on camera motion; SVG owns hover, focus and editing. */
export function useCanvasViewportEdges(wrapperRef: RefObject<HTMLElement | null>): void {
  const flow = useStoreApi();
  useEffect(() => {
    const wrapper = wrapperRef.current;
    const container = wrapper?.querySelector<HTMLElement>('.react-flow__viewport');
    const edgeLayer = container?.querySelector<HTMLElement>('.react-flow__edges');
    if (!wrapper || !container || !edgeLayer) return;
    const root = wrapper, viewport = container, layer = edgeLayer;
    const canvas = document.createElement('canvas');
    canvas.className = 'canvas-viewport-edges';
    canvas.setAttribute('aria-hidden', 'true');
    viewport.prepend(canvas);
    let renderer: ReturnType<typeof createViewportEdgeRenderer> = null;
    let blocked = false, disposed = false, active = false, ready = false, preparing = false;
    let version = 0, timer: number | undefined, frame: number | undefined;
    let hoveredEdge: Element | null = null;
    let focusedEdge = false;
    let width = root.clientWidth, height = root.clientHeight;
    let strokes: Map<string, ViewportEdgeInput> | null = null;
    const moving = () => isCanvasViewportInteractionActive() || flow.getState().paneDragging;
    const restore = () => {
      active = false;
      root.removeAttribute('data-viewport-edge-cache-ready');
      root.removeAttribute('data-viewport-edges');
      canvas.style.display = 'none';
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
    };
    const invalidate = () => {
      version += 1;
      ready = false;
      strokes = null;
      restore();
      layer.querySelectorAll('[data-viewport-edge-cached]').forEach(element => element.removeAttribute('data-viewport-edge-cached'));
      schedulePreparation();
    };
    const draw = () => {
      if (disposed || blocked || !strokes || !renderer || !ready
        || (!moving() && (hoveredEdge !== null || focusedEdge || root.hasAttribute('data-pointer-transform')))
        || root.hasAttribute('data-connecting')
        || document.visibilityState !== 'visible' || root.hasAttribute('data-edges-hidden')) { restore(); return; }
      const [x, y, zoom] = flow.getState().transform;
      if (!(width > 0 && height > 0 && zoom > 0)) { restore(); return; }
      canvas.style.display = 'block';
      if (!renderer.draw({ x, y, zoom }, width, height, window.devicePixelRatio || 1)) { blocked = true; restore(); return; }
      active = moving();
      root.setAttribute('data-viewport-edge-cache-ready', '');
      // Hide supported SVG artwork only after a successful draw. Special effects keep their SVG.
      root.toggleAttribute('data-viewport-edges', active);
    };
    const watchEnd = () => {
      frame = undefined;
      if (!moving()) { update(); schedulePreparation(); return; }
      if (active) frame = requestAnimationFrame(watchEnd);
    };
    const update = () => {
      draw();
      if (active && frame === undefined) frame = requestAnimationFrame(watchEnd);
    };
    async function prepare(): Promise<void> {
      timer = undefined;
      if (disposed || blocked || strokes || preparing) return;
      if (moving() || root.hasAttribute('data-edges-hidden')) { schedulePreparation(); return; }
      const graph = useCanvasStore.getState();
      const geometryRevision = getSharedCanvasGeometryIndex(graph.nodes);
      const expected = graph.edges.filter(edge => !edge.hidden).length;
      if (expected < MIN_VIEWPORT_EDGES) return;
      const revision = version;
      const current = () => !disposed && !moving() && revision === version
        && geometryRevision === getSharedCanvasGeometryIndex(useCanvasStore.getState().nodes)
        && graph.edges === useCanvasStore.getState().edges;
      preparing = true;
      try {
        const snapshot = await collectViewportEdgeSnapshot(layer, expected, current,
          () => new Promise(resolve => window.setTimeout(resolve, 0)));
        if (!snapshot || !current()) return;
        const geometry = buildViewportEdgeGeometry(snapshot.inputs);
        if (!geometry || !current()) return;
        renderer ??= createViewportEdgeRenderer(canvas, () => { blocked = true; restore(); });
        if (!renderer || !renderer.setEdges(geometry)) { blocked = true; return; }
        ready = true;
        strokes = new Map(snapshot.inputs.map((stroke, index) => [
          snapshot.elements[index].querySelector('.react-flow__edge')?.getAttribute('data-id') ?? '', stroke,
        ]));
        for (const svg of snapshot.elements) svg.setAttribute('data-viewport-edge-cached', '');
        update();
      } catch {
        // Rendering acceleration must never prevent the original graph from being usable.
        blocked = true; restore();
      } finally {
        preparing = false;
        if (!disposed && revision !== version) schedulePreparation();
      }
    }
    function schedulePreparation(): void {
      if (disposed || blocked || strokes) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => { void prepare(); }, 180);
    }
    const edgesObserver = new MutationObserver(records => {
      if (records.some(record => record.type === 'attributes')) { invalidate(); return; }
      if (preparing) { invalidate(); return; }
      if (!strokes) { schedulePreparation(); return; }
      // Visibility culling can recreate wrappers without changing canonical geometry.
      for (const record of records) for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        const paths = node.matches('.canvas-edge__base') ? [node] : [...node.querySelectorAll('.canvas-edge__base')];
        for (const path of paths) {
          if (!(path instanceof SVGPathElement)) continue;
          const id = path.closest('.react-flow__edge')?.getAttribute('data-id');
          const cached = id ? strokes.get(id) : undefined;
          if (!cached) continue;
          const svg = path.closest('svg');
          const current = svg instanceof SVGSVGElement ? readViewportEdgeStroke(path, svg) : null;
          if (!current || current.path !== cached.path || current.width !== cached.width
            || current.miterLimit !== cached.miterLimit || current.color.some((value, index) => value !== cached.color[index])) {
            invalidate(); return;
          }
          svg?.setAttribute('data-viewport-edge-cached', '');
        }
      }
    });
    edgesObserver.observe(layer, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['d', 'class', 'style', 'transform', 'marker-start', 'marker-mid', 'marker-end'] });
    const chromeObserver = new MutationObserver(() => { update(); if (!moving()) schedulePreparation(); });
    chromeObserver.observe(root, { attributes: true, attributeFilter: ['data-viewport-transform', 'data-panning', 'data-edges-hidden', 'data-pointer-transform', 'data-connecting'] });
    const themeObserver = new MutationObserver(invalidate);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    const resize = new ResizeObserver(([entry]) => {
      width = entry.contentRect.width; height = entry.contentRect.height;
      if (ready) update();
    });
    resize.observe(root);
    const offFlow = flow.subscribe((next, previous) => {
      if (next.edges !== previous.edges) invalidate();
      if (next.transform !== previous.transform || next.paneDragging !== previous.paneDragging) update();
    });
    const offGraph = useCanvasStore.subscribe((next, previous) => {
      if (next.edges !== previous.edges || (next.nodes !== previous.nodes
        && getSharedCanvasGeometryIndex(next.nodes) !== getSharedCanvasGeometryIndex(previous.nodes))) invalidate();
    });
    const edgeAt = (target: EventTarget | null) => target instanceof Element ? target.closest('.react-flow__edge, .canvas-edge__cut') : null;
    const onOver = (event: PointerEvent) => { const edge = edgeAt(event.target); if (edge === hoveredEdge) return; hoveredEdge = edge; update(); };
    const onOut = (event: PointerEvent) => { const edge = edgeAt(event.relatedTarget); if (edge === hoveredEdge) return; hoveredEdge = edge; update(); };
    const onFocusIn = (event: FocusEvent) => { focusedEdge = edgeAt(event.target) !== null; update(); };
    const onFocusOut = (event: FocusEvent) => { focusedEdge = edgeAt(event.relatedTarget) !== null; update(); };
    root.addEventListener('pointerover', onOver); root.addEventListener('pointerout', onOut);
    root.addEventListener('focusin', onFocusIn); root.addEventListener('focusout', onFocusOut);
    const onVisibility = () => { if (document.visibilityState !== 'visible') restore(); };
    window.addEventListener('blur', restore);
    window.addEventListener('pagehide', restore);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', update);
    window.addEventListener('resize', update);
    schedulePreparation();
    return () => {
      disposed = true; version += 1;
      if (timer !== undefined) window.clearTimeout(timer);
      restore(); offFlow(); offGraph(); edgesObserver.disconnect(); chromeObserver.disconnect(); themeObserver.disconnect(); resize.disconnect();
      window.removeEventListener('blur', restore); window.removeEventListener('pagehide', restore);
      document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('focus', update); window.removeEventListener('resize', update);
      root.removeEventListener('pointerover', onOver); root.removeEventListener('pointerout', onOut);
      root.removeEventListener('focusin', onFocusIn); root.removeEventListener('focusout', onFocusOut);
      renderer?.dispose(); canvas.remove();
      layer.querySelectorAll('[data-viewport-edge-cached]').forEach(element => element.removeAttribute('data-viewport-edge-cached'));
    };
  }, [flow, wrapperRef]);
}
