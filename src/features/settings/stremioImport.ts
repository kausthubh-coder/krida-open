// Reads the addon links of a Stremio account, in the browser. Krida's server never sees the email, password or the
// key Stremio hands back: only the links go to Convex (addons.importUrls), and the Stremio session is ended after.
import { importableUrls, STREMIO_API } from "../../../shared/stremio";

export class StremioError extends Error {}

async function call(method: string, body: Record<string, unknown>) {
  const res = await fetch(`${STREMIO_API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => {
    throw new StremioError("Couldn’t reach Stremio. Try again in a moment.");
  });
  return (await res.json().catch(() => null)) as { result?: any; error?: { message?: string; wrongEmail?: boolean; wrongPass?: boolean } } | null;
}

/** What Stremio's sign-in error means for the person typing. */
export function stremioProblem(error: { message?: string; wrongEmail?: boolean; wrongPass?: boolean } | undefined) {
  if (error?.wrongEmail) return "Stremio has no account with that email.";
  if (error?.wrongPass || /passphrase|password/i.test(error?.message ?? "")) return "That password isn’t right for this Stremio account.";
  return error?.message ? `Stremio said: ${error.message}` : "Stremio didn’t answer as expected. Try again.";
}

/** Signs in to Stremio, reads the account's addon links, and signs out again. */
export async function stremioAddonUrls(email: string, password: string): Promise<string[]> {
  const login = await call("login", { type: "Login", email: email.trim(), password, facebook: false });
  const authKey = login?.result?.authKey;
  if (typeof authKey !== "string") throw new StremioError(stremioProblem(login?.error));
  try {
    const collection = await call("addonCollectionGet", { type: "AddonCollectionGet", authKey, update: true });
    if (collection?.error) throw new StremioError(stremioProblem(collection.error));
    return importableUrls(collection);
  } finally {
    void call("logout", { type: "Logout", authKey }).catch(() => {});
  }
}
