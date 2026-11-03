/*
 * Tickets for the frames Worker (workers/frames): /api/frames?ticket gives a signed-in browser one per file, and the
 * Worker opens it without asking Convex. Both hold FRAMES_SECRET; nothing else does.
 *
 * The Worker reads the film out of the asking account's TorBox, and TorBox has no key narrower than the account's own
 * (its file links carry it too), so the ticket carries that key, sealed:
 * - it's encrypted with AES-GCM under a key derived from FRAMES_SECRET, so the browser holding the ticket can't read it;
 * - the file's size and the ticket's expiry are its associated data, so a ticket opens only for that one file and only
 *   until it runs out (a day): change either and it doesn't open at all;
 * - the Worker has no TorBox key of its own (no TORBOX_API_KEY secret) and keeps nothing it opens; it uses the key to
 *   read that one file and forgets it with the request's memory.
 * A leaked ticket reads keyframes of that file for the rest of its day, as before; it never gives out the key.
 */

const DAY_MS = 24 * 60 * 60_000;
/** Vercel signs and Cloudflare checks, each by its own clock: a fresh ticket may look a little more than a day off. */
const SKEW_MS = 5 * 60_000;
const IV_BYTES = 12;

const sealKey = async (secret: string) => {
  // A Worker deployed without its secret is the Worker failing, not a bad ticket.
  if (!secret) throw new Error("FRAMES_SECRET isn't set");
  return crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`krida frames ticket ${secret}`)),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
};
const about = (size: number, expires: number) => new TextEncoder().encode(`frames ${size} ${expires}`);

const toBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64Url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export type FrameTicket = { expires: number; ticket: string };

/** A ticket for the file that is `size` bytes in the TorBox of `torboxKey`, from now for a day. */
export async function signTicket(secret: string, size: number, torboxKey: string, now = Date.now()): Promise<FrameTicket> {
  const expires = now + DAY_MS;
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: about(size, expires) },
    await sealKey(secret),
    new TextEncoder().encode(torboxKey),
  ));
  const ticket = new Uint8Array(IV_BYTES + sealed.length);
  ticket.set(iv);
  ticket.set(sealed, IV_BYTES);
  return { expires, ticket: toBase64Url(ticket) };
}

/**
 * The TorBox key inside `ticket` when it was sealed with `secret` for this file and hasn't run out; null otherwise
 * (another file, another expiry, another secret, a changed byte, or past its day).
 */
export async function openTicket(secret: string, size: number, expires: number, ticket: string, now = Date.now()): Promise<string | null> {
  if (!Number.isSafeInteger(expires) || expires < now || expires > now + DAY_MS + SKEW_MS || !/^[A-Za-z0-9_-]{40,400}$/.test(ticket)) return null;
  const seal = await sealKey(secret);
  try {
    const bytes = fromBase64Url(ticket);
    const key = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, IV_BYTES), additionalData: about(size, expires) }, seal, bytes.slice(IV_BYTES));
    return new TextDecoder().decode(key);
  } catch {
    return null;
  }
}
