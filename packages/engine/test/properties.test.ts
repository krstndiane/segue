import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isOpenThroughout, reroute, toMs, type Block, type Place } from '../src';
import { TZ, at, context, near } from './fixtures';

const hm = (h: number) => `${String(h).padStart(2, '0')}:00`;

const placeArb = (i: number) =>
  fc.record({
    north: fc.integer({ min: -2000, max: 2000 }),
    east: fc.integer({ min: -2000, max: 2000 }),
    open: fc.integer({ min: 0, max: 15 }),
    len: fc.integer({ min: 2, max: 14 }),
    wifi: fc.constantFrom(true, false, undefined),
    hoursKnown: fc.boolean(),
  }).map(
    (r): Place => ({
      id: `p${i}`,
      name: `Place ${i}`,
      location: near(r.north, r.east),
      category: 'cafe',
      attributes: r.wifi === undefined ? {} : { wifi: r.wifi },
      hours: r.hoursKnown
        ? { periods: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: hm(r.open), close: hm(Math.min(24, r.open + r.len)) })) }
        : null,
      source: 'prop',
    }),
  );

const blockArb = (i: number) =>
  fc.record({
    min: fc.integer({ min: 15, max: 120 }),
    extra: fc.integer({ min: 0, max: 60 }),
    priority: fc.constantFrom('must', 'should', 'nice'),
    needsPlace: fc.boolean(),
    needsWifi: fc.boolean(),
    fixedAt: fc.option(fc.integer({ min: 15, max: 20 }), { freq: 4 }),
  }).map(
    (r): Block => ({
      id: `b${i}`,
      title: `Block ${i}`,
      minMinutes: r.min,
      maxMinutes: r.min + r.extra,
      priority: r.priority as Block['priority'],
      category: r.needsPlace ? 'cafe' : 'none',
      requirements: r.needsPlace && r.needsWifi ? ['wifi'] : [],
      fixed: r.fixedAt !== null ? { start: at(hm(r.fixedAt)), end: at(`${String(r.fixedAt).padStart(2, '0')}:45`) } : undefined,
    }),
  );

const scenario = fc
  .tuple(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 0, max: 6 }), fc.integer({ min: 8, max: 16 }))
  .chain(([nb, np, nowH]) =>
    fc.record({
      blocks: fc.tuple(...Array.from({ length: nb }, (_, i) => blockArb(i))),
      places: np ? fc.tuple(...Array.from({ length: np }, (_, i) => placeArb(i))) : fc.constant([] as Place[]),
      nowH: fc.constant(nowH),
      mode: fc.constantFrom('walk', 'transit', 'local', 'drive'),
    }),
  );

describe('engine invariants', () => {
  it('always returns a valid, non-overlapping, honest plan', () => {
    fc.assert(
      fc.property(scenario, ({ blocks, places, nowH, mode }) => {
        const ctx = context({ now: at(hm(nowH)), mode: mode as 'walk' });
        const candidates = Object.fromEntries(blocks.map((b) => [b.id, b.category === 'none' ? [] : places]));
        const r = reroute({ blocks, candidates, context: ctx, maxIterations: 10 });
        const nowMs = toMs(ctx.now);
        const endMs = toMs(ctx.endOfDay);
        const byId = new Map(blocks.map((b) => [b.id, b]));
        const placeById = new Map(places.map((p) => [p.id, p]));

        // Every block is either scheduled or reported, never both.
        const scheduled = r.plan.items.map((i) => i.blockId);
        // Commitments that haven't ended are always in the plan.
        for (const b of blocks) if (b.fixed && toMs(b.fixed.end) > nowMs) expect(scheduled).toContain(b.id);
        const missing = r.plan.unscheduled.map((u) => u.blockId);
        expect(new Set([...scheduled, ...missing]).size).toBe(scheduled.length + missing.length);

        r.plan.items.forEach((item, idx) => {
          const b = byId.get(item.blockId)!;
          const s = toMs(item.start);
          const e = toMs(item.end);
          expect(e).toBeGreaterThan(s);
          if (idx > 0) {
            const prev = r.plan.items[idx - 1]!;
            if (s < toMs(prev.end)) {
              // Only two commitments may overlap, and both say so.
              expect(item.fixed && prev.fixed).toBe(true);
              expect(item.conflict).toMatch(/^Overlaps|Overlaps/);
            }
            // Flexible items never overlap anything that came before.
            if (!item.fixed) for (const earlier of r.plan.items.slice(0, idx)) expect(s).toBeGreaterThanOrEqual(toMs(earlier.end));
          }
          if (b.fixed) {
            // Fixed blocks never move.
            expect(s).toBe(toMs(b.fixed.start));
            expect(e).toBe(toMs(b.fixed.end));
          } else {
            expect(s).toBeGreaterThanOrEqual(nowMs);
            expect(e).toBeLessThanOrEqual(endMs);
            const dur = (e - s) / 60_000;
            expect(dur).toBeGreaterThanOrEqual(b.minMinutes);
            expect(dur).toBeLessThanOrEqual(b.maxMinutes);
          }
          if (item.place && !b.fixed) {
            const p = placeById.get(item.place.id)!;
            // Never schedules a place while it's closed.
            if (p.hours) expect(isOpenThroughout(p.hours, s, e, TZ)).toBe(true);
            // Never uses a place known to lack a requirement.
            for (const req of b.requirements) expect(p.attributes[req]).not.toBe(false);
          }
        });
      }),
      { numRuns: 150 },
    );
  });
});
