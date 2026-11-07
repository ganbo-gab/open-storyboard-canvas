import { describe, expect, it } from 'vitest';
import type { ModelSpec, RefSlot } from '../domain/profile';
import { resolveImageMode } from './imageModeSelection';

const mode = (id: string, operation: 'image.generate' | 'image.edit', slots: RefSlot[] = []) => ({ id, label: id, operation, slots });
const imageSlot = (min = 0, max = 4): RefSlot[] => [{ key: 'images', label: 'Images', kind: 'image', min, max }];
const model = (modes: ModelSpec['modes']): ModelSpec => ({ id: 'image', operations: ['image.generate', 'image.edit'], params: [], modes });

describe('automatic image mode selection', () => {
  it('strictly resolves an explicit mode and preserves legacy implicit mode behavior', () => {
    const explicit = model([mode('text', 'image.generate'), mode('edit', 'image.edit', imageSlot(1))]);
    expect(resolveImageMode(explicit, 0, 'edit').mode.id).toBe('edit');
    expect(() => resolveImageMode(explicit, 0, 'missing')).toThrow('未声明模式');
    const legacy: ModelSpec = { id: 'legacy', operations: ['image.generate', 'image.edit'], params: [], refs: { image: 4 } };
    expect(resolveImageMode(legacy, 2).mode.id).toBe('default');
  });
  it('selects the only no-input generate mode without images', () => {
    const resolved = resolveImageMode(model([mode('text', 'image.generate'), mode('edit', 'image.edit', imageSlot(1))]), 0);
    expect(resolved.mode.id).toBe('text');
  });
  it('selects a single image edit mode when all required capacity is satisfied', () => {
    const resolved = resolveImageMode(model([mode('text', 'image.generate'), mode('edit', 'image.edit', imageSlot(1, 2))]), 2);
    expect(resolved.mode.id).toBe('edit');
  });
  it('uses image generation with a single optional image slot when no edit mode is available', () => {
    const resolved = resolveImageMode(model([mode('generate', 'image.generate', imageSlot(0, 3))]), 2);
    expect(resolved.mode.id).toBe('generate');
  });
  it('does not select an edit mode with required non-image input or let an ambiguous edit set fall back to generation', () => {
    const requiredAudio: RefSlot = { key: 'audio', label: 'Audio', kind: 'audio', min: 1, max: 1 };
    expect(resolveImageMode(model([mode('edit', 'image.edit', [...imageSlot(1), requiredAudio]), mode('generate', 'image.generate', imageSlot())]), 1).mode.id).toBe('generate');
    expect(() => resolveImageMode(model([mode('one', 'image.edit', imageSlot()), mode('two', 'image.edit', imageSlot()), mode('generate', 'image.generate', imageSlot())]), 1)).toThrow('多个模式');
  });
  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid automatic image count %s', count => {
    expect(() => resolveImageMode(model([mode('text', 'image.generate')]), count)).toThrow('数量无效');
  });
  it('rejects ambiguous modes, multi-slot role guessing, and missing capacity with actionable errors', () => {
    expect(() => resolveImageMode(model([mode('one', 'image.generate'), mode('two', 'image.generate')]), 0)).toThrow('多个模式');
    expect(() => resolveImageMode(model([mode('edit', 'image.edit', [...imageSlot(0), { key: 'mask', label: 'Mask', kind: 'image', max: 1 }])]), 1)).toThrow('没有可自动接入');
    expect(() => resolveImageMode(model([mode('edit', 'image.edit', imageSlot(2))]), 1)).toThrow('没有可自动接入');
    expect(() => resolveImageMode(model([mode('text', 'image.generate', [{ key: 'style', label: 'Style', kind: 'image' as const, min: 1, max: 1 }])]), 0)).toThrow('文生图');
  });
});
