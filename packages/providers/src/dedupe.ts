import type { Place } from '@segue/engine';

const normal = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function metersApart(a: Place['location'], b: Place['location']): number {
  const dLat = (a.lat - b.lat) * 111_320;
  const dLng = (a.lng - b.lng) * 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

/**
 * One entry per real place: the same id, or the same name within about 80 m
 * (a gym mapped as a building and as a point, or found by two searches).
 * The first copy wins, filled in with anything only the later one knows.
 */
export function dedupePlaces(places: Place[], withinM = 80): Place[] {
  const out: Place[] = [];
  for (const p of places) {
    const twin = out.find((q) => q.id === p.id || (normal(q.name) === normal(p.name) && metersApart(q.location, p.location) <= withinM));
    if (!twin) {
      out.push(p);
      continue;
    }
    twin.hours ??= p.hours;
    twin.address ??= p.address;
    twin.rating ??= p.rating;
    twin.reviewCount ??= p.reviewCount;
    twin.attributes = { ...p.attributes, ...twin.attributes };
  }
  return out;
}
