import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import type { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { Page } from "playwright-core";

// What browser scripts share: where the QA app is, which profiles they may use, how to sign in, how to fail.

export type QaProfile = { name: string; password: string };
export type QaSession = { url: string; convexUrl: string; siteUrl: string; profiles: QaProfile[]; pids: { backend?: number; vite?: number; providers?: number }; tree: string };

export const SESSION_FILE = resolve(import.meta.dirname, "../../.qa/session.json");
const ENV_FILE = resolve(import.meta.dirname, "../../.env.local");

/** The app `npm run qa -- up` started, with its seeded profiles. */
export function qaSession(): QaSession {
  if (!existsSync(SESSION_FILE)) throw new Error("No QA app is running. Start one with `npm run qa -- up` (local backend, seeded profiles).");
  return JSON.parse(readFileSync(SESSION_FILE, "utf8")) as QaSession;
}

const sessionIfUp = () => (existsSync(SESSION_FILE) ? qaSession() : undefined);

/** Scripts drive only an app on this machine, never a deployed site. */
export function assertLocal(url: string) {
  const { hostname } = new URL(url);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname)) throw new Error(`Refusing ${url}: browser scripts only drive a local app (npm run qa -- up).`);
}

/** Scripts sign in only as disposable QA profiles, never as a real person's. */
export function assertQaProfile(name: string) {
  if (!/(^|-)QA(-|$)/.test(name)) throw new Error(`Refusing profile "${name}": use a QA profile (a name with -QA-, like Regress-QA-one).`);
}

/** The app a browser script drives: its argument, else KRIDA_URL, else the QA app if one is up, else the local dev server. */
export function baseUrl(arg?: string) {
  const url = arg || process.env.KRIDA_URL || sessionIfUp()?.url || `http://localhost:${process.env.PORT ?? 5173}`;
  assertLocal(url);
  return url;
}

/**
 * The profiles a script signs in as, one per entry: the name it was given, else the QA app's profile in that place.
 * Passwords come from the QA app, else KRIDA_QA_PASSWORD (for *-QA-* profiles on the dev backend).
 */
export function qaProfiles(names: (string | undefined)[]): QaProfile[] {
  const session = sessionIfUp();
  return names.map((given, i) => {
    const name = given || session?.profiles[i]?.name;
    if (!name) throw new Error("Pass a QA profile name, or start the QA app with `npm run qa -- up`.");
    assertQaProfile(name);
    const password = session?.profiles.find((p) => p.name === name)?.password ?? process.env.KRIDA_QA_PASSWORD;
    if (!password) throw new Error(`No password for ${name}: set KRIDA_QA_PASSWORD.`);
    return { name, password };
  });
}

/**
 * The Convex backend for scripts that call it directly: CONVEX_URL (and CONVEX_SITE), else the QA app's, else the dev
 * deployment in .env.local. Only a local backend or dev, never production.
 */
export function convexUrls(): { url: string; siteUrl?: string } {
  const session = sessionIfUp();
  const env = existsSync(ENV_FILE) ? parseEnv(readFileSync(ENV_FILE, "utf8")) : {};
  const [url, siteUrl] = process.env.CONVEX_URL
    ? [process.env.CONVEX_URL, process.env.CONVEX_SITE]
    : session
      ? [session.convexUrl, session.siteUrl]
      : [env.VITE_CONVEX_URL, env.VITE_CONVEX_SITE_URL];
  if (!url) throw new Error("No Convex backend: start the QA app (npm run qa -- up) or run `npx convex dev` to write .env.local.");
  for (const u of [url, siteUrl]) {
    if (!u) continue;
    if (u.includes("industrious-axolotl-949")) throw new Error(`Refusing ${u}: that is production.`);
    if (!u.includes("fastidious-oyster-35") && !["localhost", "127.0.0.1"].includes(new URL(u).hostname)) throw new Error(`Refusing ${u}: use the QA app's local backend or dev (fastidious-oyster-35).`);
  }
  return { url, siteUrl };
}

/**
 * Signs a QA profile in through the backend, for scripts that seed or read data without a browser. QA sign-in
 * (profiles.qaSignIn: name and password, no Clerk) answers only on local backends and dev.
 */
export async function convexSignIn(client: ConvexHttpClient, profile: QaProfile) {
  assertQaProfile(profile.name);
  const result = (await client.mutation(makeFunctionReference<"mutation">("profiles:qaSignIn"), { name: profile.name, password: profile.password })) as { token?: string; message?: string };
  if (!result.token) throw new Error(result.message ?? `Couldn't sign in as ${profile.name}`);
  const me = (await client.query(makeFunctionReference<"query">("profiles:me"), { token: result.token })) as { _id: string; name: string };
  return { _id: me._id, name: me.name, token: result.token };
}

/**
 * Signs a QA profile in in the browser, without a Clerk login: the app's /qa page takes its name and password and
 * opens Home as that profile.
 */
export async function signIn(page: Page, url: string, profile: QaProfile) {
  assertLocal(url);
  assertQaProfile(profile.name);
  // The first load of a fresh dev server waits for Vite to bundle dependencies.
  await page.goto(`${url}/qa`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await page.getByRole("textbox", { name: "QA profile" }).fill(profile.name, { timeout: 60_000 });
  await page.getByRole("textbox", { name: "Password" }).fill(profile.password);
  await page.getByRole("button", { name: "Sign in as QA profile" }).click();
  // Signed in once the QA page has moved on to the app. (The button's name changes while it signs in, so the button
  // going away isn't enough: a page opened then cancels the sign-in.)
  await page.waitForURL((url) => url.pathname !== "/qa", { timeout: 60_000 });
}

/**
 * Checks that end the script with a failing exit code when any check fails or a watched page threw, so a run that
 * only logs can't look like a pass. Pages opened later are added with `watch`.
 */
export function checks(page?: Page) {
  const failures: string[] = [];
  const errors: string[] = [];
  // Safari reports a ResizeObserver that needed a second pass as an error. Nothing broke: the notification comes next frame.
  const watch = (p: Page, label = "") => p.on("pageerror", (error) => { if (!error.message.startsWith("ResizeObserver loop")) errors.push(`${label ? `${label}: ` : ""}${error.message}`); });
  if (page) watch(page);
  return {
    watch,
    check(name: string, ok: boolean, detail = "") {
      console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
      if (!ok) failures.push(name);
    },
    finish() {
      for (const error of errors) console.log(`FAIL page error: ${error}`);
      const failed = failures.length + errors.length;
      console.log(failed ? `\n${failed} failed` : "\nAll checks passed");
      process.exitCode = failed ? 1 : 0;
    },
  };
}
