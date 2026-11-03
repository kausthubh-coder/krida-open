import { lazyPage } from "../../ui/lazyPage";

export const Title = lazyPage(() => import("./Title").then((m) => m.TitlePage));
