import { describe, expect, it, vi } from 'vitest';
import { buildViewportEdgeGeometry } from './viewportEdgeGeometry';
import { createViewportEdgeRenderer } from './viewportEdgeRenderer';

interface Options { unsupported?: boolean; shaderFailure?: number; linkFailure?: boolean; bufferFailure?: boolean }
function harness(options: Options = {}) {
  let shaderCount = 0, lost = false, nextError = 0;
  const loseContext = vi.fn();
  const context = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4, ARRAY_BUFFER: 5, FLOAT: 6,
    BLEND: 7, ONE: 8, ONE_MINUS_SRC_ALPHA: 9, DEPTH_TEST: 10, CULL_FACE: 11, MAX_RENDERBUFFER_SIZE: 12,
    NO_ERROR: 0, STATIC_DRAW: 13, COLOR_BUFFER_BIT: 14, TRIANGLES: 15,
    createShader: vi.fn(() => ({ index: ++shaderCount })), shaderSource: vi.fn(), compileShader: vi.fn(),
    getShaderParameter: vi.fn((shader: { index: number }) => shader.index !== options.shaderFailure),
    createProgram: vi.fn(() => ({})), attachShader: vi.fn(), linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => !options.linkFailure), getUniformLocation: vi.fn((_program: unknown, name: string) => ({ name })),
    createBuffer: vi.fn(() => options.bufferFailure ? null : {}), createVertexArray: vi.fn(() => ({})),
    bindVertexArray: vi.fn(), bindBuffer: vi.fn(), enableVertexAttribArray: vi.fn(), vertexAttribPointer: vi.fn(),
    enable: vi.fn(), blendFunc: vi.fn(), disable: vi.fn(), clearColor: vi.fn(),
    getParameter: vi.fn(() => 8192), getError: vi.fn(() => { const error = nextError; nextError = 0; return error; }),
    isContextLost: vi.fn(() => lost), bufferData: vi.fn(), viewport: vi.fn(), useProgram: vi.fn(),
    uniform3f: vi.fn(), uniform2f: vi.fn(), uniform1f: vi.fn(), clear: vi.fn(), drawArrays: vi.fn(),
    deleteVertexArray: vi.fn(), deleteBuffer: vi.fn(), deleteProgram: vi.fn(), deleteShader: vi.fn(),
    getExtension: vi.fn(() => ({ loseContext })),
  };
  const canvas = Object.assign(new EventTarget(), { width: 0, height: 0, style: { width: '', height: '', transform: '' },
    getContext: vi.fn(() => options.unsupported ? null : context as unknown as WebGL2RenderingContext) });
  const onLost = vi.fn();
  const renderer = createViewportEdgeRenderer(canvas as unknown as HTMLCanvasElement, onLost);
  return { renderer, canvas, context, loseContext, onLost, setLost: () => { lost = true; }, setError: () => { nextError = 1285; } };
}
function geometry(): Float32Array {
  const data = buildViewportEdgeGeometry([{ path: 'M0 0L100 0', width: 1.6, color: [0.2, 0.4, 0.8, 0.26], miterLimit: 4 }]);
  if (!data) throw new Error('Fixture geometry missing');
  return data;
}

