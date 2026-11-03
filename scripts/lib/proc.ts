import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { createServer } from "node:net";

/** A long-running process this script started, and only that one, so cleanup never touches anyone else's. */
export type Started = { child: ChildProcess; output: () => string; stop: () => void };

/**
 * Starts a process. With `log`, its output goes to that file and it keeps running after this script exits
 * (`npm run qa -- up`); stop it later with stopTree(pid).
 */
export function start(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; log?: string }): Started {
  const fd = options.log ? openSync(options.log, "w") : undefined;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: fd === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", fd, fd],
    detached: fd !== undefined || process.platform !== "win32",
    windowsHide: true,
  });
  if (fd !== undefined) {
    closeSync(fd);
    child.unref();
  }
  let output = "";
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));
  const read = () => (options.log && existsSync(options.log) ? readFileSync(options.log, "utf8") : output);
  return { child, output: read, stop: () => stopTree(child.pid) };
}

/** Stops a process and its children by the PID we started (taskkill /T on Windows, the process group elsewhere). */
export function stopTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
  else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

export function isRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(what: string, ready: () => boolean | Promise<boolean>, timeoutMs: number, started?: Started) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await ready()) return;
    if (started && started.child.exitCode !== null) throw new Error(`${what} exited early:\n${started.output().slice(-2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${what} wasn't ready after ${timeoutMs / 1000}s${started ? `:\n${started.output().slice(-2000)}` : ""}`);
}

export async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}
