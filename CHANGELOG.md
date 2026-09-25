# Changelog

All notable changes to this package are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows [Semantic Versioning](https://semver.org/).

## [0.4.0] - Unreleased

### Added

- `search({ ..., limit })` caps the items after the token budget, and `filters.where` takes a
  condition tree for search and timeline: `AND`, `OR` and `NOT` over `id`, `kind`, `channel`,
  `category`, `outcome`, `source_id`, `vendor`, `at`, `valid_until`, `confidence`, `text`,
  `object_type` and `object_namespace`, with `eq`, `ne`, `in`, `nin`, `gt`, `gte`, `lt`, `lte`,
  `contains`, `icontains` and `exists`. It narrows what the policy let through; it never reorders.
- `feedbackBatch(items)`: up to 500 corrections in one call, each with its own idempotency key
  (minted when missing); per-item errors come back by index.
- `whoami()`: what the key authenticates as (space, source, vendor, scopes, audience, whether agent
  memory is on), for any key.
- `niadra.admin`, for a key with the `admin` scope: `findProfiles`, `memory`, `factHistory`,
  `correct`, `correctBatch` (item `n` keyed `<key>:<n>`), `forget`, `forgetStatus` and `export`.
  They resolve `{ data, error }` and fail open like the rest of the client.
- Types: `KeyIdentity`, `ProfileMemory`, `FactOut`, `FactHistory`, `ProfileMatch`,
  `CorrectionRequest`, `ForgetTarget`, `Erasure`, `ExportPackage`, `WhereExpression`.

## [0.3.0] - 2026-09-25

Ready to publish; not on npm yet. It carries everything in 0.2.0, so if 0.2.0 was never published,
publishing 0.3.0 alone is enough. From a clean checkout of `main`, with the owner's npm passkey:

```sh
git checkout main && git pull --ff-only
pnpm install --frozen-lockfile && pnpm check && pnpm runtimes && npm publish --access public
```

(Or push the tag `v0.3.0` once trusted publishing is configured for `@niadra/sdk`; see
`.github/workflows/release.yml`.) The n8n and Flowise packages did not change.

### Added

- Seven more integrations as subpath exports, each with its framework as an optional peer
  dependency and the same five things wired in: context before the model call, the turns with the
  provider's usage, the kit with the canonical definitions, the verification and the handoffs.
  All of them fail open.
  - `@niadra/sdk/retell`: Retell AI's inbound webhook (the context as dynamic variables), agent
    webhook (`call_started`, `transfer_started`, `call_ended` with every utterance), custom
    functions with `toolConfigs()`, and a session for the custom LLM websocket that gives the model
    its messages with the context in place. `X-Retell-Signature` is checked on every request. The
    websocket is not signed, so its `call_details` never name the customer: the session reads and
    records only for a call a signed webhook registered, unless `trustCallDetails` says the socket
    accepts Retell alone. No Retell package is needed; web APIs only.
  - `@niadra/sdk/llamaindex`: `NiadraMemory`, a LlamaIndex.TS `Memory` for agents, multi-agent
    workflows and chat engines; `NiadraMemoryBlock` for a memory built elsewhere; the kit as
    `FunctionTool`s.
  - `@niadra/sdk/genkit`: a Genkit model middleware for `generate({ use })` and the kit as
    unregistered Genkit tools.
  - `@niadra/sdk/voltagent`: VoltAgent hooks (`onPrepareModelMessages`, `onEnd`, `onHandoff`) and
    the kit as VoltAgent tools.
  - `@niadra/sdk/google-adk`: model callbacks and tools for the Agent Development Kit for
    TypeScript, one Niadra session per ADK session, `transfer_to_agent` as a handoff.
  - `@niadra/sdk/strands`: `NiadraPlugin` for Strands Agents for TypeScript, through its model
    middleware, and the kit as Strands tools.
  - `@niadra/sdk/cloudflare-agents`: `niadraAgent(this, ...)` for an `Agent` of the Cloudflare
    Agents SDK: the AI SDK middleware that hands the writes to `ctx.waitUntil()`, the kit, and
    `prepare()`, `record()` and `workersAiUsage()` for models called without the AI SDK.
- `pnpm runtimes` also runs the Retell handlers on Deno, Bun and workerd, and bundles
  `@niadra/sdk/cloudflare-agents` with the AI SDK and runs it inside workerd.

### Not added

- Pipecat and Daily: the Pipecat pipeline, where the model call happens, runs in Python (the
  Python SDK covers it); their JavaScript packages are browser clients, where a Niadra key must
  never go.
- A separate LangGraph.js node: `withNiadraContext()` in `@niadra/sdk/langchain` already gives the
  model node its context without writing it into the graph's checkpointed state.

## [0.2.0] - 2026-09-25

Ready to publish; not on npm yet. From a clean checkout of `main`, with the owner's npm passkey:

```sh
pnpm install --frozen-lockfile && pnpm check && pnpm runtimes && npm publish --access public
cd packages/n8n-nodes-niadra && pnpm check && npm publish --access public
```

(Or push the tag `v0.2.0` once trusted publishing is configured for `@niadra/sdk`; see `.github/workflows/release.yml`.)

### Added

- Integrations as subpath exports, each with its framework as an optional peer dependency, so
  `@niadra/sdk` itself still loads no package. Every adapter wires the same five things into the
  framework: the context before the model call (the pack after the instructions, the suffix at the
  end, within the read budget), the customer's and the agent's turns with the provider's usage, the
  navigation kit bound to the customer outside the model's reach, the verification before the first
  read, and the handoffs. All of them fail open.
  - `@niadra/sdk/livekit`: `NiadraAgent` and `NiadraMemory` for LiveKit Agents (Node) 1.9, through
    `onUserTurnCompleted`, session events and a toolset; SIP helpers for the caller and the call id.
  - `@niadra/sdk/elevenlabs`: the ElevenLabs Agents Platform initiation, server tool and post-call
    webhooks, with the `ElevenLabs-Signature` check and the server tool configurations.
  - `@niadra/sdk/vapi`: one handler for Vapi's server URL (assistant-request, tool-calls, transfers,
    end-of-call report) and `vapiTools()`.
  - `@niadra/sdk/whatsapp`: the WhatsApp Cloud API webhook (signature, subscription check, messages)
    and the turns keyed by Meta's message ids.
  - `@niadra/sdk/twilio`: Twilio Voice, Messaging and Conversations webhooks, `StirVerstat` as proof.
  - `@niadra/sdk/ai-sdk`: a middleware for `wrapLanguageModel` (AI SDK 5, 6 and 7) and the kit as tools.
  - `@niadra/sdk/mastra`: a processor for the model call and the kit as Mastra tools.
  - `@niadra/sdk/langchain`: a context runnable, `withNiadraContext()` for LangGraph nodes, a callback
    handler and the kit as structured tools.
  - `@niadra/sdk/openai-agents`: a `Session`, dynamic instructions, the kit and handoffs for the
    OpenAI Agents SDK.
  - `@niadra/sdk/anthropic`, `@niadra/sdk/google-genai`, `@niadra/sdk/bedrock`: wrappers for the
    Anthropic SDK, the Google Gen AI SDK and Bedrock's Converse API, like `wrap()` for OpenAI.
