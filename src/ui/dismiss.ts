import { useEffect, useRef, type RefObject } from "react";

/**
 * A menu's manners, for one a button opens: a press anywhere else closes it, and so does Escape, which hands focus back.
 * Give it the trigger and the panel's ref.
 */
export function useDismiss(open: boolean, close: (refocus: boolean) => void, trigger: RefObject<HTMLElement | null>, panel: RefObject<HTMLElement | null>) {
  const latest = useRef(close);
  useEffect(() => {
    latest.current = close;
  });
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) latest.current(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      latest.current(true);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, trigger, panel]);
}
