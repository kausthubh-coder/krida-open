// PostHog gets what a person does in Krida, and no secrets: sign in, Home, a title, Search, Play to the first frame,
// a stall-free minute of watching, leaving, and an uncaught error; then the events are read back from PostHog: page
// timings, every /api call from both ends, Play's steps, playback health, the error, a session replay. The session
// token must appear in none of them, nor in the replay.
// Runs on the QA app started with telemetry on, which sends to the real PostHog project tagged `environment: qa`:
//   VITE_KRIDA_TELEMETRY=qa KRIDA_TELEMETRY=qa npm run qa -- up && node scripts/e2e-telemetry.ts
// Reads PostHog with a personal API key in POSTHOG_PERSONAL_API_KEY (docs/ops.md).
import { mkdirSync, readFileSync } from "node:fs";
import { POSTHOG_APP } from "../shared/posthog.ts";
import { launchBrowser } from "./lib/browser.ts";
import { checks, qaSession, signIn } from "./lib/qa.ts";

const out = ".artifacts/telemetry";
mkdirSync(out, { recursive: true });
const MEDIA = ".artifacts/regress/media";
const { movies } = JSON.parse(readFileSync(new URL("./regress/titles.json", import.meta.url), "utf8")) as Record<string, { id: string; name: string }[]>;
const movie = movies[16]!;
const POSTHOG_PROJECT_ID = process.env.POSTHOG_PROJECT_ID;
if (!POSTHOG_PROJECT_ID) throw new Error("Set POSTHOG_PROJECT_ID to the PostHog project telemetry goes to.");
const key = process.env.POSTHOG_PERSONAL_API_KEY;
if (!key) throw new Error("Set POSTHOG_PERSONAL_API_KEY to a PostHog personal API key that reads that project.");
const s = qaSession();
const started = new Date(Date.now() - 5_000).toISOString().replace("T", " ").slice(0, 19);
const marker = `telemetry-check-${Date.now()}`;

