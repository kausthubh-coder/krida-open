import type { Screen } from "../../convex/lib/rank";
import { desktopApp } from "../data/desktop";

/**
 * Whether this screen is showing HDR right now: false on an SDR screen, and on an HDR one with HDR switched off in
 * the system. TorBox keeps HDR files in HDR, which the browser squeezes into SDR darker and duller, so Krida picks
 * an SDR copy for these. Read at each call, since a window can move to another screen.
 */
export const currentScreen = (): Screen =>
  // Krida for Windows plays the original file in mpv, which maps HDR to any screen properly: it gets the best file.
  desktopApp() ? "app" : matchMedia("(dynamic-range: high)").matches ? "hdr" : "sdr";
