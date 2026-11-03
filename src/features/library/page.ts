import { lazyPage } from "../../ui/lazyPage";

export const Library = lazyPage(() => import("./Library").then((m) => m.LibraryPage));
