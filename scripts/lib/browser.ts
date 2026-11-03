import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { chromium, type LaunchOptions } from "playwright-core";

// The browser every script drives. The installed Chrome (or Edge, for scripts that want a second, different browser)
// when there is one, as on my Windows machine, so nothing gets downloaded there. Otherwise Playwright's Chromium: the
// build this playwright-core wants if it's installed, else the one a cloud VM ships under PLAYWRIGHT_BROWSERS_PATH
// (an older build, which these scripts work with).
//
//   import { launchBrowser } from "./lib/browser.ts";
//   const browser = await launchBrowser({ args: [...] });

export type Channel = "chrome" | "msedge";

const windows = (...parts: string[]) =>
  [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"]].filter(Boolean).map((prefix) => join(prefix!, ...parts));

const INSTALLED: Record<Channel, () => string[]> = {
  chrome: () => process.platform === "win32" ? windows("Google", "Chrome", "Application", "chrome.exe")
    : process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    : ["/opt/google/chrome/chrome"],
  msedge: () => process.platform === "win32" ? windows("Microsoft", "Edge", "Application", "msedge.exe")
    : process.platform === "darwin" ? ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
    : ["/opt/microsoft/msedge/msedge"],
};

/** What `launchBrowser` would start, with a name for the doctor; undefined when there's no browser at all. */
export function findBrowser(channel: Channel = "chrome"): { name: string; launch: LaunchOptions } | undefined {
  const installed = INSTALLED[channel]().find((path) => existsSync(path));
  if (installed) return { name: `${channel === "chrome" ? "Google Chrome" : "Microsoft Edge"} (${installed})`, launch: { channel } };
  let bundled = "";
  try { bundled = chromium.executablePath(); } catch { /* hosts Playwright doesn't support */ }
  if (bundled && existsSync(bundled)) return { name: `Playwright's Chromium (${bundled})`, launch: {} };
  const shipped = join(process.env.PLAYWRIGHT_BROWSERS_PATH ?? "", "chromium");
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(shipped)) {
    return { name: `the VM's Chromium (${realpathSync(shipped)})`, launch: { executablePath: shipped } };
  }
  return undefined;
}

export async function launchBrowser(options: LaunchOptions = {}, channel: Channel = "chrome") {
  const browser = findBrowser(channel);
  if (!browser) throw new Error("No browser: install Google Chrome, or run node node_modules/playwright-core/cli.js install chromium");
  return chromium.launch({ ...options, ...browser.launch });
}
