// Reads addons and library in the browser. Only addon links and library items go to Convex.
// The email, password and Stremio session key stay here, and the session is ended after.
import { importableUrls, STREMIO_API } from "../../../shared/stremio";

export class StremioError extends Error {}

export type StremioLibraryItem = Record<string, unknown>;

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

/** One Stremio sign-in for addons and library; the session ends even when either read fails. */
export async function stremioAccount(email: string, password: string, includeLibrary = true): Promise<{ urls: string[]; library: StremioLibraryItem[] }> {
  const login = await call("login", { type: "Login", email: email.trim(), password, facebook: false });
  const authKey = login?.result?.authKey;
  if (typeof authKey !== "string") throw new StremioError(stremioProblem(login?.error));
  try {
    const collection = await call("addonCollectionGet", { type: "AddonCollectionGet", authKey, update: true });
    if (collection?.error) throw new StremioError(stremioProblem(collection.error));
    let library: StremioLibraryItem[] = [];
    if (includeLibrary) {
      const data = await call("datastoreGet", { authKey, collection: "libraryItem", ids: [], all: true });
      if (data?.error) throw new StremioError(stremioProblem(data.error));
      if (!Array.isArray(data?.result)) throw new StremioError("Stremio didn’t return its library. Try again.");
      library = data.result;
    }
    return { urls: importableUrls(collection), library };
  } finally {
    void call("logout", { type: "Logout", authKey }).catch(() => {});
  }
}

/** Kept for callers that only need addon links. */
export async function stremioAddonUrls(email: string, password: string): Promise<string[]> {
  return (await stremioAccount(email, password, false)).urls;
}
