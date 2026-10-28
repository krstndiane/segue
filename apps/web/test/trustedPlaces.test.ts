import { describe, expect, it } from 'vitest';
import type { Place } from '@segue/engine';
import { trustedPlaces } from '../src/lib/reroute';

const p = (id: string, source: string): Place => ({ id, name: id, location: { lat: 14.6, lng: 121 }, category: 'gym', attributes: {}, source });

describe('places saved on the phone', () => {
  it('ignores made-up places saved from an older live server', () => {
    expect(trustedPlaces([p('a', 'osm'), p('b', 'mock')], undefined).map((x) => x.id)).toEqual(['a']);
  });
  it('keeps them for a server openly in mock mode (local development)', () => {
    expect(trustedPlaces([p('b', 'mock')], { mock: true })).toHaveLength(1);
  });
});
