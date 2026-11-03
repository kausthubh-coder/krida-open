import { lazyPage } from "../../ui/lazyPage";

export const Search = lazyPage(() => import("./Search").then((m) => m.SearchPage));
