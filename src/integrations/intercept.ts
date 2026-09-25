/**
 * What the model SDK wrappers (Anthropic, Google GenAI, Bedrock) share: proxies that replace one
 * method without touching the client, an awaitable that keeps the SDK's own promise helpers, and
 * the per-session state that records each customer message once.
 */

import { Bridge, errorName, resolveSession } from "./shared.js";
import type { AgentMemoryOption, ProofSource, Session, SessionResolver } from "./shared.js";

type Method = (...args: unknown[]) => unknown;
type Bag = Record<PropertyKey, unknown>;

export interface WrapOptions {
  /** What your app proved about the user, recorded once before the first context read. */
  verify?: ProofSource;
  /** Puts the agent's own notes before the customer's context. */
  agentMemory?: AgentMemoryOption;
  /** Records the newest user message as the customer's turn. Defaults to `true`. */
  recordCustomer?: boolean;
  /** Records the model's text as the agent's turn. Defaults to `true`. */
  recordAgent?: boolean;
}

export interface CallState {
  bridge: Bridge;
  seen: Set<string>;
}

/** One state per session, so verification and the customer's turns happen once per conversation. */
export class States {
  private readonly states = new WeakMap<Session, CallState>();

  constructor(private readonly options: WrapOptions) {}

  /** The session's state; a new one takes `options` (by default the ones this object was built with). */
  resolve(source: SessionResolver, options: WrapOptions = this.options): CallState | null {
    const session = resolveSession(source);
    if (!session) return null;
    let state = this.states.get(session);
    if (!state) {
      state = { bridge: new Bridge(session, options.verify, options.agentMemory), seen: new Set() };
      this.states.set(session, state);
    }
    return state;
  }

  /** Records the user message at `index` once, however many tool steps send it again. */
  customer(state: CallState, index: number, text: string): void {
    if (!(this.options.recordCustomer ?? true) || index < 0 || !text) return;
    const key = `${String(index)}:${text}`;
    if (state.seen.has(key)) return;
    state.seen.add(key);
    state.bridge.customer(text);
  }

  get recordsAgent(): boolean {
    return this.options.recordAgent ?? true;
  }
}

/** A proxy of `target` where the keys of `overrides` answer instead; everything else is the target's own. */
export function overlay<T extends object>(target: T, overrides: Bag): T {
  return new Proxy(target, {
    get(obj, prop) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
      // Bound to the real object: class methods may touch private fields a proxy does not have.
      const value: unknown = Reflect.get(obj, prop, obj);
      return typeof value === "function" ? (value as Method).bind(obj) : value;
    },
  });
}

/**
 * What an intercepted call returns: awaitable like the SDK's own promise, with its
 * `withResponse()` and `asResponse()` when it has them. `finish` sees the value once and returns
 * what the caller gets (the same value, or a stream that records as it is read).
 */
export class Pending implements PromiseLike<unknown> {
  private result: Promise<unknown> | null = null;

  constructor(
    private readonly started: Promise<{ call: unknown }>,
    private readonly finish: (value: unknown) => unknown,
  ) {
    started.catch(() => undefined);
  }

  then<A = unknown, B = never>(
    onfulfilled?: ((value: unknown) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return this.value().then(onfulfilled, onrejected);
  }

  catch<B = never>(onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<unknown> {
    return this.value().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<unknown> {
    return this.value().finally(onfinally);
  }

  async withResponse(): Promise<unknown> {
    const { call } = await this.started;
    const method = property(call, "withResponse");
    if (typeof method !== "function") throw new TypeError("this client's calls have no withResponse()");
    const settled: unknown = await (method as Method).call(call);
    if (!isBag(settled)) return settled;
    return { ...settled, data: this.finish(settled.data) };
  }

  async asResponse(): Promise<unknown> {
    const { call } = await this.started;
    const method = property(call, "asResponse");
    if (typeof method !== "function") throw new TypeError("this client's calls have no asResponse()");
    return (method as Method).call(call);
  }

  private value(): Promise<unknown> {
    this.result ??= this.started.then(({ call }) => call).then((value) => this.finish(value));
    return this.result;
  }
}

/**
 * An async iterable that hands each item to `observe` and calls `done` once when it ends, fails
 * or is abandoned. Other properties of `stream` (such as `controller`) stay its own.
 */
export function observeStream<T extends AsyncIterable<unknown>>(
  stream: T,
  observe: (item: unknown) => void,
  done: () => void,
  logger: { warn(message: string): void },
): T {
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    try {
      done();
    } catch (error) {
      logger.warn(`could not record the model's answer (${errorName(error)})`);
    }
  };
  return new Proxy(stream, {
    get(target, prop) {
      if (prop === Symbol.asyncIterator) {
        return (): AsyncIterator<unknown> => {
          const inner = target[Symbol.asyncIterator]();
          return {
            async next() {
              try {
                const step = await inner.next();
                if (step.done) finish();
                else {
                  try {
                    observe(step.value);
                  } catch {
                    // Observing never breaks the caller's stream.
                  }
                }
                return step;
              } catch (error) {
                finish();
                throw error;
              }
            },
            async return(value?: unknown) {
              finish();
              return inner.return ? inner.return(value) : { done: true, value };
            },
          };
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as Method).bind(target) : value;
    },
  });
}

export function property(value: unknown, name: string): unknown {
  return isBag(value) ? value[name] : undefined;
}

export function isBag(value: unknown): value is Bag {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}

export function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return isBag(value) && typeof value[Symbol.asyncIterator] === "function";
}
