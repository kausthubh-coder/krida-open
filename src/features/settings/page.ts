import { lazyPage } from "../../ui/lazyPage";

export const Settings = lazyPage(() => import("./Settings").then((m) => m.SettingsPage));
