import { existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const readBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

/**
 * In dev, /api/* runs the Vercel functions in api/ through Vite. They ask TMDB, MDBList and TorBox with the keys of the
 * signed-in profile's account (server/session.ts); the optional AIOSTREAMS_* come from .env.local. Only VITE_ variables
 * reach the browser.
 */
function vercelFunctions(): Plugin {
  return {
    name: "krida-vercel-functions",
    configureServer(server) {
      process.env = { ...loadEnv("development", process.cwd(), ""), ...process.env };
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const name = /^\/api\/([a-z-]+)$/.exec(url.pathname)?.[1];
        // The frames Worker (workers/frames) answers under /frames-worker when FRAMES_SECRET is set (the QA app sets it).
        const worker = url.pathname.startsWith("/frames-worker/") && process.env.FRAMES_SECRET;
        if (!worker && (!name || !existsSync(`api/${name}.ts`))) return next();
        try {
          const { default: handler } = await server.ssrLoadModule(worker ? "/workers/frames/index.ts" : `/api/${name}.ts`);
          const headers = new Headers(Object.entries(req.headers).flatMap(([k, v]) => (typeof v === "string" ? [[k, v] as [string, string]] : [])));
          const body = req.method === "POST" ? await readBody(req) : undefined;
          const response: Response = await handler.fetch(new Request(url, { method: req.method, headers, body }), process.env);
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
          next(error);
        }
      });
    },
  };
}

/** The icon weights Krida draws. `scripts/check-boundaries.ts` fails on any other. */
const ICON_WEIGHTS = ["regular", "bold", "fill"];

/**
 * Every Phosphor icon carries all six of its weights, and the 128 icons Krida uses came to 167 KB of the first
 * load. Only the weights drawn are kept. If Phosphor's files change shape, the build stops instead of quietly
 * keeping all six.
 */
function iconWeights(): Plugin {
  return {
    name: "krida-icon-weights",
    transform(code, id) {
      if (!/@phosphor-icons[\\/]react[\\/]dist[\\/]defs[\\/][^\\/]+\.es\.js$/.test(id)) return;
      const open = code.indexOf("new Map([");
      const close = code.lastIndexOf("\n]);");
      const entries = code.slice(open + "new Map([".length, close).split(/,(?=\n {2}\[\n {4}")/);
      const names = entries.map((entry) => /^\n {2}\[\n {4}"(\w+)",/.exec(entry)?.[1]);
      if (open < 0 || close < 0 || names.length !== 6 || ICON_WEIGHTS.some((w) => !names.includes(w)))
        throw new Error(`krida-icon-weights: unexpected Phosphor icon file ${id}`);
      const kept = entries.filter((_, i) => ICON_WEIGHTS.includes(names[i]!));
      return { code: code.slice(0, open + "new Map([".length) + kept.join(",") + code.slice(close), map: null };
    },
  };
}

/** PostHog under Krida's own address, as vercel.json's rewrites give it in production (src/data/telemetry.ts). */
const relay = {
  "/relay/static": { target: "https://us-assets.i.posthog.com", changeOrigin: true, rewrite: (path: string) => path.replace(/^\/relay/, "") },
  "/relay/array": { target: "https://us-assets.i.posthog.com", changeOrigin: true, rewrite: (path: string) => path.replace(/^\/relay/, "") },
  "/relay": { target: "https://us.i.posthog.com", changeOrigin: true, rewrite: (path: string) => path.replace(/^\/relay/, "") },
};

export default defineConfig({
  plugins: [react(), tailwindcss(), vercelFunctions(), iconWeights()],
  server: { port: Number(process.env.PORT) || 5173, strictPort: true, proxy: relay },
  preview: { proxy: relay },
  build: {
    // Maps only for PostHog to read stacks with; scripts/build-frontend.mjs uploads them, then deletes them.
    sourcemap: process.env.POSTHOG_CLI_API_KEY ? "hidden" : false,
    rolldownOptions: {
      output: {
        // Libraries change far less often than Krida, so each family gets a chunk of its own that a returning visitor
        // keeps across deploys, instead of fetching them again inside Krida's own chunks. One per family, so updating
        // one leaves the rest cached.
        codeSplitting: {
          groups: [
            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler|react-router)[\\/]/ },
            { name: "convex", test: /node_modules[\\/](convex|convex-helpers)[\\/]/ },
            { name: "motion", test: /node_modules[\\/](motion|framer-motion|motion-dom|motion-utils)[\\/]/ },
            { name: "hls", test: /node_modules[\\/]hls\.js[\\/]/ },
          ],
        },
      },
    },
  },
});
