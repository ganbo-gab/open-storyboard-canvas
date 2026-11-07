import { memo, useCallback, useRef, useEffect } from 'react';

export type LightPosition =
  | 'front'
  | 'back'
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'topLeft'
  | 'topRight';

// Continuous light angle in degrees (azimuth 0-360, elevation -90 to 90)
export interface LightAngles {
  azimuth: number;   // horizontal, 0 = front, 90 = right
  elevation: number; // vertical, 0 = horizon, 90 = top
}

function positionToAngles(pos: LightPosition): LightAngles {
  switch (pos) {
    case 'front':    return { azimuth: 0,   elevation: 0  };
    case 'back':     return { azimuth: 180, elevation: 0  };
    case 'left':     return { azimuth: 270, elevation: 0  };
    case 'right':    return { azimuth: 90,  elevation: 0  };
    case 'top':      return { azimuth: 0,   elevation: 80 };
    case 'bottom':   return { azimuth: 0,   elevation: -80};
    case 'topLeft':  return { azimuth: 315, elevation: 40 };
    case 'topRight': return { azimuth: 45,  elevation: 40 };
  }
}

function anglesToPosition(azimuth: number, elevation: number): LightPosition {
  if (elevation > 60) return 'top';
  if (elevation < -60) return 'bottom';
  const az = ((azimuth % 360) + 360) % 360;
  if (az < 45 || az >= 315) return 'front';
  if (az >= 45 && az < 135) return 'right';
  if (az >= 135 && az < 225) return 'back';
  return 'left';
}

