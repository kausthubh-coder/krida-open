import { v } from "convex/values";
import { internalMutation } from "./functions";
import { hashPassword, randomHex } from "./lib/auth";

// Convex modules are also imported by the frontend's typecheck.
declare const process: { env: Record<string, string | undefined> };

/** Branch previews share production's provider keys, so the nightly stats job (`wrapped.computeAll`) skips them. */
export const isPreview = () => process.env.KRIDA_PREVIEW === "true";

/** Fresh previews have their own profiles, without copying either friend's account or history. */
export const seed = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    if (!isPreview()) throw new Error("Preview setup is disabled on this deployment");
    const password = process.env.KRIDA_PREVIEW_PASSWORD;
    if (!password) throw new Error("Set KRIDA_PREVIEW_PASSWORD in the preview defaults");
    if (await ctx.db.query("profiles").first()) return null;
    for (const [order, name, hue] of [[0, "Preview one", 28], [1, "Preview two", 205]] as const) {
      const salt = randomHex(16);
      await ctx.db.insert("profiles", {
        name, hue, salt, passwordHash: await hashPassword(password, salt), order,
        failedAttempts: 0, prefs: { audioLang: "eng", sounds: false },
      });
    }
    return null;
  },
});
