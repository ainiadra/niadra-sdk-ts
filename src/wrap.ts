/**
 * `wrap()` for OpenAI-compatible clients: the official `openai` package and any client with its
 * `chat.completions.create(body, options)` shape.
 *
 * Each `chat.completions.create` and `chat.completions.parse` call made through the wrapper,
 * streaming or not, gets the conversation's pack as a system message right after the caller's
 * leading system or developer messages, and the suffix (deltas and live turns) as a system
 * message at the end. The pack goes after the caller's instructions because those are the same
 * for every customer: kept first, they stay the cacheable prefix of the prompt. The injection is
 * stamped on the conversation, and the model's answer is recorded as the agent's turn, with the
 * usage the provider reported for the call: the prompt's tokens, the ones read from the provider's
 * prompt cache and the ones written to it (see `modelUsage()`). A stream reports its usage only when
 * the caller asks for it (`stream_options: { include_usage: true }`); the wrapper never changes the
 * request to get it.
 *
 * Nothing the wrapper does can fail the model call: a context that cannot be fetched is left
 * out, and a failure to record the answer is logged, without content, and swallowed.
 */

import type { ContextResult } from "./context.js";
import type { Logger } from "./logger.js";
import type { ModelUsage } from "./types/events.js";
import { modelUsage } from "./usage.js";

/** What `wrap()` needs from a conversation or a task. Both implement it. */
export interface WrapSession {
  context(): Promise<ContextResult>;
  markInjected(context?: ContextResult | null): void;
  agent(text: string, options?: { usage?: ModelUsage | null }): string | null;
  readonly logger: Logger;
}

/** A session, or a function that finds the one the current call belongs to (`null` passes the call through). */
export type SessionSource = WrapSession | (() => WrapSession | null | undefined);

type Method = (...args: unknown[]) => unknown;
type Record_ = Record<PropertyKey, unknown>;

const INSTRUCTION_ROLES = new Set(["system", "developer"]);
const INTERCEPTED = ["create", "parse"] as const;

/**
 * Returns a proxy of an OpenAI-compatible client that injects the conversation's context and
 * records the model's answers. The client itself is never modified.
 *
 * `.withResponse()` keeps working on intercepted calls and records the answer too;
 * `.asResponse()` returns the raw HTTP response, whose body the SDK cannot read, so nothing is
 * recorded then. Streams are recorded when they end, or when the caller stops reading them.
 *
 * @example
 * const openai = wrap(new OpenAI(), convo);
 * const completion = await openai.chat.completions.create({ model: "gpt-4.1", messages });
 */
export function wrap<C extends object>(client: C, session: SessionSource): C {
  const resolve = typeof session === "function" ? session : (): WrapSession => session;
  const chat = property(client, "chat");
  if (!isRecord(chat) || !isRecord(chat.completions)) {
    throw new TypeError("wrap() expects an OpenAI-compatible client with chat.completions");
  }
  const overrides: Record_ = { chat: wrapChat(chat, resolve) };
  // Older clients keep structured outputs under `beta.chat.completions.parse`.
  const beta = property(client, "beta");
  const betaChat = isRecord(beta) ? beta.chat : undefined;
  if (isRecord(beta) && isRecord(betaChat) && isRecord(betaChat.completions)) {
    overrides.beta = overlay(beta, { chat: wrapChat(betaChat, resolve) });
  }
  return overlay(client, overrides);
}

/**
 * Places the pack after the leading system or developer messages and the suffix at the end.
 * Returns a new array; `messages` is left as it was.
 */
export function injectContext(context: ContextResult, messages: readonly unknown[]): unknown[] {
  const result = [...messages];
  if (context.text) {
    let position = 0;
    while (position < result.length && INSTRUCTION_ROLES.has(roleOf(result[position]))) position++;
    result.splice(position, 0, { role: "system", content: context.text });
  }
  if (context.suffix) result.push({ role: "system", content: context.suffix });
  return result;
}

function wrapChat(chat: Record_, resolve: () => WrapSession | null | undefined): Record_ {
  const completions = chat.completions as Record_;
  const overrides: Record_ = {};
  for (const name of INTERCEPTED) {
    const method = completions[name];
    if (typeof method === "function") overrides[name] = intercept((method as Method).bind(completions), resolve);
  }
  return overlay(chat, { completions: overlay(completions, overrides) });
}

function intercept(original: Method, resolve: () => WrapSession | null | undefined): Method {
  return (body: unknown, ...rest: unknown[]): unknown => {
    let session: WrapSession | null | undefined;
    try {
      session = resolve();
    } catch {
      session = null;
    }
    if (!session || !isRecord(body)) return original(body, ...rest);
    const answer = new Answer(session, body.stream === true);
    const started = prepare(session, body).then((prepared) => ({ call: original(prepared, ...rest) }));
    return new PendingCall(started, answer);
  };
}