const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
const cors = { "access-control-allow-origin": "*" };
await context.route(/\/hls\/playlist\.m3u8/, (route) =>
  route.fulfill({
    headers: cors,
    contentType: "application/vnd.apple.mpegurl",
    body: readFileSync(`${MEDIA}/playlist.m3u8`, "utf8").replace(/^(?!#)(\S+)$/gm, `${s.siteUrl}/test-media/$1`).replace(/URI="(init\.mp4)"/, `URI="${s.siteUrl}/test-media/$1"`),
  }),
);
await context.route(/\/test-media\/[\w.]+$/, (route) => {
  const file = route.request().url().split("/").pop()!;
  return route.fulfill({ headers: cors, contentType: file.endsWith(".ts") ? "video/mp2t" : "video/mp4", body: readFileSync(`${MEDIA}/${file}`) });
});
const page = await context.newPage();
const { check, finish } = checks();
// The one error thrown on purpose is the point; any other fails.
page.on("pageerror", (error) => void (!error.message.includes(marker) && check("no page errors", false, error.message)));
const relay: number[] = [];
page.on("response", (r) => void (r.url().includes("/relay/") && relay.push(r.status())));

await signIn(page, s.url, s.profiles[0]!);
const token = await page.evaluate(() => localStorage.getItem("krida.session"));
await page.getByRole("heading", { level: 2 }).first().waitFor();
await page.waitForTimeout(6000); // PostHog loads once the first screen is idle
await page.goto(`${s.url}/title/movie/${movie.id}`);
await page.getByRole("heading", { name: movie.name }).first().waitFor();
await page.goto(`${s.url}/search?q=star`);
await page.waitForTimeout(3000);
await page.goto(`${s.url}/title/movie/${movie.id}`);
await page.getByRole("button", { name: "Play", exact: true }).first().click();
await page.waitForURL(/\/watch\//);
await page.waitForFunction(() => {
  const v = document.querySelector("video");
  return !!v && v.readyState >= 3 && !v.paused;
}, null, { timeout: 60_000 });
await page.waitForTimeout(15_000);
await page.screenshot({ path: `${out}/watching.png` });
await page.evaluate((m) => setTimeout(() => { throw new Error(m); }), marker);
await page.waitForTimeout(1000);
// Leave the way a person does, so the player closes inside the app.
await page.mouse.move(400, 300);
await page.getByRole("button", { name: "Back", exact: true }).first().click();
await page.waitForURL((url) => !url.pathname.startsWith("/watch/"));
await page.waitForTimeout(8000);
await context.close(); // the page's last events leave as it closes
check("PostHog's files and events went through Krida's /relay", relay.length > 3 && relay.every((st) => st < 400), JSON.stringify(relay.slice(0, 12)));

async function hogql<T = unknown[]>(query: string): Promise<T[]> {
  const res = await fetch(`${POSTHOG_APP}/api/projects/${POSTHOG_PROJECT_ID}/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
  });
  if (!res.ok) throw new Error(`PostHog query ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return ((await res.json()) as { results: T[] }).results;
}

const wanted = ["$pageview", "page_ready", "api_call", "api_request", "play_timing", "playback_health", "$exception", "$web_vitals", "$autocapture"];
type Row = [string, string];
let rows: Row[] = [];
// New events take a minute or more to be queryable.
for (let i = 0; i < 48; i++) {
  rows = await hogql<Row>(`select event, toString(properties) from events where timestamp >= '${started}' and properties.environment = 'qa' order by timestamp limit 2000`);
  const pagesIn = ["home", "title", "search"].every((page) => rows.some(([e, p]) => e === "page_ready" && p.includes(`"page":"${page}"`)));
  if (pagesIn && wanted.every((e) => rows.some(([event]) => event === e)) && rows.some(([, p]) => p.includes(marker))) break;
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}
const counts = Object.fromEntries(wanted.map((e) => [e, rows.filter(([event]) => event === e).length]));
console.log("events since", started, JSON.stringify(counts));
const props = (event: string) => rows.filter(([e]) => e === event).map(([, p]) => JSON.parse(p) as Record<string, unknown>);
for (const e of wanted) check(`PostHog has ${e}`, counts[e]! > 0, String(counts[e]));
const pages = props("page_ready").map((p) => `${p.page} ${p.ms} ms${p.coldStart ? " (cold)" : ""}`);
check("page_ready for Home, a title and Search", ["home", "title", "search"].every((p) => pages.some((x) => x.startsWith(p))), pages.join(", "));
const pick = (p: Record<string, unknown> | undefined, keys: string[]) => JSON.stringify(p && Object.fromEntries(keys.map((k) => [k, p[k]])));
const play = props("play_timing").find((p) => p.outcome === "played");
check("play_timing ends played, with its steps and first frame", play?.outcome === "played" && typeof play.firstFrameMs === "number", pick(play, ["outcome", "steps", "readyMs", "firstFrameMs", "fromPress", "platform"]));
const health = props("playback_health")[0];
check("playback_health when the player closed", health?.reason === "closed" && typeof health.stalls === "number", pick(health, ["reason", "windowMs", "stalls", "seekWaits", "droppedFrames", "height", "codec"]));
const error = props("$exception").find((p) => JSON.stringify(p).includes(marker));
check("the uncaught error reached error tracking", !!error, pick(error, ["$exception_types", "$exception_values", "$pathname"]));
const api = props("api_request").map((p) => `${p.path} ${p.status} ${p.ms} ms`);
check("/api's own runs were reported from the server", api.length > 0, api.slice(0, 5).join(", "));
const leaks = rows.filter(([, p]) => token && p.includes(token)).map(([e]) => e);
check("the session token is in no event", !!token && leaks.length === 0, leaks.join(", "));

// The replay: its snapshots, searched for the token too.
// This run's session: the one its own error came from (other runs may share the window and the environment).
const sessionId = error?.$session_id as string | undefined;
const recording = async (path: string) => {
  const res = await fetch(`${POSTHOG_APP}/api/environments/${POSTHOG_PROJECT_ID}/session_recordings/${sessionId}${path}`, { headers: { Authorization: `Bearer ${key}` } });
  return res.ok ? res.text() : "";
};
let snapshots = "";
for (let i = 0; i < 12 && sessionId && !snapshots; i++) {
  const sources = JSON.parse((await recording("/snapshots")) || "{}") as { sources?: { source: string; blob_key?: string }[] };
  const blobs = sources.sources?.filter((x) => x.source === "blob_v2") ?? [];
  if (blobs.length) snapshots = await recording(`/snapshots?source=blob_v2&start_blob_key=0&end_blob_key=${blobs.length - 1}`);
  else await new Promise((resolve) => setTimeout(resolve, 10_000));
}
check("the session was recorded", snapshots.length > 1000, `${snapshots.length} bytes of snapshots for ${sessionId}`);
check("the session token is not in the replay", !!token && snapshots.length > 0 && !snapshots.includes(token), "");
console.log(`Replay: ${POSTHOG_APP}/project/${POSTHOG_PROJECT_ID}/replay/${sessionId}`);
await browser.close();
finish();
