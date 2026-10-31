import type { Settings } from './model';

/** Settings for a first open. */
export const DEFAULT_SETTINGS: Settings = {
  endOfDay: '22:00',
  energy: 'medium',
  mode: 'local',
};

/**
 * Last resort for planning only, when there's no position, no saved fix and the
 * time zone points nowhere (Metro Manila). Never used for the sky: with nothing
 * to go on, the sky makes no weather claim.
 */
export const DEFAULT_LOCATION = { lat: 14.5995, lng: 120.9842 };