- The agent's own memory: `agentMemory()` (the block for the prompt, with an ETag cache, empty and
  `enabled: false` when the space has it off), `searchAgentMemory()` and `remember()`, and
  `conversation.agentMemory()` / `task.agentMemory()` with the session's view.
  `tools({ agentMemory: true, writeAgentMemory: true })` adds `search_agent_memory` and `remember`; a
  note refused for personal data reaches the model as a request to rewrite it; a saved one as
  `{"saved":true,"note_id":...,"version":...}`, and one held for a person's approval as
  `{"saved":false,"proposal_id":...,"status":"waiting for review"}`. `search_agent_memory` gives the
  model each note's id, kind, title, body and tags. Every integration takes `agentMemory`.
- `customer()` and `agent()` on conversations (and `agent()` on tasks) take `handles`, more ids of
  the same person that go along with the subject, and `content`, which replaces the text (a voice
  note or an image by reference); `customer()` already took `stt_confidence`.
- `context({ format: "json" })` (and on conversations and tasks) returns `pack`, the pack as typed
  sections (`context-pack.v0`).
- History filters take `when` (the period in the customer's words, in Portuguese, English or Spanish)
  and `show_expired`; search and timeline answers carry `window` and `ignored`; events take
  `valid_until`; opened items carry `versions`.
- `packages/n8n-nodes-niadra` (an n8n community node) and `packages/flowise-nodes-niadra` (Flowise
  memory and tool nodes), outside the package build, with their own tests.
- `pnpm runtimes` also runs the webhook adapters on Deno, Bun and workerd.

### Changed

- The kit's tool definitions are now, byte for byte, the server's canonical ones
  (`GET /v1/history/tools`), shared with the Python SDK and checked against a snapshot: new
  descriptions, the filters nested under `filters` with `when`, and `max_tokens` on search. The kit
  still reads the flat filter fields the 0.1 definitions offered.
- Query parameters given as lists are sent repeated (`?tags=a&tags=b`).
- The build has one entry per integration and no shared chunks: `dist/index.js` stays one file.

## [0.1.1] - 2026-09-24

### Added

- The agent's turn carries the usage the model provider reported for the call behind it, as
  `usage` (`ModelUsage`: provider, model, prompt tokens with the cached ones included, cached
  tokens, tokens written to the cache). `wrap()` reads it from every OpenAI-compatible response
  and from the last chunk of a stream that asked for it (`stream_options: { include_usage: true }`),
  and never changes the request. Niadra sums it per agent, vendor and model, and the Console shows
  the prompt cache's hit rate and estimated savings.
- `agent(text, { usage })` on conversations and tasks takes the provider's response (OpenAI chat
  completions or Responses, Anthropic messages) or a `ModelUsage`, for agents that do not use
  `wrap()`; `modelUsage()` reads one yourself. A response without usage is left out; the turn is
  recorded either way.
