/**
 * Where the turn in progress lives: an `AsyncLocalStorage`, which follows promises, `await` and timers, so a
 * tool called anywhere inside a turn lands in it, and two sub-agents started with `Promise.all` each keep
 * their own.
 *
 * The SDK builds for every runtime and never imports `node:async_hooks` itself. It takes the class from
 * `process.getBuiltinModule("node:async_hooks")` where that exists (Node 20.16 and later, Bun, Deno); a
 * runtime without it passes the class to `useAsyncLocalStorage()`, as Cloudflare Workers do with the
 * `nodejs_als` flag. Where there is none, `currentTurn()` is `undefined` and adapters pass the turn they
 * opened explicitly: capture keeps working, only the implicit lookup is missing.
 */

interface AsyncStore<T> {
  getStore(): T | undefined;
  run<R>(store: T, fn: () => R): R;
  enterWith(store: T): void;
}

type StoreClass = new <T>() => AsyncStore<T>;

let chosen: StoreClass | null | undefined;
const stores = new Map<string, AsyncStore<unknown>>();

/** The `AsyncLocalStorage` class to hold turns with, on a runtime where the SDK cannot find one itself. */
export function useAsyncLocalStorage(storage: StoreClass): void {
  chosen = storage;
  stores.clear();
}

function storeClass(): StoreClass | null {
  if (chosen !== undefined) return chosen;
  try {
    const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
    const hooks = proc?.getBuiltinModule?.("node:async_hooks") as { AsyncLocalStorage?: StoreClass } | undefined;
    chosen = hooks?.AsyncLocalStorage ?? null;
  } catch {
    chosen = null;
  }
  return chosen;
}

/** The store named `name`, or `null` on a runtime without async context. */
export function store<T>(name: string): AsyncStore<T> | null {
  const existing = stores.get(name);
  if (existing) return existing as AsyncStore<T>;
  const Class = storeClass();
  if (!Class) return null;
  const created = new Class<unknown>();
  stores.set(name, created);
  return created as AsyncStore<T>;
}
