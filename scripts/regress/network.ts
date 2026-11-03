import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Route } from "playwright-core";

type Entry = { status: number; contentType: string; file: string };

/**
 * Every request a walk makes outside the local app and backend is answered from a store, so the old and new builds
 * see exactly the same catalog, artwork and ratings. A request the store doesn't have yet is fetched once and kept:
 * /api GETs from the side that asked first (the base), whose local /api asks TMDB and MDBList with the keys run.ts
 * seeded (the live site's /api answers only signed-in accounts), everything else from where it points.
 * Trailers, any Convex cloud deployment and every non-GET request are refused.
 */
export class Network {
  private index: Record<string, Entry>;
  private inFlight = 0;
  readonly recorded: string[] = [];
  readonly missing: string[] = [];

  private dir: string;
  private offline: boolean;
  /** When the store was first recorded. Pages see this as the time, so "updated an hour ago" reads the same later. */
  readonly recordedAt: number;

  constructor(dir: string, offline: boolean) {
    this.dir = dir;
    this.offline = offline;
    mkdirSync(join(dir, "bodies"), { recursive: true });
    const file = join(dir, "index.json");
    this.index = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    const meta = join(dir, "meta.json");
    if (!existsSync(meta)) writeFileSync(meta, `${JSON.stringify({ recordedAt: Date.now() })}\n`);
    this.recordedAt = (JSON.parse(readFileSync(meta, "utf8")) as { recordedAt: number }).recordedAt;
  }

  get busy() {
    return this.inFlight > 0;
  }

  async attach(context: BrowserContext) {
    await context.routeWebSocket(/\.convex\.cloud/, (ws) => ws.close());
    await context.route("**/*", (route) => this.handle(route));
  }

  save() {
    writeFileSync(join(this.dir, "index.json"), `${JSON.stringify(this.index, null, 1)}\n`);
  }

  private async handle(route: Route) {
    const request = route.request();
    const url = new URL(request.url());
    const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (local && !url.pathname.startsWith("/api/")) return route.continue();
    if (/\.convex\.(cloud|site)$/.test(url.hostname) || /youtube|googlevideo|ytimg|doubleclick/.test(url.hostname)) return route.abort();
    if (request.method() !== "GET") {
      // The recommender POSTs a session the live site can't check; both builds get the same refusal.
      return local ? route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Not available in regress"}' }) : route.abort();
    }
    const key = local ? `GET ${url.pathname}${url.search}` : `GET ${url.href}`;
    this.inFlight++;
    try {
      let entry = this.index[key];
      if (!entry) {
        if (this.offline) {
          this.missing.push(key);
          return await route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"Not in the regress store"}' });
        }
        const response = await route.fetch();
        const file = createHash("sha1").update(key).digest("hex");
        writeFileSync(join(this.dir, "bodies", file), await response.body());
        entry = { status: response.status(), contentType: response.headers()["content-type"] ?? "application/octet-stream", file };
        this.index[key] = entry;
        this.recorded.push(key);
      }
      await route.fulfill({
        status: entry.status,
        contentType: entry.contentType,
        headers: { "access-control-allow-origin": "*" },
        body: readFileSync(join(this.dir, "bodies", entry.file)),
      });
    } catch {
      // The page navigated away and the request was cancelled.
    } finally {
      this.inFlight--;
    }
  }
}