describe('viewport edge GPU resource owner', () => {
  it('uploads one ordered triangle buffer and draws with DPR and inverse viewport coordinates', () => {
    const h = harness(), data = geometry();
    expect(h.renderer?.setEdges(data)).toBe(true);
    expect(h.renderer?.draw({ x: 20, y: 50, zoom: 0.1 }, 800, 600, 2)).toBe(true);
    expect([h.canvas.width, h.canvas.height]).toEqual([1600, 1200]);
    expect(h.canvas.style).toEqual({ width: '800px', height: '600px', transform: 'translate(-200px,-500px) scale(10)' });
    expect(h.context.uniform3f).toHaveBeenCalledWith({ name: 'u_view' }, 20, 50, 0.1);
    expect(h.context.uniform2f).toHaveBeenCalledWith({ name: 'u_size' }, 800, 600);
    expect(h.context.uniform1f).toHaveBeenCalledWith({ name: 'u_dpr' }, 2);
    expect(h.context.bufferData).toHaveBeenCalledExactlyOnceWith(h.context.ARRAY_BUFFER, data, h.context.STATIC_DRAW);
    expect(h.context.drawArrays).toHaveBeenCalledExactlyOnceWith(h.context.TRIANGLES, 0, 6);
    h.renderer?.dispose();
  });

  it('outputs premultiplied color once and uses the matching source-over blend factors', () => {
    const h = harness();
    const fragment = h.context.shaderSource.mock.calls.find(([shader]) => (shader as { index: number }).index === 2)?.[1] as string;
    expect(fragment).toContain('vec4(v_color.rgb * alpha, alpha)');
    expect(h.context.blendFunc).toHaveBeenCalledExactlyOnceWith(h.context.ONE, h.context.ONE_MINUS_SRC_ALPHA);
    expect(h.canvas.getContext).toHaveBeenCalledWith('webgl2', expect.objectContaining({ alpha: true, premultipliedAlpha: true }));
    h.renderer?.dispose();
  });

  it('resizes the framebuffer only when dimensions or DPR change and clears an empty buffer safely', () => {
    const h = harness();
    expect(h.renderer?.draw({ x: 0, y: 0, zoom: 1 }, 800, 600, 2)).toBe(false);
    h.renderer?.setEdges(new Float32Array());
    expect(h.renderer?.draw({ x: 0, y: 0, zoom: 1 }, 800, 600, 2)).toBe(true);
    h.renderer?.draw({ x: 100, y: 100, zoom: 2 }, 800, 600, 2);
    expect(h.context.viewport).toHaveBeenCalledTimes(1);
    h.renderer?.draw({ x: 100, y: 100, zoom: 2 }, 800, 600, 1);
    expect(h.context.viewport).toHaveBeenCalledTimes(2);
    expect(h.context.drawArrays).not.toHaveBeenCalled();
    h.renderer?.dispose();
  });

  it('rejects invalid uploads and unbounded or invalid frame sizes before drawing stale geometry', () => {
    const h = harness(); h.renderer?.setEdges(geometry());
    expect(h.renderer?.setEdges(new Float32Array([NaN]))).toBe(false);
    expect(h.renderer?.draw({ x: 0, y: 0, zoom: 1 }, 800, 600, 2)).toBe(false);
    h.renderer?.setEdges(geometry());
    for (const size of [[0, 600, 2], [800, 600, NaN], [8000, 8000, 2], [8192, 8192, 1]]) {
      expect(h.renderer?.draw({ x: 0, y: 0, zoom: 1 }, size[0], size[1], size[2])).toBe(false);
    }
    expect(h.renderer?.draw({ x: NaN, y: 0, zoom: 1 }, 800, 600, 2)).toBe(false);
    expect(h.renderer?.draw({ x: 0, y: 0, zoom: 0 }, 800, 600, 2)).toBe(false);
    expect(h.context.drawArrays).not.toHaveBeenCalled();
    h.renderer?.dispose();
  });

  it.each([{ shaderFailure: 1 }, { shaderFailure: 2 }, { linkFailure: true }, { bufferFailure: true }])('cleans allocated resources when initialization fails: %j', options => {
    const h = harness(options);
    expect(h.renderer).toBeNull();
    expect(h.context.deleteProgram).toHaveBeenCalledOnce();
    expect(h.context.deleteShader).toHaveBeenCalledTimes(options.shaderFailure === 1 ? 1 : 2);
    if (options.bufferFailure) expect(h.context.deleteVertexArray).toHaveBeenCalledOnce();
    expect(h.loseContext).toHaveBeenCalledOnce();
    expect(h.onLost).not.toHaveBeenCalled();
  });

  it('falls back if WebGL2 is unavailable or the geometry allocation fails', () => {
    expect(harness({ unsupported: true }).renderer).toBeNull();
    const h = harness(); h.setError();
    expect(h.renderer?.setEdges(geometry())).toBe(false);
    expect(h.renderer?.draw({ x: 0, y: 0, zoom: 1 }, 800, 600, 2)).toBe(false);
    h.renderer?.dispose();
  });

  it('notifies loss once, refuses later draws, and destroys resources once on unmount', () => {
    const h = harness(); h.renderer?.setEdges(geometry());
    const event = new Event('webglcontextlost', { cancelable: true });
    h.canvas.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    h.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(h.onLost).toHaveBeenCalledOnce();
    expect(h.renderer?.draw({ x: 0, y: 0, zoom: 1 }, 800, 600, 2)).toBe(false);
    expect(h.renderer?.setEdges(geometry())).toBe(false);
    h.renderer?.dispose(); h.renderer?.dispose();
    expect(h.context.deleteBuffer).toHaveBeenCalledOnce();
    expect(h.context.deleteVertexArray).toHaveBeenCalledOnce();
    expect(h.context.deleteProgram).toHaveBeenCalledOnce();
    expect(h.loseContext).toHaveBeenCalledOnce();
    h.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(h.onLost).toHaveBeenCalledOnce();
  });

  it('detects context loss even before the event is dispatched', () => {
    const h = harness(); h.renderer?.setEdges(geometry()); h.setLost();
    expect(h.renderer?.draw({ x: 0, y: 0, zoom: 1 }, 800, 600, 2)).toBe(false);
    expect(h.onLost).toHaveBeenCalledOnce();
    h.renderer?.dispose();
  });
});
