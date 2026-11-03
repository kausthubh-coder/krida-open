import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "./play";

type LinkState = { url?: string; error?: string; loading: boolean };

/** The file's link, asked for once `load` is called (or at once with `auto`). */
export function useFileLink(get: () => Promise<string>, auto: boolean) {
  const [state, setState] = useState<LinkState>({ loading: auto });
  const load = useCallback(() => {
    setState({ loading: true });
    get().then(
      (url) => setState({ url, loading: false }),
      (error: unknown) => setState({ error: errorMessage(error, "Couldn’t get this file’s link. Try again."), loading: false }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (auto) load();
  }, [auto, load]);
  return { ...state, load };
}
