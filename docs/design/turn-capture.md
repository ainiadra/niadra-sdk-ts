# Turn capture

Status: built, except two parts. In section 4's table, Genkit, Cloudflare Agents, LiveKit and the webhook
rows do not record turns yet. In section 3, the conversation's quotes are not kept locally. The capture
lives in `src/capture/`. The Python SDK follows the same design, in snake_case.

A turn runs from its input (a message, an interface action, an event, a timer firing) to the last thing
it emits to the customer or to a document. Its record says what the agent read, called, showed, claimed
and decided, with the build pinned (the Turn Record spec, `turn-record.v0`).

One rule decides every choice below: **capture never delays the agent**.

- The SDK copies in the agent's process, at the moment things happen, and sends later.
- A failure of the capture marks the turn incomplete and never reaches the agent's code.

## 1. The turn context

- **Where the frame lives.** An `AsyncLocalStorage<TurnFrame>` holds the current frame.
  - `@niadra/sdk` builds for every runtime (tsup `platform: "neutral"`), so it never imports
    `node:async_hooks` statically.
  - It takes the class from `process.getBuiltinModule("node:async_hooks")` where that exists: Node 20.16
    and later, Bun, Deno.
  - A runtime without it, such as Cloudflare Workers with the `nodejs_als` flag, passes the class to
    `useAsyncLocalStorage()`.
- **Where there is no async context,** `currentTurn()` returns `undefined`. The adapters then pass the turn
  explicitly: every hook receives the frame the adapter opened. Capture keeps working; only the implicit
  lookup is missing.
