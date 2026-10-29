/**
 * Features decided when the app is built, not at run time, so nobody can
 * switch them on from the browser. With a flag off, the build replaces it
 * with `false` and the feature's code is left out entirely.
 */
/**
 * The planning assistant is still in development (branch `ai-assistant`).
 * On only in builds made with VITE_ASSISTANT=on; production leaves it out.
 */
export const ASSISTANT_ENABLED: boolean = typeof __SEGUE_ASSISTANT__ !== 'undefined' && __SEGUE_ASSISTANT__ === true;
