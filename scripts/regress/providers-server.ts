// Runs the stand-in providers (providers.ts) as their own process, for `npm run qa -- up`, until it's stopped.
// Prints "providers <url>" once ready.
import { resolve } from "node:path";
import { startProviders } from "./providers.ts";

const providers = await startProviders(resolve(process.argv[2] ?? ".artifacts/regress/media"));
console.log(`providers ${providers.url}`);
