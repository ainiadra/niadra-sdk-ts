/**
 * Flushes queued events when a Node process runs out of work.
 *
 * `beforeExit` is the only exit event that allows asynchronous work, and it fires every time
 * the event loop drains, so a flush that finishes simply lets the process exit afterwards.
 * It does not fire on `process.exit()` or on signals: services that stop on SIGTERM should
 * call `shutdown()` in their own handler. The SDK never installs signal handlers, because
 * doing so would replace Node's default behaviour of exiting.
 *
 * Everything here is feature-detected, so edge runtimes without `process` skip it.
 */

interface Flushable {
  flush(): Promise<unknown>;
}

interface NodeLikeProcess {
  on(event: "beforeExit", listener: () => void): unknown;
  removeListener(event: "beforeExit", listener: () => void): unknown;
  versions?: { node?: string };
}

const registered = new Set<WeakRef<Flushable>>();
let installedOn: NodeLikeProcess | null = null;

function nodeProcess(): NodeLikeProcess | null {
  const candidate = (globalThis as { process?: Partial<NodeLikeProcess> }).process;
  if (!candidate?.versions?.node) return null;
  if (typeof candidate.on !== "function" || typeof candidate.removeListener !== "function") return null;
  return candidate as NodeLikeProcess;
}

function onBeforeExit(): void {
  for (const ref of registered) {
    const client = ref.deref();
    if (client) {
      // Strict clients reject on a lost batch; unhandled here, that would change the exit code.
      client.flush().catch(() => undefined);
    } else {
      registered.delete(ref);
    }
  }
}

/**
 * Registers a client for the exit flush and returns the function that unregisters it. Clients
 * are held weakly, so one that is no longer referenced can still be garbage collected.
 */
export function registerExitFlush(client: Flushable): () => void {
  const proc = nodeProcess();
  if (!proc || typeof WeakRef === "undefined") return () => undefined;
  const ref = new WeakRef(client);
  registered.add(ref);
  if (!installedOn) {
    proc.on("beforeExit", onBeforeExit);
    installedOn = proc;
  }
  return () => {
    registered.delete(ref);
    if (registered.size === 0 && installedOn) {
      installedOn.removeListener("beforeExit", onBeforeExit);
      installedOn = null;
    }
  };
}
