import { ConvexError } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

const encoder = new TextEncoder();

export function toHex(buffer: ArrayBuffer | Uint8Array) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomHex(bytes: number) {
  const out = new Uint8Array(bytes);
  crypto.getRandomValues(out);
  return toHex(out);
}

export async function sha256(text: string) {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

export async function hashPassword(password: string, salt: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations: 100_000 },
    key,
    256,
  );
  return toHex(bits);
}

export function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function sessionOf(ctx: QueryCtx, token: string) {
  const tokenHash = await sha256(token);
  return await ctx.db
    .query("sessions")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
    .unique();
}

/**
 * The profile a token is for. A token minted by a Clerk sign-in works only for that Clerk user: a browser signed in
 * as someone else can't use it. Callers with no Clerk identity (Krida's own server, scripts) are trusted with it.
 */
export async function profileFromToken(
  ctx: QueryCtx,
  token: string | null | undefined,
): Promise<Doc<"profiles"> | null> {
  if (!token) return null;
  const session = await sessionOf(ctx, token);
  if (!session) return null;
  if (session.clerkUserId) {
    const identity = await ctx.auth.getUserIdentity();
    if (identity && identity.subject !== session.clerkUserId) return null;
  }
  const profile = await ctx.db.get(session.profileId);
  if (profile?.expiresAt !== undefined && profile.expiresAt <= Date.now()) return null;
  return profile;
}

export async function requireProfile(ctx: QueryCtx, token: string | null | undefined) {
  const profile = await profileFromToken(ctx, token);
  if (!profile) throw new ConvexError({ code: "UNAUTHENTICATED", message: "Sign in to continue" });
  return profile;
}

/** The Clerk user signed in on the caller's device; refuses a caller who isn't. */
export async function requireClerk(ctx: QueryCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError({ code: "UNAUTHENTICATED", message: "Sign in to continue" });
  return identity;
}

export function publicProfile(p: Doc<"profiles">) {
  return { _id: p._id, name: p.name, hue: p.hue, temporary: p.expiresAt !== undefined };
}
