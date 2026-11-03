import { createContext, useEffect, useRef } from "react";
import { tick } from "./haptics";

/**
 * Where a card's actions are drawn: over the poster on hover ("card"), or in the peek sheet a long press opens on
 * touch ("peek"), where they have room for their names.
 */
export const CardPlace = createContext<"card" | "peek">("card");

// Held this long without moving, a finger means the card itself, not the title page or the row's scroll.
const HOLD_MS = 450;
const SLOP_PX = 10;

/**
 * A long press on a card, on touch only: what a mouse gets by hovering. The press doesn't also open the link
 * under it, and the browser's own link menu stays shut.
 */
export function useLongPress(onLongPress: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  useEffect(() => () => clearTimeout(timer.current), []);
  const cancel = () => {
    clearTimeout(timer.current);
    start.current = null;
  };
  return {
    onPointerDown: (e: React.PointerEvent) => {
      fired.current = false;
      if (e.pointerType !== "touch") return;
      start.current = { x: e.clientX, y: e.clientY };
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        start.current = null;
        fired.current = true;
        swallowNextClick();
        tick(8, "press");
        onLongPress();
      }, HOLD_MS);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const from = start.current;
      if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > SLOP_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu: (e: React.MouseEvent) => {
      if (start.current || fired.current) e.preventDefault();
    },
  };
}

/**
 * The finger that held the card lifts, and the browser may follow with a click: on the card's link, or, now that
 * the peek is open, on its backdrop, which would close it at once. That one click goes nowhere. The next touch is
 * a new gesture, so its click is meant.
 */
function swallowNextClick() {
  const swallow = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    done();
  };
  const done = () => {
    document.removeEventListener("click", swallow, true);
    document.removeEventListener("pointerdown", done, true);
  };
  document.addEventListener("click", swallow, true);
  document.addEventListener("pointerdown", done, true);
}
