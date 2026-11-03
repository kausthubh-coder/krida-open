import { useEffect } from "react";

let open = 0;

/**
 * Marks the page with `html[data-modal]` while a modal dialog is up, so styles can react to it. This replaces
 * `html:has(dialog:modal)`: a `:has()` on the root makes every change anywhere in the page re-check styles, and on
 * Home, where rows render as you scroll, that cost about a second of style work every few seconds of scrolling.
 */
export function useModalMark(active: boolean) {
  useEffect(() => {
    if (!active) return;
    open++;
    document.documentElement.dataset.modal = "";
    return () => {
      if (--open === 0) delete document.documentElement.dataset.modal;
    };
  }, [active]);
}
