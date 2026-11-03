// Prints a profile's Home rows and its friend's rows from the old catalogs.home query, which only tabs on older builds
// still use (docs/database-reads.md). Needs a QA profile on the QA app's backend or a *-QA-* profile on dev.
// Usage: node scripts/print-home.mjs [profile]
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { convexSignIn, convexUrls, qaProfiles } from "./lib/qa.ts";

const c = new ConvexHttpClient(convexUrls().url);
const { token } = await convexSignIn(c, qaProfiles([process.argv[2]])[0]);
const home = await c.query(anyApi.catalogs.home, { token });
for (const r of home.rows) console.log(`[${r.style}] ${r.title} (${r.key}): ` + r.items.slice(0, 8).map((i) => i.name + (i.reason ? ` {${i.reason}}` : "")).join(" | "));
for (const f of home.friends) console.log(`[friend] ${f.title}: ` + f.items.slice(0, 6).map((i) => i.name).join(" | "));
await c.mutation(anyApi.profiles.signOut, { token });