function drawLightSphere(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  azimuth: number,
  elevation: number,
  previewImageUrl: string | null | undefined,
  viewMode: 'perspective' | 'front'
) {
  ctx.clearRect(0, 0, w, h);

  const theme = getComputedStyle(ctx.canvas);
  const textRgb = theme.getPropertyValue('--text-rgb').trim();

  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) / 2 - 4;

  // Theme-aware sphere surface; the simulated light below retains its physical colors.
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = `rgb(${theme.getPropertyValue('--surface-rgb').trim()})`;
  ctx.fill();

  // Sphere outline
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.strokeStyle = `rgb(${textRgb} / 0.2)`;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.clip();

  // Light cone from the light source position
  const azRad = (azimuth * Math.PI) / 180;
  const elRad = (elevation * Math.PI) / 180;

  // Light source position on sphere surface
  const lightX = viewMode === 'front'
    ? cx + R * Math.sin(azRad) * 0.85
    : cx + R * Math.sin(azRad) * Math.cos(elRad);
  const lightY = viewMode === 'front'
    ? cy - R * Math.sin(elRad) * 0.85
    : cy - R * Math.sin(elRad);

  // Draw light cone / gradient effect
  const gradRadius = R * 1.4;
  const grad = ctx.createRadialGradient(lightX, lightY, 0, lightX, lightY, gradRadius);
  grad.addColorStop(0, 'rgba(255,255,240,0.55)');
  grad.addColorStop(0.35, 'rgba(255,230,180,0.18)');
  grad.addColorStop(0.7, 'rgba(255,200,100,0.05)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Draw grid lines on sphere
  if (viewMode === 'front') {
    // Flat frontal grid view
    for (let i = -2; i <= 2; i++) {
      const x = cx + i * (R / 3);
      ctx.beginPath();
      ctx.moveTo(x, cy - R);
      ctx.lineTo(x, cy + R);
      ctx.strokeStyle = `rgb(${textRgb} / 0.07)`;
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }
    for (let i = -2; i <= 2; i++) {
      const y = cy + i * (R / 3);
      ctx.beginPath();
      ctx.moveTo(cx - R, y);
      ctx.lineTo(cx + R, y);
      ctx.strokeStyle = `rgb(${textRgb} / 0.07)`;
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }
  } else {
    for (let lat = -75; lat <= 75; lat += 15) {
      const latRad = (lat * Math.PI) / 180;
      const r = R * Math.cos(latRad);
      const baseY = cy - R * Math.sin(latRad);
      ctx.beginPath();
      ctx.ellipse(cx, baseY, r, r * 0.22, 0, 0, Math.PI * 2);
      ctx.strokeStyle = `rgb(${textRgb} / 0.07)`;
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }
    for (let i = 0; i < 8; i++) {
      const angle = (i * Math.PI) / 4;
      ctx.beginPath();
      ctx.ellipse(cx, cy, R * Math.abs(Math.cos(angle)), R, 0, 0, Math.PI * 2);
      ctx.strokeStyle = `rgb(${textRgb} / 0.07)`;
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }
  }

  // Draw preview image as a rectangular "subject" in center
  if (previewImageUrl) {
    const img = new Image();
    img.onload = () => {
      const iw = R * 0.5;
      const ih = R * 0.75;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = 12;
      ctx.drawImage(img, cx - iw / 2, cy - ih / 2, iw, ih);
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.lineWidth = 1;
      ctx.strokeRect(cx - iw / 2, cy - ih / 2, iw, ih);
      ctx.restore();
    };
    img.src = previewImageUrl;
  } else {
    // Silhouette placeholder
    const iw = R * 0.42;
    const ih = R * 0.65;
    ctx.fillStyle = `rgb(${textRgb} / 0.04)`;
    ctx.strokeStyle = `rgb(${textRgb} / 0.15)`;
    ctx.lineWidth = 1;
    ctx.fillRect(cx - iw / 2, cy - ih / 2, iw, ih);
    ctx.strokeRect(cx - iw / 2, cy - ih / 2, iw, ih);

    // Simple person shape
    ctx.fillStyle = `rgb(${textRgb} / 0.2)`;
    // head
    const headR = iw * 0.18;
    ctx.beginPath();
    ctx.arc(cx, cy - ih / 2 + headR + 4, headR, 0, Math.PI * 2);
    ctx.fill();
    // body
    ctx.fillRect(cx - iw * 0.15, cy - ih / 2 + headR * 2 + 6, iw * 0.3, ih * 0.35);
  }

  ctx.restore();

  // Draw light source dot + glow
  ctx.beginPath();
  const glowGrad = ctx.createRadialGradient(lightX, lightY, 0, lightX, lightY, 14);
  glowGrad.addColorStop(0, 'rgba(255,245,200,0.95)');
  glowGrad.addColorStop(0.4, 'rgba(255,220,120,0.5)');
  glowGrad.addColorStop(1, 'rgba(255,200,50,0)');
  ctx.fillStyle = glowGrad;
  ctx.arc(lightX, lightY, 14, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(lightX, lightY, 5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.fill();
}

interface LightingSphereControlProps {
  azimuth: number;
  elevation: number;
  onAngleChange: (azimuth: number, elevation: number) => void;
  previewImageUrl?: string | null;
  viewMode?: 'perspective' | 'front';
}

export const LightingSphereControl = memo(
  ({ azimuth, elevation, onAngleChange, previewImageUrl, viewMode = 'perspective' }: LightingSphereControlProps) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const isDraggingRef = useRef(false);
    const dragStartRef = useRef<{ x: number; y: number; az: number; el: number } | null>(null);

    const SIZE = 180;

    const redraw = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      drawLightSphere(ctx, SIZE, SIZE, azimuth, elevation, previewImageUrl, viewMode);
    }, [azimuth, elevation, previewImageUrl, viewMode]);

    useEffect(() => {
      redraw();
      const observer = new MutationObserver(redraw);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme-tone'] });
      return () => observer.disconnect();
    }, [redraw]);

    const handlePointerDown = useCallback((e: React.PointerEvent) => {
      e.preventDefault();
      isDraggingRef.current = true;
      dragStartRef.current = { x: e.clientX, y: e.clientY, az: azimuth, el: elevation };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    }, [azimuth, elevation]);

    const handlePointerMove = useCallback((e: React.PointerEvent) => {
      if (!isDraggingRef.current || !dragStartRef.current) return;
      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;
      let newAz = (dragStartRef.current.az + dx * 1.5) % 360;
      if (newAz < 0) newAz += 360;
      const newEl = Math.max(-90, Math.min(90, dragStartRef.current.el - dy));
      onAngleChange(Math.round(newAz), Math.round(newEl));
    }, [onAngleChange]);

    const handlePointerUp = useCallback((e: React.PointerEvent) => {
      isDraggingRef.current = false;
      dragStartRef.current = null;
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    }, []);

    return (
      <canvas
        ref={canvasRef}
        width={SIZE}
        height={SIZE}
        className="rounded-lg touch-none cursor-grab active:cursor-grabbing"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        style={{ display: 'block' }}
      />
    );
  }
);

LightingSphereControl.displayName = 'LightingSphereControl';

// Re-export helpers for backward compat
export { positionToAngles, anglesToPosition };
