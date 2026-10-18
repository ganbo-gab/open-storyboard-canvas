import { describe, expect, it } from 'vitest';

import {
  createWheelClassifier,
  guessWheelDevice,
  resolveWheelIntent,
  zoomAround,
  type WheelSample,
} from './viewportMath';

function sample(overrides: Partial<WheelSample>): WheelSample {
  return {
    deltaX: 0,
    deltaY: 0,
    deltaMode: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    wheelDeltaY: 0,
    timeStamp: 0,
    ...overrides,
  };
}

describe('guessWheelDevice', () => {
  it('treats a Windows-style mouse notch as a mouse', () => {
    expect(guessWheelDevice(sample({ deltaY: 100, wheelDeltaY: -120 }))).toBe('mouse');
  });

  it('treats line-mode deltas as a mouse', () => {
    expect(guessWheelDevice(sample({ deltaY: 3, deltaMode: 1 }))).toBe('mouse');
  });

  it('keeps trackpad scrolls whose legacy delta happens to be a multiple of 120', () => {
    // macOS trackpads report wheelDeltaY === -3 * deltaY.
    expect(guessWheelDevice(sample({ deltaY: 40, wheelDeltaY: -120 }))).toBe('trackpad');
  });

  it('treats horizontal or fractional motion as a trackpad', () => {
    expect(guessWheelDevice(sample({ deltaX: 6, deltaY: 2 }))).toBe('trackpad');
    expect(guessWheelDevice(sample({ deltaY: 2.5, wheelDeltaY: -7 }))).toBe('trackpad');
  });
});

describe('createWheelClassifier', () => {
  it('keeps the first guess for the rest of a burst so momentum never flips modes', () => {
    const classifier = createWheelClassifier();
    expect(classifier.classify(sample({ deltaY: 4, wheelDeltaY: -12, timeStamp: 0 }))).toBe('trackpad');
    expect(classifier.classify(sample({ deltaY: 120, wheelDeltaY: -120, timeStamp: 40 }))).toBe('trackpad');
    expect(classifier.classify(sample({ deltaY: 100, wheelDeltaY: -120, timeStamp: 1000 }))).toBe('mouse');
  });
});

describe('resolveWheelIntent', () => {
  it('pans with trackpad scroll and zooms with a mouse wheel in auto mode', () => {
    expect(resolveWheelIntent(sample({ deltaX: 10, deltaY: 20 }), 'trackpad', 'auto', 800))
      .toEqual({ kind: 'pan', dx: -10, dy: -20 });
    const zoom = resolveWheelIntent(sample({ deltaY: -100 }), 'mouse', 'auto', 800);
    expect(zoom.kind).toBe('zoom');
    expect(zoom.kind === 'zoom' && zoom.factor).toBeGreaterThan(1);
  });

  it('always zooms with ctrl/cmd, including trackpad pinch', () => {
    const pinch = resolveWheelIntent(sample({ deltaY: 5, ctrlKey: true }), 'trackpad', 'pan', 800);
    expect(pinch.kind === 'zoom' && pinch.factor).toBeLessThan(1);
  });

  it('honours an explicit pan mode for mouse wheels and maps shift to horizontal', () => {
    expect(resolveWheelIntent(sample({ deltaY: 100, shiftKey: true }), 'mouse', 'pan', 800))
      .toEqual({ kind: 'pan', dx: -100, dy: 0 });
  });

  it('bounds a single notch so platform delta inflation cannot jump the zoom', () => {
    const intent = resolveWheelIntent(sample({ deltaY: -2000 }), 'mouse', 'zoom', 800);
    expect(intent.kind === 'zoom' && intent.factor).toBeLessThanOrEqual(1.6);
  });
});

describe('zoomAround', () => {
  it('keeps the flow point under the cursor fixed', () => {
    const before = { x: 100, y: 50, zoom: 1 };
    const after = zoomAround(before, 2, 300, 250, 0.1, 8);
    const flowBefore = { x: (300 - before.x) / before.zoom, y: (250 - before.y) / before.zoom };
    const flowAfter = { x: (300 - after.x) / after.zoom, y: (250 - after.y) / after.zoom };
    expect(flowAfter.x).toBeCloseTo(flowBefore.x);
    expect(flowAfter.y).toBeCloseTo(flowBefore.y);
  });

  it('clamps to the zoom range and returns the same viewport when clamped flat', () => {
    const viewport = { x: 0, y: 0, zoom: 8 };
    expect(zoomAround(viewport, 2, 0, 0, 0.1, 8)).toBe(viewport);
  });
});