- **Opening a frame.** `conversation.turn(build, fn)` runs `fn` inside a new frame, and so does an adapter
  hook. The frame's `turn_id` is minted at the input: `uuidv7()`, which matches the spec's
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`.
- **Promises and timers.** `AsyncLocalStorage.run` follows promises, `await` and timers started inside the
  frame, so parallel tool calls in one turn land in that turn.
- **Sub-agents.** A frame opened while another is current is a sub-turn. It gets its own `turn_id`, and its
  `agent.parent_turn_id` is the outer turn's. Two sub-agents started with `Promise.all` each run in their
  own `run`, so their calls never land in each other's frame.
- **Calls.**
  - `call_id` is the provider's tool call id when there is one, and `k1`, `k2`, ... per frame otherwise.
  - A second store holds the call in progress. A model call made inside a tool gets that tool's `call_id`
    as its `parent_call_id`.
- **Copy at the moment.**
  - Arguments and results are written as canonical JSON (`canonicalJson`) the instant they are seen. That
    string is the deep copy: a later mutation by the agent cannot change the record.
  - Web Crypto hashes asynchronously, so the SHA-256 is computed by the sender, from that string, before
    the batch leaves. It is never computed on the agent's path.
  - When a framework hands the model one version of a result and the interface another, both are kept
    (`result_model`, `result_ui`).
  - A streamed result is kept chunk by chunk, and joined when the turn closes.
- **Closing.** On exit the frame gets `ended_at`, `latency_ms` and its completeness, and goes to the turn
  queue as one record plus its blobs.
- **Budget.** At most 2 ms at p95 per tool call and 5 ms per turn, held by a local benchmark on the median
  and p95 payload sizes (25 KB and 150 KB).

## 2. The bounded turn queue

- **A queue of its own.** It is separate from the event queue (`queue.ts`), because turns have their own
  route and their own rule for what to drop. `POST /v1/turns` takes up to 50 records, 4 MB compressed.
- **Two bounds:** bytes (64 MB of frames and canonical blobs by default) and count (2,000 turns). Both are
  options, like `QueueOptions`.
- **When it is full**, in this order:
  1. The queue drops the blobs of turns without a flag, oldest first. A flag is an error, a guard that
     acted, a handoff, a failed assertion, a synthetic turn or negative feedback. The frame stays, each
     dropped blob keeps its `sha256` and `size`, and the turn says `completeness: partial`. A blob whose
     digest was not computed yet is hashed before its content goes.
  2. Only then does it drop the oldest frames whole.

  Both are counted, and logged at most once a minute. A flagged turn keeps its blobs longest, because it
  is the one someone will replay.
- **Never waits.** `put` is synchronous and constant time, and a full queue drops instead of waiting.
- **The sender**, like the event queue's, keeps one request in flight.
  - It hashes the blobs.
  - It compresses the body with `CompressionStream("gzip")` where the runtime has it.
  - A turn too large on its own goes with its blobs reduced to hashes, so a 413 `turn_too_large` never
    loops.
  - A 503 with `Retry-After` puts the batch back at the front.
  - A 207 drops the rejected items and counts them.
- **Content modes.**
  - `stored` sends the content.
  - `pointer`: the sender first writes each blob to the company's bucket with the company's credentials,
    then sends only the pointer and the digest. The upload runs on the sender, never on the agent's
    path.
  - `hash_only` sends only digests.
- **At exit:** `flush()` and the exit hook (`exit.ts`) drain the queue with a deadline, as they drain the
  event queue.

## 3. The local warm cache, with Niadra down

The client keeps:

- the last good pack per conversation (this exists: `cache.ts`, up to 30 minutes stale);
- the `now` view and the constraints block of each conversation;
- from `GET /v1/sdk/profile`: the claim contract and the summarized type registry;
- the suppression list;
- the contact token's public keys;
- the conversation's quotes (derived objects whose inputs it saw).

How it stays current:

- **The profile** is read once and revalidated by ETag when `valid_for_s` runs out; a failure keeps the
  last profile.
- **The suppression list** is pulled by cursor (`GET /v1/suppressions?cursor=`) and kept with its cursor.
- **Memory** is bounded per kind, least recently used first.

When Niadra does not answer:

- a read serves the cached value, marked `degraded`;
- claims are checked locally against the cached contract;
- the opt-out applies from the local copy while that copy is at most 60 s old;
- only the purposes the company set to fail closed wait: they get `defer`;
- the outage never turns into "not observed": a cached field keeps its value and logic with its real age.

The route methods of `niadra.api` reject. Each call built on them picks its failure direction and holds
its own time budget.

## 4. How adapters open and close turns

- **Where a tool is a function,** a generic wrapper, `niadra.tool(name, fn, options)`, records the call
  inside the current turn. Outside a turn it runs the tool untouched and records nothing.
- **The native hooks** see what the wrapper cannot: sub-agents and an agent used as a tool.

  | Framework | Opens and closes the turn | Records the calls |
  |---|---|---|
  | Google ADK | `beforeAgentCallback` / `afterAgentCallback`; an `AgentTool` is wrapped as a sub-turn | `beforeToolCallback` / `afterToolCallback` |
  | OpenAI Agents | the run's `agent_start` and end; a handoff opens a sub-turn | `agent_tool_start` / `agent_tool_end` |
  | LangGraph, LangChain | the graph run; each node runs inside the frame | `handleToolStart` / `handleToolEnd` |
  | AI SDK, Mastra, Genkit, VoltAgent, Cloudflare Agents | the generate or stream call | each tool's `execute`, wrapped; `wrapLanguageModel` for the stream |
  | LiveKit | one turn per user utterance | the wrapped function tool |
  | Webhook voice and messaging | one turn per inbound event | the tool call the webhook carries, recorded as a pair |
  | A loop without a framework | `conversation.turn()` | the wrapper, or `turn.toolCall()` by hand |

- **Opening.** An adapter opens the turn at the input, with its `kind` (`message`, `action`, `event`,
  `timer`), and a sub-agent's start opens a sub-turn.
- **Closing.** The turn closes after the last emission to the customer or to the document. For a streamed
  reply that is after the stream ends, not when the model call returns.
- **Off unless asked.** Every hook is off by default, turned on by an option, and runs only when the
  profile lists `turns` for the space. With it off, the adapter behaves exactly as it does today.
- **A hook never fails the agent.** When the hook's own code throws, it logs, marks the turn `incomplete`
  and lets the agent's call go on.
