// Where Krida's telemetry goes, when a deployment sends any: PostHog's US cloud. The project key comes from the
// environment (VITE_POSTHOG_KEY for the browser, POSTHOG_KEY for /api and Convex); unset, nothing is sent anywhere.
// The project id, for scripts that read the data back, is POSTHOG_PROJECT_ID.

export const POSTHOG_HOST = "https://us.i.posthog.com";
/** Where people read it. */
export const POSTHOG_APP = "https://us.posthog.com";
