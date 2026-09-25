# Changelog

All notable changes to this package are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows [Semantic Versioning](https://semver.org/).

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
