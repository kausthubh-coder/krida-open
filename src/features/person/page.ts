import { lazyPage } from "../../ui/lazyPage";

export const Person = lazyPage(() => import("./Person").then((m) => m.PersonPage));
