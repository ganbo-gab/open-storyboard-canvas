import { describe, expect, it } from 'vitest';

import {
  IMAGE_RESOLUTION_TIER_TARGET_PIXELS,
  MODERN_OPENAI_IMAGE_OUTPUT_LIMITS,
  parseImageAspectRatio,
  resolveImageOutputGeometry,
  type ResolvedImageOutputGeometry,
} from './imageOutputGeometry';

const RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', '2:1', '4:1'] as const;
const TIERS = ['1K', '2K', '4K'] as const;

function expectValidPixelResult(
  result: ReturnType<typeof resolveImageOutputGeometry>,
): ResolvedImageOutputGeometry & { width: number; height: number } {
  expect(result.ok).toBe(true);
  if (!result.ok || result.width === null || result.height === null) {
    throw new Error('Expected a resolved pixel size');
  }
  return result as ResolvedImageOutputGeometry & { width: number; height: number };
}

describe('resolveImageOutputGeometry', () => {
  it.each(RATIOS)('keeps 4K %s under the modern OpenAI pixel contract', (ratio) => {
    const result = expectValidPixelResult(resolveImageOutputGeometry({
      aspectRatio: ratio,
      selectedSize: '4K',
      limits: MODERN_OPENAI_IMAGE_OUTPUT_LIMITS,
    }));
    const expectedRatio = parseImageAspectRatio(ratio) ?? 1;

    expect(result.width * result.height).toBeLessThanOrEqual(8_294_400);
    expect(result.width % 8).toBe(0);
    expect(result.height % 8).toBe(0);
    expect(Math.abs((result.width / result.height) / expectedRatio - 1)).toBeLessThan(0.005);
    expect(result.diagnostic.source).toBe('tier-derived');
  });

  it.each(TIERS)('derives every supported ratio from the %s area target', (tier) => {
    for (const ratio of RATIOS) {
      const result = expectValidPixelResult(resolveImageOutputGeometry({
        aspectRatio: ratio,
        selectedSize: tier,
        limits: { alignment: 8 },
      }));
      const normalizedTier = tier.toLowerCase() as keyof typeof IMAGE_RESOLUTION_TIER_TARGET_PIXELS;
      expect(result.width * result.height).toBeLessThanOrEqual(
        IMAGE_RESOLUTION_TIER_TARGET_PIXELS[normalizedTier],
      );
      expect(result.diagnostic.targetPixels).toBe(
        IMAGE_RESOLUTION_TIER_TARGET_PIXELS[normalizedTier],
      );
    }
  });

  it.each(TIERS)('keeps every %s ratio inside combined provider constraints', (tier) => {
    for (const ratio of RATIOS) {
      const result = expectValidPixelResult(resolveImageOutputGeometry({
        aspectRatio: ratio,
        selectedSize: tier,
        limits: {
          maxPixels: 5_000_000,
          maxWidth: 3000,
          maxHeight: 2500,
          alignment: 8,
        },
      }));
      const expectedRatio = parseImageAspectRatio(ratio) ?? 1;
      expect(result.width * result.height).toBeLessThanOrEqual(5_000_000);
      expect(result.width).toBeLessThanOrEqual(3000);
      expect(result.height).toBeLessThanOrEqual(2500);
      expect(result.width % 8).toBe(0);
      expect(result.height % 8).toBe(0);
      expect(Math.abs((result.width / result.height) / expectedRatio - 1)).toBeLessThan(0.005);
    }
  });

  it('fixes the reported 3:4 4K case without reversing its orientation', () => {
    const result = expectValidPixelResult(resolveImageOutputGeometry({
      aspectRatio: '3:4',
      selectedSize: '4K',
      limits: MODERN_OPENAI_IMAGE_OUTPUT_LIMITS,
    }));

    expect(result.width).toBeLessThan(result.height);
    expect(result.width * result.height).toBeLessThanOrEqual(8_294_400);
    expect(result.size).not.toBe('2880x3840');
  });

  it('preserves an explicit valid pixel size', () => {
    const result = expectValidPixelResult(resolveImageOutputGeometry({
      aspectRatio: '3:4',
      selectedSize: '1536\u00d72048',
      limits: MODERN_OPENAI_IMAGE_OUTPUT_LIMITS,
    }));

    expect(result.size).toBe('1536x2048');
    expect(result.source).toBe('explicit-pixel-size');
    expect(result.diagnostic.status).toBe('valid');
  });

  it('rejects an explicit size that exceeds a known limit', () => {
    const result = resolveImageOutputGeometry({
      aspectRatio: '3:4',
      selectedSize: '2880x3840',
      limits: MODERN_OPENAI_IMAGE_OUTPUT_LIMITS,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('2880x3840');
    expect(result.error).toContain('8,294,400');
    expect(result.diagnostic).toMatchObject({
      code: 'explicit-size-exceeds-limits',
      source: 'explicit-pixel-size',
      violations: [expect.objectContaining({ constraint: 'maxPixels' })],
    });
  });

  it('treats a ratio mapping as explicit and never silently changes it', () => {
    const result = resolveImageOutputGeometry({
      aspectRatio: '3:4',
      selectedSize: '4K',
      mappedSize: '2880x3840',
      limits: MODERN_OPENAI_IMAGE_OUTPUT_LIMITS,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.source).toBe('ratio-mapping');
    expect(result.diagnostic.resolvedSize).toBe('2880x3840');
  });

  it('uses a provider-declared exact pixel size before deriving a tier', () => {
    const result = expectValidPixelResult(resolveImageOutputGeometry({
      aspectRatio: '16:9',
      selectedSize: '2K',
      supportedPixelSizes: ['1024x1024', '1536x1024', '1792x1024'],
      limits: { maxPixels: 8_294_400 },
    }));

    expect(result.size).toBe('1792x1024');
    expect(result.source).toBe('provider-supported-size');
  });

  it('rejects contradictory provider exact-size and limit declarations', () => {
    const result = resolveImageOutputGeometry({
      aspectRatio: '16:9',
      selectedSize: '4K',
      supportedPixelSizes: ['5120x2880'],
      limits: { maxPixels: 8_294_400 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.source).toBe('provider-supported-size');
    expect(result.diagnostic.suggestedActions).toContain('review-provider-limits');
  });

  it('applies the strictest width, height, pixel and alignment constraint to inferred tiers', () => {
    const result = expectValidPixelResult(resolveImageOutputGeometry({
      aspectRatio: '16:9',
      selectedSize: '4K',
      limits: {
        maxPixels: 4_000_000,
        maxWidth: 2400,
        maxHeight: 1200,
        alignment: 64,
      },
    }));

    expect(result.width).toBeLessThanOrEqual(2400);
    expect(result.height).toBeLessThanOrEqual(1200);
    expect(result.width * result.height).toBeLessThanOrEqual(4_000_000);
    expect(result.width % 64).toBe(0);
    expect(result.height % 64).toBe(0);
    expect(Math.abs((result.width / result.height) / (16 / 9) - 1)).toBeLessThan(0.005);
    expect(result.diagnostic.code).toBe('inferred-scaled-to-limits');
  });

  it('reports contradictory alignment and dimension limits instead of returning an invalid size', () => {
    const result = resolveImageOutputGeometry({
      aspectRatio: '16:9',
      selectedSize: '4K',
      limits: { maxWidth: 32, maxHeight: 32, alignment: 64 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.code).toBe('constraints-unsatisfiable');
    expect(result.diagnostic.suggestedActions).toEqual(['review-provider-limits']);
  });

  it('passes auto through without inventing pixel dimensions', () => {
    const result = resolveImageOutputGeometry({
      aspectRatio: 'auto',
      selectedSize: 'auto',
      limits: MODERN_OPENAI_IMAGE_OUTPUT_LIMITS,
    });

    expect(result).toMatchObject({
      ok: true,
      size: 'auto',
      width: null,
      height: null,
      source: 'automatic',
      diagnostic: { code: 'automatic-size' },
    });
  });
});
