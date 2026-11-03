import { useLayoutEffect, useSyncExternalStore } from "react";
import { android } from "./android";
import { isPhone } from "./fullscreen";

/**
 * Watching is always sideways on a phone. Where the phone can be turned for us (Android, in full screen) it is;
 * where it can't (iPhones, or a phone held upright with rotation locked) the player turns itself a quarter turn
 * clockwise on the upright screen, as a sideways app would look, and you turn the phone to watch. While it's turned,
 * <html data-sideways> says so: styles inside it (the `stage:` variant, the --safe-* insets, sheets) and the
 * player's pointer maths (`pointIn`) follow the turned frame instead of the window.
 */
const upright = () => matchMedia("(orientation: portrait)").matches;
const subscribe = (onChange: () => void) => {
  const query = matchMedia("(orientation: portrait)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};

/**
 * Turns the frame while `active` (the room is on screen) on a phone held upright. Never in the Android app, which
 * turns the phone itself the moment the room opens (useAndroidWatching).
 */
export function useSideways(active: boolean) {
  const turned = useSyncExternalStore(subscribe, upright) && active && isPhone() && !android;
  useLayoutEffect(() => {
    if (!turned) return;
    document.documentElement.dataset.sideways = "";
    return () => {
      delete document.documentElement.dataset.sideways;
    };
  }, [turned]);
  return turned;
}

export const isSideways = () => document.documentElement.hasAttribute("data-sideways");

/**
 * Where a pointer is on `el`, in the element's own upright frame: x along its width, y down its height, with its
 * size and its left edge in that frame. On the turned frame (a quarter turn clockwise) the element's left edge is at
 * the window's top and its top at the window's right, so the window's x and y swap.
 */
export function pointIn(el: Element, clientX: number, clientY: number) {
  const r = el.getBoundingClientRect();
  return isSideways()
    ? { x: clientY - r.top, y: r.right - clientX, width: r.height, height: r.width, left: r.top, frameWidth: innerHeight }
    : { x: clientX - r.left, y: clientY - r.top, width: r.width, height: r.height, left: r.left, frameWidth: innerWidth };
}
