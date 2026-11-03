// Krida for Windows and Mac opening in full screen, without the app: the app's own bridge (BRIDGE in
// desktop/src-tauri/src/main.rs) runs in Chrome on the QA app, over a stand-in for Tauri's window and commands. The
// window opened full screen while the page isn't, so the site shows it as full screen and Esc, F11 and its own
// switches leave it. Settings' Open in full screen saves through the app's command, and shows only in an app that
// has it. scripts/e2e-desktop.ts drives the real Windows app.
// Usage: npm run qa -- up; node scripts/e2e-desktop-fullscreen.ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { launchBrowser } from "./lib/browser.ts";
import { checks, qaSession, signIn } from "./lib/qa.ts";

const repo = resolve(import.meta.dirname, "..");
const main = readFileSync(resolve(repo, "desktop/src-tauri/src/main.rs"), "utf8");
const raw = main.match(/const BRIDGE: &str = r#"([\s\S]*?)"#;/)?.[1];
if (!raw) throw new Error("No BRIDGE in main.rs");
const bridge = raw
  .replace("__VERSION__", "0.1.8")
  .replace("__PLATFORM__", "windows")
  .replace("__NOTES__", '""')
  .replace("__HOME__", '"/"');

// Tauri's window and commands, as the bridge and the site use them. The window opens full screen, as the setting
// makes it; `__window.calls` is what the page asked of it, and `__window.system(on)` is the system changing it.
const tauri = `
  const w = (window.__window = { full: true, calls: [], resized: [] });
  w.system = (on) => { w.full = on; w.resized.forEach((h) => h()); };
  const open = () => sessionStorage.getItem("openFullscreen") === "on";
  window.__TAURI__ = {
    window: { getCurrentWindow: () => ({
      isFullscreen: () => Promise.resolve(w.full),
      setFullscreen: (on) => { w.calls.push(on); w.full = on; return Promise.resolve(); },
      onResized: (h) => { w.resized.push(h); return Promise.resolve(() => {}); },
    }) },
    event: { listen: () => Promise.resolve(() => {}) },
    core: { invoke: (command, args) => {
      if (command === "open_fullscreen") return Promise.resolve(open());
      if (command === "set_open_fullscreen") return Promise.resolve(void sessionStorage.setItem("openFullscreen", args.on ? "on" : "off"));
      if (command === "update_status") return Promise.resolve({ state: "current" });
      return Promise.reject(new Error("not in this test: " + command));
    } },
  };
`;

const s = qaSession();
const [profile] = s.profiles;
const browser = await launchBrowser({ headless: true });
const { check, finish, watch } = checks();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => Promise<boolean>, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await ok()) return true;
  return ok();
};

async function app(scripts: string[]) {
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  for (const script of scripts) await context.addInitScript(script);
  const page = await context.newPage();
  watch(page);
  await signIn(page, s.url, profile);
  return page;
}

const state = (page: Page) =>
  page.evaluate(() => {
    const w = (window as unknown as { __window: { full: boolean; calls: boolean[] } }).__window;
    return { page: !!document.fullscreenElement, window: w.full, calls: w.calls.join(",") };
  });
const fullSwitch = (page: Page) => page.getByRole("switch", { name: /^Full screen/ });
const openSwitch = (page: Page) => page.getByRole("switch", { name: /^Open in full screen/ });
const settled = async (page: Page, want: { page: boolean; window: boolean; calls: string }) => {
  await until(async () => JSON.stringify(await state(page)) === JSON.stringify(want));
  return state(page);
};

try {
  const a = await app([tauri, bridge]);
  await a.goto(`${s.url}/settings/display`, { waitUntil: "domcontentloaded" });
  await fullSwitch(a).waitFor();
  const opened = await state(a);
  check("the window opened full screen and the page didn't", opened.window && !opened.page && opened.calls === "", JSON.stringify(opened));
  check("Settings shows it as full screen", await until(() => fullSwitch(a).isChecked()));

  await a.keyboard.press("Escape");
  const esc = await settled(a, { page: false, window: false, calls: "false" });
  check("Esc leaves the window's full screen", !esc.window && esc.calls === "false", JSON.stringify(esc));
  check("Settings shows it left", !(await fullSwitch(a).isChecked()));

  await a.keyboard.press("F11");
  const f11On = await settled(a, { page: true, window: true, calls: "false,true" });
  check("F11 takes page and window full screen", f11On.page && f11On.window && f11On.calls === "false,true", JSON.stringify(f11On));
  await a.keyboard.press("F11");
  const f11Off = await settled(a, { page: false, window: false, calls: "false,true,false" });
  check("F11 again leaves both", !f11Off.page && !f11Off.window && f11Off.calls === "false,true,false", JSON.stringify(f11Off));

  // The system takes the window full screen (a Mac's green button); the page hears it.
  await a.evaluate(() => (window as unknown as { __window: { system: (on: boolean) => void } }).__window.system(true));
  check("full screen from the system shows in Settings", await until(() => fullSwitch(a).isChecked()));
  // Something on the page going full screen itself and back, as a trailer's own button does, leaves the window as it was.
  await a.evaluate(() =>
    document.addEventListener("keydown", (e) => {
      if (e.key !== "q") return;
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.querySelector("main")!.requestFullscreen();
    }),
  );
  await a.keyboard.press("q");
  await settled(a, { page: true, window: true, calls: "false,true,false" });
  await a.keyboard.press("q");
  const inner = await settled(a, { page: false, window: true, calls: "false,true,false" });
  check("the page leaving its own full screen leaves the window's alone", !inner.page && inner.window && inner.calls === "false,true,false", JSON.stringify(inner));
  await a.reload({ waitUntil: "domcontentloaded" });
  await fullSwitch(a).waitFor();
  check("a reload still shows the window full screen", await until(() => fullSwitch(a).isChecked()));
  await fullSwitch(a).click();
  const switched = await settled(a, { page: false, window: false, calls: "false" });
  check("Settings' Full screen switch leaves it", !switched.window && switched.calls === "false", JSON.stringify(switched));

  check("Open in full screen starts off", !(await openSwitch(a).isChecked()));
  await openSwitch(a).click();
  const saved = await a.evaluate(() => sessionStorage.getItem("openFullscreen"));
  check("turning it on tells the app", saved === "on", String(saved));
  await a.reload({ waitUntil: "domcontentloaded" });
  await openSwitch(a).waitFor();
  check("it stays on after a reload", await until(() => openSwitch(a).isChecked()));
  await openSwitch(a).click();
  check("turning it off tells the app", (await a.evaluate(() => sessionStorage.getItem("openFullscreen"))) === "off");
  await a.screenshot({ path: resolve(repo, ".artifacts/desktop-fullscreen/settings.png") });

  // An app from before 0.1.8 can't open full screen, and a browser has no app to ask.
  const old = await app([tauri, `window.kridaDesktop = { version: "0.1.7", fullscreen: () => {} };`]);
  await old.goto(`${s.url}/settings/display`, { waitUntil: "domcontentloaded" });
  await fullSwitch(old).waitFor();
  check("an older app has no Open in full screen", (await openSwitch(old).count()) === 0);
  const web = await app([]);
  await web.goto(`${s.url}/settings/display`, { waitUntil: "domcontentloaded" });
  await fullSwitch(web).waitFor();
  check("a browser has no Open in full screen", (await openSwitch(web).count()) === 0);
} catch (error) {
  // A step that threw counts, so the summary can't say every check passed.
  check("the script ran to the end", false, String(error));
} finally {
  await browser.close();
  finish();
}
