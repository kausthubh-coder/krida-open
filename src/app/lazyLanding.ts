import { lazy } from "react";
import { reloadOntoNewBuild } from "../ui/lazyPage";

/** Signed out at /, the app shows the same page a first-time visitor gets (src/main.tsx), loaded only then. */
export const Landing = lazy(() => import("../features/landing").then((m) => ({ default: m.Landing }), reloadOntoNewBuild));
