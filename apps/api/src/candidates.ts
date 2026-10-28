/**
 * Places Gateway: fetch candidate places for each block, one lookup per
 * category (blocks that share a category share the results).
 */
import { searchRadiusMeters, type Block, type LatLng, type Place, type TravelMode } from '@segue/engine';
import type { PlacesProvider, SearchableCategory } from '@segue/providers';

const CATEGORY_PLURAL: Record<SearchableCategory, string> = {
  cafe: 'cafés',
  cowork: 'coworking spaces',
  library: 'libraries',
  restaurant: 'places to eat',
  gym: 'gyms',
  park: 'parks',
  grocery: 'groceries',
  mall: 'malls',
};

export interface CandidateResult {
  candidates: Record<string, Place[]>;
  warnings: string[];
}

export async function gatherCandidates(
  provider: PlacesProvider,
  blocks: Block[],
  location: LatLng,
  mode: TravelMode,
): Promise<CandidateResult> {
  const categories = [
    ...new Set(blocks.filter((b) => !b.fixed && b.category !== 'none').map((b) => b.category as SearchableCategory)),
  ];
  const radiusM = searchRadiusMeters(mode);
  const warnings: string[] = [];
  const byCategory = new Map<SearchableCategory, Place[]>();

  await Promise.all(
    categories.map(async (category) => {
      try {
        byCategory.set(category, await provider.nearby({ location, radiusM, category, limit: 20 }));
      } catch (e) {
        console.warn(`places failed for ${category}: ${(e as Error).message}`);
        warnings.push(`Couldn't reach live map data for ${CATEGORY_PLURAL[category]} right now, so those plans use their no-place version.`);
        byCategory.set(category, []);
      }
    }),
  );

  const candidates: Record<string, Place[]> = {};
  for (const b of blocks) {
    if (b.category !== 'none' && !b.fixed) candidates[b.id] = byCategory.get(b.category as SearchableCategory) ?? [];
  }
  return { candidates, warnings };
}
