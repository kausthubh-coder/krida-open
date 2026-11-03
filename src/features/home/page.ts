import { lazyPage } from "../../ui/lazyPage";

export const SeeAll = lazyPage(() => import("./SeeAll").then((m) => m.SeeAllPage));
