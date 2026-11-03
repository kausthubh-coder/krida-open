import { createContext, useContext } from "react";

/**
 * Whether the kept page this sits in is the one on screen (app/Pages.tsx). A kept page goes on rendering while you're
 * elsewhere; what makes a sound or spends the network has to ask.
 */
export const PageShown = createContext(true);
export const usePageShown = () => useContext(PageShown);