- CI runs the build on Deno (with no permissions), Bun, workerd (Cloudflare Workers) and the Vercel
  Edge Runtime (`pnpm runtimes`), and the README names them.

### Changed

- `engines` asks for Node 20 or later, the versions the CI tests. The README no longer claims Node 18.
- A conversation turn (a message with a `conversation_id`) leaves the queue at most 200 ms after it
  was queued, taking whatever else is waiting along, instead of up to a second: it is what the other
  agents read in `live`. `queue.turnFlushIntervalMs` sets it; other items still wait for
  `flushIntervalMs` (1 s) or `flushAt` (15).
- The timeline tool says the history comes newest first, as the server returns it, instead of
  "in chronological order".
- The search tool no longer offers the model a `system_event` item kind, and its description names
  business objects instead of system events: a system event is never an item, it changes its object,
  so the filter is `object`. The server still reads `system_event` from 0.1.0 as `object`.
- `open()` sends `POST /v1/history/open` with the item id, the level and the conversation id in the
  body, instead of `GET /v1/history/items/{id}` with the conversation id in the query: a
  conversation id may be a phone number or an e-mail, and a URL reaches access logs.
- `open()` takes `subject`, the customer the item must belong to; the server opens any other item
  as 404. The tool kit passes its bound customer, so `open_history_item` opens only that
  customer's items.
- `task_id` on `open()` is no longer sent: the server never read it on this route. The field stays
  in `OpenParams` for code written against 0.1.0.
- The `excerpt` field of an opened item says the server no longer sends it.

### Fixed

- Building a client on Deno without `--allow-env` no longer throws: a runtime that refuses to read
  the environment now counts as one without `NIADRA_API_KEY` and `NIADRA_BASE_URL`.
- `feedback()` and the reservation in `uploadMedia()` end within `timeouts.write` (5 s) in total,
  retries and backoff included, instead of 5 s per attempt.
- The transfer in `uploadMedia()` ends within `timeouts.upload` (60 s) in total instead of per attempt.
- `identify()`, `verify()` and `handoff()` resolve by `timeouts.write` with a `NiadraTimeoutError`
  when the queue could not confirm them in time; the item stays queued and is still sent.

## [0.1.0] - 2026-09-23

First public release, with the same surface as the Python SDK.

### Added

- `Niadra` client with the endpoint derived from the source key (`https://<space>.<region>.api.niadra.com`), overridable with `baseURL`.
- `context()` with a per-conversation cache: TTL, stale-while-revalidate with one deduplicated refresh per pack, last good value on failure, and ETag revalidation through `known_etag`. 401 and 403 drop cached packs, and a `degraded` answer never replaces a good one. Plain and delta reads of a conversation share one entry, and each delta is handed out once.
- History navigation: `search()`, `timeline()` and `open()`.
- `tools(subject)`: the navigation kit as function-calling definitions, with the customer bound outside the model.
- `subjectToken()` for binding a customer to an MCP session.
- Writes: `track()`, `action()`, `identify()`, `verify()` and `handoff()`, through a bounded queue that batches by count and time, retries with backoff and sends a coverage heartbeat once a minute.
- `conversation()` helper that reads the pack the server pins, asks for deltas after the first read and keeps them until the pack changes, captures turns and emits `conversation.ended`.
- `task()` helper for internal agents that centers its pack on its object, keeps deltas and stamps like a conversation, captures the agent's answers and emits `task.ended`; `verify()` on a task, whose `tools()` follow its level.
- `markInjected()` and `contextStamp` on conversations and tasks: the agent's turns and actions carry the etag of the pack its prompt held and when it went in, as the event's `context_stamp`.
- `wrap()` for OpenAI-compatible clients: injects the pack and the suffix into `chat.completions.create` and `parse` (also under `beta`), stamps the injection, records the answer, streams included, keeps `.withResponse()` working, and never lets a capture failure reach the caller. `injectContext()` places a pack in a message list by the same rule.
- `objectState()` and `objectTimeline()` for business objects.
- `feedback()` to retract or correct a fact, resolve an open item or record a conversation's outcome.
- `uploadMedia()`: reserves an upload, sends the bytes to the signed URL with exactly the headers it names (HTTPS
  only, never the key) and resolves with `media_ref` and `media_sha256`; optionally bound to a `subject`.
- Fail-open behavior on every public method, and `strict: true` to throw instead.
- Per-method time budgets, 421 retries for moved spaces, and `problem+json` errors mapped to typed classes.
- Flush on `beforeExit` in Node, `flush()` and `shutdown()` everywhere else.
- Handle builders and wire types for every contract model.
