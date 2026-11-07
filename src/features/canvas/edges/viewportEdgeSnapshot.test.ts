// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectViewportEdgeSnapshot, MIN_VIEWPORT_EDGES, readViewportEdgeStroke } from './viewportEdgeSnapshot';

const animations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
let computed: CSSStyleDeclaration;
function fixture() {
  const layer = document.createElement('div');
  layer.innerHTML = `<svg style="z-index:0"><g class="react-flow__edge" data-id="edge"><path class="canvas-edge__base" d="M0 0 L200 100" /></g></svg>`;
  const path = layer.querySelector('path'), svg = layer.querySelector('svg');
  if (!path || !svg) throw new Error('SVG fixture missing');
  return { layer, path, svg };
}
beforeEach(() => {
  computed = document.createElement('div').style;
  Object.assign(computed, { display: 'block', visibility: 'visible', fill: 'none', stroke: 'rgba(255, 255, 255, 0.26)',
    strokeDasharray: 'none', strokeDashoffset: '0px', strokeLinecap: 'butt', strokeLinejoin: 'miter',
    strokeWidth: '1.6px', strokeMiterlimit: '4', strokeOpacity: '1', opacity: '1', zIndex: '0' });
  vi.spyOn(window, 'getComputedStyle').mockImplementation(() => computed);
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
});
afterEach(() => {
  vi.restoreAllMocks();
  if (animations) Object.defineProperty(Element.prototype, 'getAnimations', animations);
  else Reflect.deleteProperty(Element.prototype, 'getAnimations');
});
describe('viewport stroke compatibility', () => {
  it('retains color alpha, width and exact routed path', () => {
    const { path, svg } = fixture();
    expect(readViewportEdgeStroke(path, svg)).toEqual({ path: 'M0 0 L200 100', color: [1, 1, 1, 0.26], width: 1.6, miterLimit: 4 });
  });
  it.each([
    ['stroke', 'url(#gradient)'], ['strokeWidth', '50%'], ['markerEnd', 'url(#arrow)'], ['strokeDasharray', '5px'],
    ['filter', 'blur(1px)'], ['transform', 'matrix(1,0,0,1,20,0)'], ['zIndex', '1000'], ['opacity', '0.5'],
  ])('leaves unsupported %s effects in the SVG layer', (property, value) => {
    computed.setProperty(property.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`), value);
    const { path, svg } = fixture();
    expect(readViewportEdgeStroke(path, svg)).toBeNull();
  });
  it('does not build an incomplete graph or mutate the SVG while collecting', async () => {
    const { layer } = fixture();
    expect(await collectViewportEdgeSnapshot(layer, MIN_VIEWPORT_EDGES, () => true, async () => {})).toBeNull();
    expect(layer.querySelector('[data-viewport-edge-cached]')).toBeNull();
  });
  it('cancels stale collection between batches before it can replace current geometry', async () => {
    const { layer } = fixture();
    const one = layer.innerHTML;
    layer.innerHTML = one.repeat(MIN_VIEWPORT_EDGES);
    let current = true;
    const yieldTask = vi.fn(async () => { current = false; });
    expect(await collectViewportEdgeSnapshot(layer, MIN_VIEWPORT_EDGES, () => current, yieldTask)).toBeNull();
    expect(yieldTask).toHaveBeenCalledOnce();
    expect(layer.querySelector('[data-viewport-edge-cached]')).toBeNull();
  });
  it('rejects a snapshot whose wrappers were replaced while collection yielded', async () => {
    const { layer } = fixture();
    layer.innerHTML = layer.innerHTML.repeat(MIN_VIEWPORT_EDGES);
    let replaced = false;
    const result = await collectViewportEdgeSnapshot(layer, MIN_VIEWPORT_EDGES, () => true, async () => {
      if (!replaced) { replaced = true; layer.innerHTML = layer.innerHTML; }
    });
    expect(result).toBeNull();
  });
  it('keeps the whole SVG stack when a special stroke shares its ordinary stacking level', async () => {
    const { layer } = fixture();
    layer.innerHTML = layer.innerHTML.repeat(MIN_VIEWPORT_EDGES + 1);
    const special = layer.querySelector('path');
    const effect = document.createElement('div').style;
    effect.cssText = computed.cssText; effect.markerEnd = 'url(#arrow)';
    vi.mocked(window.getComputedStyle).mockImplementation(element => element === special ? effect : computed);
    expect(await collectViewportEdgeSnapshot(layer, MIN_VIEWPORT_EDGES + 1, () => true, async () => {})).toBeNull();
  });
});
