import { useEffect } from "react";
import { useNavigate } from "react-router";

/** The search field on screen right now: this one on wide screens, the Search page's on phones. */
export function visibleSearchField() {
  return [...document.querySelectorAll<HTMLInputElement>("[data-search-field]")].find((el) => el.offsetParent !== null);
}

/** "/" from anywhere, and Ctrl+K or ⌘K, put the cursor in search: the nav's field, or the page's on phones. */
export function useSearchShortcut() {
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector("dialog[open]")) return;
      const slash = e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey;
      const k = e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
      if (!slash && !k) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (slash && target?.closest("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      const field = visibleSearchField();
      if (field) {
        field.focus();
        field.select();
      } else navigate("/search");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);
}
