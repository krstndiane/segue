import { describe, expect, it } from 'vitest';
import { clampOffset, cropRect, photoProblem } from '../src/components/AvatarCropper';

describe('photo choice', () => {
  it('accepts JPEG, PNG and WebP under 15 MB', () => {
    expect(photoProblem({ type: 'image/jpeg', size: 4_000_000 })).toBeNull();
    expect(photoProblem({ type: 'image/png', size: 1 })).toBeNull();
    expect(photoProblem({ type: 'image/webp', size: 1 })).toBeNull();
  });
  it('explains what is wrong with anything else', () => {
    expect(photoProblem({ type: 'image/gif', size: 1 })).toMatch(/JPEG, PNG or WebP/);
    expect(photoProblem({ type: 'image/heic', size: 1 })).toMatch(/JPEG, PNG or WebP/);
    expect(photoProblem({ type: 'image/png', size: 16 * 1024 * 1024 })).toMatch(/too large/);
  });
});

describe('cropping', () => {
  it('keeps the middle square of a wide photo at 1x', () => {
    const r = cropRect(2000, 1000, 1, 0, 0);
    expect(r.size).toBe(1000);
    expect(r.sx).toBe(500);
    expect(r.sy).toBe(0);
  });
  it('zooming in keeps a smaller part of the picture', () => {
    expect(cropRect(1000, 1000, 2, 0, 0).size).toBe(500);
  });
  it('dragging right shows more of the left side', () => {
    const r = cropRect(2000, 1000, 1, 100, 0);
    expect(r.sx).toBeLessThan(500);
  });
  it('never lets the picture slide off the circle', () => {
    // a square photo at 1x fills the circle exactly, so it can't move at all
    expect(clampOffset(1000, 1000, 1, 90, -90)).toEqual({ x: 0, y: 0 });
    // a wide photo can move sideways only as far as its edge
    const c = clampOffset(2000, 1000, 1, 9999, 9999);
    expect(c.x).toBeCloseTo(128);
    expect(c.y).toBe(0);
    // the crop at the limit stays inside the picture
    const r = cropRect(2000, 1000, 1, c.x, c.y);
    expect(r.sx).toBeGreaterThanOrEqual(0);
  });
});
