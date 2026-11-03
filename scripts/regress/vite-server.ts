// Serves one tree (the branch, or the base commit checked out under .artifacts/) with its own vite.config.ts. Run with
// cwd = the tree. The base tree's node_modules is a link to this checkout's, so Vite may read files above its root.
import { resolve } from "node:path";
import { createServer } from "vite";

const port = Number(process.env.PORT);
const server = await createServer({
  root: process.cwd(),
  configFile: resolve(process.cwd(), "vite.config.ts"),
  server: { port, strictPort: true, host: "127.0.0.1", fs: { allow: [resolve(process.env.KRIDA_REPO ?? process.cwd())] }, hmr: process.env.KRIDA_HMR === "1" },
  logLevel: "warn",
});
await server.listen();
console.log(`ready http://127.0.0.1:${port}`);
