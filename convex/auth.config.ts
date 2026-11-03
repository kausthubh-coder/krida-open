import type { AuthConfig } from "convex/server";

/**
 * Clerk signs accounts in, and Convex trusts the "convex" JWT template of Krida's Clerk instance. Its domain is
 * public (it's in the publishable key every browser loads), so it's written here rather than read from an environment
 * variable: Convex refuses to push an auth config whose variable isn't set yet, and every throwaway local backend
 * (npm run qa, npm run regress) pushes before anything can set one. Krida runs on Clerk's development instance until
 * it has its own domain; production Clerk will need its domain here.
 */
export default {
  providers: [{ domain: "https://classic-locust-4579.clerk.accounts.dev", applicationID: "convex" }],
} satisfies AuthConfig;
