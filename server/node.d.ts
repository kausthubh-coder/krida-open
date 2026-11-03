// The one Node module /api uses beyond fetch. The api tsconfig leaves out @types/node, whose globals would clash with
// the DOM's, so this names only what server/telemetry.ts calls.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
  }
}
