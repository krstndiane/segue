/// <reference types="vite/client" />

/** Set at build time from VITE_ASSISTANT (vite.config.ts). */
declare const __SEGUE_ASSISTANT__: boolean | undefined;

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  /** OAuth client id (Web application) for Google Calendar; leave unset to hide the feature */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  /** "true" keeps the ?sky= previews in a production build (for design reviews only) */
  readonly VITE_ENABLE_SKY_PREVIEW?: string;
  /** "on" builds the planning assistant in (development and the ai-assistant preview only; never production) */
  readonly VITE_ASSISTANT?: string;
}