async function prepare(session: WrapSession, body: Record_): Promise<Record_> {
  try {
    const context = await session.context();
    if (!Array.isArray(body.messages)) return body;
    const messages = injectContext(context, body.messages);
    // A holdout pack is empty on purpose, and the turn was still built with it.
    if (context.text || context.suffix || context.response?.path === "holdout") session.markInjected(context);
    return { ...body, messages };
  } catch (error) {
    session.logger.warn(`could not inject context (${errorName(error)})`);
    return body;
  }
}

/**
 * The value an intercepted call returns: awaitable like the client's own promise, with its
 * `withResponse()` and `asResponse()`. The call is held in an object so that awaiting `started`
 * does not also resolve the client's promise, which `withResponse()` still needs as it is.
 */
class PendingCall implements PromiseLike<unknown> {
  private result: Promise<unknown> | null = null;

  constructor(
    private readonly started: Promise<{ call: unknown }>,
    private readonly answer: Answer,
  ) {
    // A caller that only ever uses withResponse() never awaits the other branch; the failure
    // still reaches every caller that does.
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
    const withResponse = property(call, "withResponse");
    if (typeof withResponse !== "function") throw new TypeError("this client's calls have no withResponse()");
    const settled: unknown = await (withResponse as Method).call(call);
    if (!isRecord(settled)) return settled;
    return { ...settled, data: this.answer.parsed(settled.data) };
  }

  async asResponse(): Promise<unknown> {
    const { call } = await this.started;
    const asResponse = property(call, "asResponse");
    if (typeof asResponse !== "function") throw new TypeError("this client's calls have no asResponse()");
    return (asResponse as Method).call(call);
  }

  private value(): Promise<unknown> {
    this.result ??= this.started.then(({ call }) => call).then((value) => this.answer.parsed(value));
    return this.result;
  }
}

/** The capture of one model call: records its text once, whichever way the caller reads it. */
class Answer {
  private recorded = false;

  constructor(
    private readonly session: WrapSession,
    private readonly stream: boolean,
  ) {}

  /** What to hand back in place of `value`. Never throws. */
  parsed(value: unknown): unknown {
    try {
      if (!this.stream) {
        this.record(messageText(value), modelUsage(value));
        return value;
      }
      return isAsyncIterable(value)
        ? captureStream(value, (text, usage) => {
            this.record(text, usage);
          })
        : value;
    } catch (error) {
      this.session.logger.warn(`could not capture the model's answer (${errorName(error)})`);
      return value;
    }
  }

  private record(text: string | null, usage: ModelUsage | null): void {
    if (this.recorded || !text) return;
    this.recorded = true;
    try {
      this.session.agent(text, usage ? { usage } : {});
    } catch (error) {
      this.session.logger.warn(`could not record the model's answer (${errorName(error)})`);
    }
  }
}

/**
 * The stream, with its async iterator replaced by one that collects the first choice's text
 * and hands it over when the stream ends, fails or is abandoned. Everything else, `tee()` and
 * `controller` included, is the stream's own.
 */
function captureStream<T extends AsyncIterable<unknown>>(
  stream: T,
  done: (text: string, usage: ModelUsage | null) => void,
): T {
  const parts: string[] = [];
  // The last chunk carries the usage when the caller asked for it.
  let usage: unknown = null;
  let model: string | undefined;
  let finished = false;
  const observe = (chunk: unknown): void => {
    const reported = property(chunk, "usage");
    if (isRecord(reported)) usage = reported;
    const name = property(chunk, "model");
    if (typeof name === "string" && name) model = name;
  };
  const finish = (): void => {
    if (finished) return;
    finished = true;
    done(parts.join(""), usage ? modelUsage(usage, model ? { model } : {}) : null);
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
                  parts.push(deltaText(step.value));
                  observe(step.value);
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

/** With `n > 1` the model answers several times; the agent said the first one. */
function firstChoice(value: unknown): Record_ | undefined {
  const choices = property(value, "choices");
  if (!Array.isArray(choices)) return undefined;
  return (choices as unknown[]).find(
    (choice): choice is Record_ => isRecord(choice) && (choice.index === undefined || choice.index === 0),
  );
}

function messageText(response: unknown): string | null {
  const content = property(firstChoice(response)?.message, "content");
  return typeof content === "string" && content ? content : null;
}

function deltaText(chunk: unknown): string {
  const content = property(firstChoice(chunk)?.delta, "content");
  return typeof content === "string" ? content : "";
}

function overlay<T extends object>(target: T, overrides: Record_): T {
  return new Proxy(target, {
    get(obj, prop) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
      // Bound to the real object: class methods may touch private fields a proxy does not have.
      const value: unknown = Reflect.get(obj, prop, obj);
      return typeof value === "function" ? (value as Method).bind(obj) : value;
    },
  });
}

function property(value: unknown, name: string): unknown {
  return isRecord(value) ? value[name] : undefined;
}

function isRecord(value: unknown): value is Record_ {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return isRecord(value) && typeof value[Symbol.asyncIterator] === "function";
}

function roleOf(message: unknown): string {
  const role = property(message, "role");
  return typeof role === "string" ? role : "";
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
