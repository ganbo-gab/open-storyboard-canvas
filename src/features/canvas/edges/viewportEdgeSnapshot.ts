import type { ViewportEdgeInput } from './viewportEdgeGeometry';

export const MIN_VIEWPORT_EDGES = 160;
const SNAPSHOT_BATCH_SIZE = 24;

export interface ViewportEdgeSnapshot {
  inputs: ViewportEdgeInput[];
  sources: Map<string, string>;
  elements: SVGSVGElement[];
}

function hasUnsupportedEffect(style: CSSStyleDeclaration): boolean {
  return ['filter', 'backdrop-filter', 'clip-path', 'mask-image', 'transform'].some(property => {
    const value = style.getPropertyValue(property);
    return value !== '' && value !== 'none';
  }) || (style.mixBlendMode !== '' && style.mixBlendMode !== 'normal');
}

/** The fast layer handles ordinary product strokes; SVG retains every unsupported effect. */
export function readViewportEdgeStroke(path: SVGPathElement, svg: SVGSVGElement): ViewportEdgeInput | null {
  const style = getComputedStyle(path);
  if (style.display === 'none' || style.visibility !== 'visible' || style.fill !== 'none'
    || style.strokeDasharray !== 'none' || Number.parseFloat(style.strokeDashoffset) !== 0
    || style.strokeLinecap !== 'butt' || style.strokeLinejoin !== 'miter'
    || (style.vectorEffect && style.vectorEffect !== 'none')
    || [style.markerStart, style.markerMid, style.markerEnd].some(value => value && value !== 'none')) return null;
  let opacity = Number(style.strokeOpacity) * Number(style.opacity);
  for (let parent: Element | null = path; parent; parent = parent.parentElement) {
    const current = parent === path ? style : getComputedStyle(parent);
    if (hasUnsupportedEffect(current) || current.display === 'none' || current.visibility !== 'visible'
      || parent.getAnimations().some(animation => animation.playState === 'running')
      || (parent !== path && Number(current.opacity) !== 1)) return null;
    if (parent === svg) {
      if (Number(current.zIndex) !== 0) return null;
      break;
    }
  }
  const match = /^rgba?\(([^)]+)\)$/.exec(style.stroke);
  if (!match) return null;
  const values = match[1].trim().split(/[\s,/]+/);
  if (values.length !== 3 && values.length !== 4) return null;
  const rgb = values.slice(0, 3).map(value => Number.parseFloat(value) / (value.endsWith('%') ? 100 : 255));
  if (values.length === 4) opacity *= Number.parseFloat(values[3]) / (values[3].endsWith('%') ? 100 : 1);
  if ([...rgb, opacity].some(value => !Number.isFinite(value) || value < 0 || value > 1) || opacity === 0) return null;
  if (!/^(?:\d*\.\d+|\d+\.?\d*)(?:px)?$/.test(style.strokeWidth)) return null;
  const width = Number.parseFloat(style.strokeWidth);
  const miterLimit = Number(style.strokeMiterlimit);
  const d = path.getAttribute('d');
  if (!d || !Number.isFinite(width) || width <= 0 || !Number.isFinite(miterLimit)) return null;
  return { path: d, color: [rgb[0], rgb[1], rgb[2], opacity], width, miterLimit };
}

/** Read in small idle batches so preparing a large graph never occupies an entire gesture. */
export async function collectViewportEdgeSnapshot(
  layer: Element,
  expected: number,
  stillCurrent: () => boolean,
  yieldTask: () => Promise<void>,
): Promise<ViewportEdgeSnapshot | null> {
  const paths = [...layer.querySelectorAll<SVGPathElement>('.canvas-edge__base')];
  if (paths.length < MIN_VIEWPORT_EDGES || paths.length !== expected) return null;
  const inputs: ViewportEdgeInput[] = [], sources = new Map<string, string>(), elements: SVGSVGElement[] = [];
  for (let index = 0; index < paths.length; index += 1) {
    if (!stillCurrent()) return null;
    const path = paths[index];
    const svg = path.closest('svg');
    const edgeId = path.closest('.react-flow__edge')?.getAttribute('data-id');
    if (svg instanceof SVGSVGElement && edgeId) {
      const stroke = readViewportEdgeStroke(path, svg);
      if (stroke) { inputs.push(stroke); sources.set(edgeId, stroke.path); elements.push(svg); }
      else {
        // Splitting strokes at the same stacking level would reorder translucent overlaps.
        // Elevated/lowered SVGs retain their own level; ordinary unsupported ink keeps all SVGs.
        const stacking = Number(getComputedStyle(svg).zIndex);
        if (!Number.isFinite(stacking) || stacking === 0) return null;
      }
    }
    if ((index + 1) % SNAPSHOT_BATCH_SIZE === 0) await yieldTask();
  }
  return stillCurrent() && inputs.length >= MIN_VIEWPORT_EDGES
    && elements.every(element => layer.contains(element)) ? { inputs, sources, elements } : null;
}
