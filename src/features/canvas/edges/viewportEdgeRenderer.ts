import { MAX_VIEWPORT_EDGE_FLOATS, VIEWPORT_EDGE_VERTEX_STRIDE } from './viewportEdgeGeometry';

export const MAX_VIEWPORT_EDGE_FRAMEBUFFER_PIXELS = 16_777_216;
export interface ViewportEdgeViewport { x: number; y: number; zoom: number }
export interface ViewportEdgeRenderer {
  setEdges(geometry: Float32Array): boolean;
  /** true means submitted successfully, not that the GPU has finished presenting. */
  draw(viewport: ViewportEdgeViewport, width: number, height: number, dpr: number): boolean;
  dispose(): void;
}

const VERTEX_SOURCE = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_position;
layout(location=1) in vec2 a_miter;
layout(location=2) in float a_side;
layout(location=3) in vec2 a_cap;
layout(location=4) in float a_length;
layout(location=5) in float a_total;
layout(location=6) in vec4 a_color;
layout(location=7) in float a_halfWidth;
uniform vec3 u_view;
uniform vec2 u_size;
uniform float u_dpr;
out vec4 v_color;
out float v_distance;
out float v_halfWidth;
out float v_length;
out float v_total;
void main() {
  float padding = 1.0 / u_dpr;
  vec2 screen = a_position * u_view.z + u_view.xy;
  screen += a_miter * a_side * (a_halfWidth * u_view.z + padding) + a_cap * padding;
  gl_Position = vec4(screen.x / u_size.x * 2.0 - 1.0, 1.0 - screen.y / u_size.y * 2.0, 0.0, 1.0);
  v_color = a_color;
  v_distance = a_side * (a_halfWidth * u_view.z * u_dpr + 1.0);
  v_halfWidth = a_halfWidth * u_view.z * u_dpr;
  float capSign = a_length == 0.0 ? -1.0 : a_length == a_total ? 1.0 : 0.0;
  v_length = a_length * u_view.z * u_dpr + capSign;
  v_total = a_total * u_view.z * u_dpr;
}`;
const FRAGMENT_SOURCE = `#version 300 es
precision highp float;
in vec4 v_color;
in float v_distance;
in float v_halfWidth;
in float v_length;
in float v_total;
out vec4 outColor;
void main() {
  float aa = max(fwidth(v_distance), 0.75);
  float lo = max(-v_halfWidth, v_distance - aa * 0.5);
  float hi = min(v_halfWidth, v_distance + aa * 0.5);
  float coverage = clamp((hi - lo) / aa, 0.0, 1.0);
  float capAA = max(fwidth(v_length), 0.75);
  coverage *= clamp(v_length / capAA + 0.5, 0.0, 1.0);
  coverage *= clamp((v_total - v_length) / capAA + 0.5, 0.0, 1.0);
  float alpha = v_color.a * coverage;
  outColor = vec4(v_color.rgb * alpha, alpha);
}`;

/** Owns GPU resources and this canvas's size/transform, never SVG visibility or app state. */
export function createViewportEdgeRenderer(canvas: HTMLCanvasElement, onContextLost: () => void): ViewportEdgeRenderer | null {
  let gl: WebGL2RenderingContext | null;
  try {
    gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: true,
      depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
  } catch { return null; }
  if (!gl) return null;
  const context = gl;
  let program: WebGLProgram | null = null, buffer: WebGLBuffer | null = null, vao: WebGLVertexArrayObject | null = null;
  const shaders: WebGLShader[] = [];
  let disposed = false, lost = false, notified = false, uploaded = false, vertexCount = 0;
  let pixelsWide = 0, pixelsHigh = 0;
  const notifyLoss = (): void => {
    lost = true;
    if (notified || disposed) return;
    notified = true;
    try { onContextLost(); } catch { /* Fallback callbacks must not interrupt the context-loss event. */ }
  };
  const handleLoss = (event: Event): void => { event.preventDefault(); notifyLoss(); };
  const freeResources = (): void => {
    if (vao) context.deleteVertexArray(vao);
    if (buffer) context.deleteBuffer(buffer);
    if (program) context.deleteProgram(program);
    for (const shader of shaders) context.deleteShader(shader);
    vao = null; buffer = null; program = null; shaders.length = 0;
  };
  const releaseContext = (): void => {
    try { context.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* Deletion remains sufficient if the extension is unavailable. */ }
  };
  const compile = (type: number, source: string): WebGLShader => {
    const shader = context.createShader(type);
    if (!shader) throw new Error('Shader allocation failed');
    shaders.push(shader);
    context.shaderSource(shader, source); context.compileShader(shader);
    if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) throw new Error('Shader compilation failed');
    return shader;
  };
  let viewLocation: WebGLUniformLocation | null = null, sizeLocation: WebGLUniformLocation | null = null, dprLocation: WebGLUniformLocation | null = null;
  let maximumDimension = 0;
  try {
    program = context.createProgram();
    if (!program) throw new Error('Program allocation failed');
    context.attachShader(program, compile(context.VERTEX_SHADER, VERTEX_SOURCE));
    context.attachShader(program, compile(context.FRAGMENT_SHADER, FRAGMENT_SOURCE));
    context.linkProgram(program);
    if (!context.getProgramParameter(program, context.LINK_STATUS)) throw new Error('Program linking failed');
    viewLocation = context.getUniformLocation(program, 'u_view');
    sizeLocation = context.getUniformLocation(program, 'u_size');
    dprLocation = context.getUniformLocation(program, 'u_dpr');
    if (viewLocation === null || sizeLocation === null || dprLocation === null) throw new Error('Uniforms unavailable');
    buffer = context.createBuffer(); vao = context.createVertexArray();
    if (!buffer || !vao) throw new Error('Geometry allocation failed');
    context.bindVertexArray(vao); context.bindBuffer(context.ARRAY_BUFFER, buffer);
    let offset = 0;
    const attributes: readonly (readonly [number, number])[] = [[0, 2], [1, 2], [2, 1], [3, 2], [4, 1], [5, 1], [6, 4], [7, 1]];
    for (const [location, size] of attributes) {
      context.enableVertexAttribArray(location);
      context.vertexAttribPointer(location, size, context.FLOAT, false, VIEWPORT_EDGE_VERTEX_STRIDE * 4, offset * 4);
      offset += size;
    }
    context.enable(context.BLEND);
    context.blendFunc(context.ONE, context.ONE_MINUS_SRC_ALPHA);
    context.disable(context.DEPTH_TEST); context.disable(context.CULL_FACE);
    context.clearColor(0, 0, 0, 0);
    const maximum: unknown = context.getParameter(context.MAX_RENDERBUFFER_SIZE);
    maximumDimension = typeof maximum === 'number' && Number.isFinite(maximum) ? maximum : 0;
    if (maximumDimension <= 0 || context.getError() !== context.NO_ERROR || context.isContextLost()) throw new Error('Context initialization failed');
    canvas.addEventListener('webglcontextlost', handleLoss);
  } catch { freeResources(); releaseContext(); return null; }

  const usable = (): boolean => {
    if (disposed || lost) return false;
    if (context.isContextLost()) { notifyLoss(); return false; }
    return true;
  };
  return {
    setEdges(geometry) {
      if (!usable()) return false;
      uploaded = false; vertexCount = 0;
      if (!(geometry instanceof Float32Array) || geometry.length > MAX_VIEWPORT_EDGE_FLOATS
        || geometry.length % (VIEWPORT_EDGE_VERTEX_STRIDE * 3) !== 0) return false;
      for (let i = 0; i < geometry.length; i++) if (!Number.isFinite(geometry[i])) return false;
      try {
        context.bindBuffer(context.ARRAY_BUFFER, buffer);
        context.bufferData(context.ARRAY_BUFFER, geometry, context.STATIC_DRAW);
        if (context.getError() !== context.NO_ERROR || !usable()) return false;
        vertexCount = geometry.length / VIEWPORT_EDGE_VERTEX_STRIDE; uploaded = true;
        return true;
      } catch { return false; }
    },
    draw(viewport, width, height, dpr) {
      if (!usable() || !uploaded || ![viewport.x, viewport.y, viewport.zoom, width, height, dpr].every(Number.isFinite)
        || viewport.zoom <= 0 || width <= 0 || height <= 0 || dpr <= 0) return false;
      const nextWidth = Math.ceil(width * dpr), nextHeight = Math.ceil(height * dpr);
      if (nextWidth > maximumDimension || nextHeight > maximumDimension
        || nextWidth * nextHeight > MAX_VIEWPORT_EDGE_FRAMEBUFFER_PIXELS) return false;
      try {
        if (nextWidth !== pixelsWide || nextHeight !== pixelsHigh) {
          canvas.width = nextWidth; canvas.height = nextHeight;
          context.viewport(0, 0, nextWidth, nextHeight);
          if (context.getError() !== context.NO_ERROR) return false;
          pixelsWide = nextWidth; pixelsHigh = nextHeight;
        }
        canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
        canvas.style.transform = `translate(${-viewport.x / viewport.zoom}px,${-viewport.y / viewport.zoom}px) scale(${1 / viewport.zoom})`;
        context.useProgram(program); context.bindVertexArray(vao);
        context.uniform3f(viewLocation, viewport.x, viewport.y, viewport.zoom);
        context.uniform2f(sizeLocation, width, height); context.uniform1f(dprLocation, dpr);
        context.clear(context.COLOR_BUFFER_BIT);
        if (vertexCount) context.drawArrays(context.TRIANGLES, 0, vertexCount);
        return usable();
      } catch { return false; }
    },
    dispose() {
      if (disposed) return;
      disposed = true; uploaded = false;
      canvas.removeEventListener('webglcontextlost', handleLoss);
      freeResources();
      releaseContext();
    },
  };
}
