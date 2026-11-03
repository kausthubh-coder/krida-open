import { useEffect, useState } from "react";

/** A phone held sideways (the `short:` variant in styles.css): the nav is a rail at the left. */
export const SHORT = "(orientation: landscape) and (height < 32rem)";

/** Whether a media query matches, kept current as the window changes. */
export function useMedia(query: string) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const list = matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
