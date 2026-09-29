# Changelog

All notable changes to this package are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

The routes of turn records, typed state, subject signals and coordination, typed, before the calls
built on them.

### Added

- `niadra.api` (`Api`): one method per route of turn records, replay and scenarios, typed state and the
  agent's working state, subject signals and measurement, and coordination, named in camelCase as the
  server names the operation. Unlike the rest of the client they never fail open; a route a server does
  not serve (501) rejects with `NiadraNotAvailableError`.
- The types of those routes (`TurnRecord`, `StateReadRequest`, `CheckResult` and the rest), generated
  from the server's OpenAPI document by `scripts/sync-spec.ts`.
- Turn records: `conversation.turn()` records what one turn read, called and said, with the build it ran
  on (`Niadra.build()`), and `tool()` wraps a tool of yours so each call inside a turn is recorded, copied
  as JSON at the moment, with the objects its result showed. The turn in progress follows the async
  context (`AsyncLocalStorage`; `useAsyncLocalStorage()` supplies one where `node:async_hooks` is missing),
  so parallel sub-agents keep their own turns. A bounded queue keeps the closed turns (values of unflagged
  turns go first when it is full) and a background sender posts them to `POST /v1/turns` in the space's
  content mode, with the values in your own bucket in `pointer` mode (`niadra.turns.store()`). Closing a
  turn never waits for the network, and a recorded tool call costs under 2 ms at the 95th percentile.
- The warm cache for when Niadra is down: `niadra.profile()` keeps the SDK profile (features, claim
  contract); `context({ include: ["constraints", "state"] })` reads the constraints block and the state view
  with the pack, and a failed read serves the last good ones; `niadra.mayContact()` checks an outbound
  contact against the local copy of the suppression list, which keeps applying with Niadra out of reach.
- The claim contract inside a turn: what the agent says is checked against what its tools returned and
  each claim goes to the turn record with its verdict (count mode never changes an output).
  `conversation.claims.guard(stream)` holds what could start a claim until its sentence ends (150 ms at
  most, 300 ms a message) and lets it go as the contract's actions say: a blocked sentence gives way to the
  category's caveat, a stale copy of one field becomes its fresh value only when that is unequivocal, a
  warning marks the claim. `claims.guardText()` does the same on a whole output. An immutable output never
  changes: a block sends it to a person.
- Coordination: `conversation.check()` asks before acting and, when Niadra does not answer within 200 ms,
  decides by the purpose's direction (a customer's message and service go, marketing, retention,
  collection and an effect with a key wait, the local opt-out always holds); `conversation.declare` sends
  what happened in the background until Niadra takes it; `conversation.claim()` holds a lease or a task
  lock. `task()` takes the same calls.
- `niadra.contactGateway()` and `verifyContactToken()`: the contact token's offline check at your gateway
  (Ed25519 through Web Crypto), with the space's public keys kept while Niadra is down and each token let
  through once.
- The agent's working state: `conversation.agentState.get()` and `put()`, compare-and-swap or merge by key
  (`DELETE` removes a key), reading its own writes, kept and sent again while Niadra is down.
- `niadra.resolvers` and `verifyClaim()`: a value not safe to claim is read again by your resolver, inside
  your boundary and within 300 ms, and the fresh value decides. `ContentResolver` puts back the text a
  pointer-mode space keeps in your storage, and `ResolverWorker` serves the space's refresh requests with
  your resolvers.
- Replay inside your boundary: `Replayer` runs the turns of a scenario N times with the build you pin,
  answers your tools from the record (`tool(name, fn, { dryRun: true })` lets one run for real when the
  record has no answer), keeps everything the agent sends from leaving, evaluates the assertions and
  reports the run, and Niadra answers with the statistical verdict. Runs are numbered from 1, as the
  replay spec numbers them.
- `overlapAtK()`: the depth-weighted overlap of two ranked lists that the tool counterfactual reports
  (`spec/counterfactual.md`, 4); it passes the `counterfactual-overlap` vectors.
- The recording the SDK profile serves: a turn leaves in the content mode the space names for the source,
  and a turn without a pin the space requires for replay is kept with a warning, once.
- Turn records from the framework adapters. LangChain.js and LangGraph.js:
  `new NiadraCallbackHandler(conversation, { turns: true })` records each top-level run as a turn, with its
  tool calls (the provider's call ids) and its model calls with their tokens. Mastra:
  `niadraProcessor({ turns: true })` records each request as a turn. Vercel AI SDK: `niadraMiddleware`
  records each model call in the turn in progress, `recordTools(tools)` records each tool call with the
  provider's call id, and `niadraTurn()` keeps a `streamText` turn open until the stream finishes. A run
  inside a turn in progress records into it, and a function wrapped with `tool()` inside a framework's tool
  takes over its call, so a replay answers it from the record.
- `conversation.activeTurn()`: the turn in progress, from the async context or the newest the session
  opened and has not closed; `tool()` takes `callId` and `frame` for frameworks that run tools elsewhere.
- `canonicalJson()` and `jsonDigest()`: the digest of a turn record's value, SHA-256 over its canonical
  JSON (RFC 8785), as every producer computes it.
- `expr`: niadra-expr, the language of the type registry's conditions, timers, keys and readings.
  `expr.parse()` reads an expression, `expr.compileExpression()` resolves its names against a type's
  declarations, and `expr.evaluate()` computes it over an object's slots with the four logical values,
  as the server does; it passes every case of `spec/vectors/niadra-expr.v0.json`. Dates and times are
  integers (days, milliseconds), never the machine's time zone.
- The conformance vectors of the open specifications, run by `test/vectors.test.ts`, and the design of
  the turn capture (`docs/design/turn-capture.md`).
- `canonicalDestination()` and `suppressionKey()`: a handle's canonical destination (`phone:+<E.164>`
  with the Brazilian ninth digit, `email:<address>`) and its key per reader,
  `base64url(HMAC-SHA256(salt, ...))`, as the suppression list and the contact token compute them.
  `suppressionKey()` is async (Web Crypto); errors are `NiadraDestinationError`.
- `exposureToken()` and `parseExposureToken()`: the exposure token a card carries,
  `nx1.<id>.<position>.<verifier>`, built synchronously and read with the refusals of its spec
  (`NiadraExposureTokenError`).
- `renderConstraints()` and `honoredConstraints()`: the constraints block rendered for one tool call
  through the tool's binding, in advisory or apply mode, and the count of what the call's results
  honored.
- `claims`: the claim contract's reference checker, pure and without a model. `mentions()` reads the
  numbers of an output in Portuguese, English or Spanish (class, normalized value, span in code points),
  `rolesOf()` their roles, `check()` the claims each category of a contract detects with their nature,
  verdict and action, `detected()` what a phrase of the negative corpus must never trigger, and `score()`
  the text anchor. It passes the claim-parser, claim-detect and claim-anchor vectors and finds nothing in
  the negative corpus of the three example contracts.

## [0.6.1] - Unreleased

A turn another agent should read reaches the memory as soon as it is said.

### Changed

- `track()` sends a conversation turn at once: `queue.turnFlushIntervalMs` is now 0 (it was
  200 ms). The wait was most of the time between a customer's message on one channel and the
  moment an agent on another channel could read it. Turns still coalesce: turns queued in the
  same tick leave together, one batch is in flight per client, and whatever is queued while it is
  answered leaves together as the next batch, so a burst of turns costs one request per round
  trip, never one per turn. Order, retries and the 1 s `flushIntervalMs` of items outside a
  conversation are unchanged. Set `turnFlushIntervalMs` to keep the old wait.

## [0.6.0] - Unreleased

The memory has one behavior: every read that carries the customer's turn gets the conversation's
pinned pack and that turn's slots. Not published; the n8n and Flowise packages did not change.

### Added

- The voice read path (`src/voice.ts`): in the `voice` view with a conversation or task id, a turn
  never waits on a round trip to the region for what can be known in advance. From Brazil to a
  cell in us-east-2 the round trip is about 145 ms, and every voice read of 0.5.0 paid it within a
  150 ms budget, so a voice agent far from the region often got no memory at all.
  - The pinned pack is the same bytes for the whole conversation, so once a read brought it, every
    later turn gets it from memory at once, whatever its age, and the SDK revalidates it by ETag in
    the background.
  - `niadra.begin(params)` and `conversation.begin()` start the first read when the call starts
    (ringing, the inbound webhook, the caller joining), so it runs while the call is set up;
    `conversation.ready()` waits for it there, within `timeouts.contextVoiceStart`. A turn that
    finds it still running waits only within its own budget.
  - `prefetch()` still warms the server, and once the partial transcript has stayed the same for
    `voice.settleMs` (200 ms) the SDK reads the turn with it: one such read in flight per
    conversation, the newest settled text next. The final turn takes that read's slots and delta
    when its words start with the partial's and the partial carries at least `voice.minCoverage`
    (three quarters) of them; otherwise it reads its own words.
  - A turn waits for the read of its words at most `timeouts.contextVoice`. Past it, the turn gets
    the pinned pack without slots, and the read goes on in the background (within
    `timeouts.prefetch`): its answer revalidates the pack and leaves its delta for the next turn.
  - The first voice read of a client measures the round trip to the region once (`GET /healthz`,
    twice, the faster; `niadra.rtt`) and logs a warning when `contextVoice` or
    `contextVoiceStart` cannot hold it.
  - `ClientOptions.voice` (`enabled`, `settleMs`, `minCoverage`, `probe`), `VoiceOptions`,
    `DEFAULT_VOICE`. `voice: false` keeps the 0.5.0 behavior.
  - Measured with a fake region answering in 150 to 400 ms (`test/voice.test.ts`): voice turns after
    the first returned in 0.1 ms with the pinned body and their own slots, one read of a partial
    transcript per turn; the first read left at once after `begin()` and `ready()` after 400 ms of
    call setup returned in 0.2 ms; a turn whose read had not landed returned at its 200 ms budget
    with the body and the next turn got the delta. The same turns on the 0.5.0 path took 152 ms
    each and none got its slots.
- `timeouts.contextVoiceStart`, 1,500 ms: the first read of a call, made while the phone rings or
  the inbound webhook runs. A cold connection costs three round trips (TCP, TLS, the request) plus
  the server's first compile: 3 x 400 ms + 300 ms at a 400 ms round trip.

### Changed

- `timeouts.contextVoice` is 200 ms (was 150 ms), and in a voice conversation it is no longer a
  round trip: it bounds the wait for the read of a turn's words already in flight. That read starts
  200 ms after the last word changed and the platform ends the turn later (LiveKit waits at least
  500 ms), about 300 ms of head start; with 200 ms of wait on top, the slots make the turn while
  round trip plus server time stay under 500 ms, a round trip of up to about 400 ms at the server's
  p95. 200 ms is the usual gap between two people's turns, so a longer wait would be heard.
- The voice adapters use this path. LiveKit's `NiadraMemory` starts the first read when it is built
  and the first reply waits for it; the prefetch it already sent while the caller speaks now also
  brings the turn's slots. Retell (`inbound`, `call_started` and the custom LLM socket), Vapi
  (`assistant-request`) and ElevenLabs (conversation initiation) start the read at call start,
  after the proof when one is given, and wait for the pack within `contextVoiceStart` instead of
  the turn budget. `verifyTwilio()` starts it on the incoming call webhook (`ringing`), at the level
  the attestation proved.
- Ending a conversation or task drops what the SDK kept in memory for it (its packs and, in the
  voice view, its line) at once, before the server confirms the end, and an answer still on its
  way then is not stored (each purge moves the scope's epoch in the cache).

- A read with a turn, or with its own `query`, always goes to the API and always settles as a read
  of the pinned pack: the pack is cached as the read without `query`, and the slots never are. In a
  conversation, `context({ query })` no longer leaves the conversation's pack and deltas alone: it
  picks the slots by those words, and the pack is the pinned one.
- `ContextPack.spec` is `"context-pack.v1"`, the one version the SDK reads; the `spec/` copy
  carries only that schema.
- Tests pin the queue's order: one `/v1/batch` in flight per client, `flush()` waits for the batch
  the background send has in flight (even with nothing queued), and `conversation.ended` lands
  after the turns queued before it, as does everything `shutdown()` sends. The TypeScript queue
  already behaved this way; the Python SDK 0.5.0 did not (fixed in its 0.6.0).

### Removed

- The fallback for a space that answered a turn without slots: the second read of the pinned pack
  within the same budget, and the ten minutes without sending the turn after such an answer.
- `spec/context-pack.v0.json` and its example.

## [0.5.0] - 2026-09-26

Ready to publish; npm still has 0.1.1, so 0.5.0 carries 0.2.0 through 0.5.0.

```sh
git checkout main && git pull --ff-only
pnpm install --frozen-lockfile && pnpm check && pnpm runtimes && npm publish --access public
```

(Or push the tag `v0.5.0` once trusted publishing is configured for `@niadra/sdk`; see
`.github/workflows/release.yml`.) The n8n and Flowise packages did not change.

### Added

- `explain` on `ContextRequest`, `ContextParams` and `ContextOptions` (`niadra.context()`,
  `conversation.context()` and `task.context()`): requires `format: "json"`
  (throws `NiadraValidationError` otherwise) and adds `why` to each of `pack.slots`, a `SlotWhy`
  naming the retrieval channels that ranked the item (`SlotChannelRank`: `channel`, `position`,
  `weight`, `contribution`), the fused `score`, the `weights_version` used and, for a derived
  line, the `rule` and `basis` behind it. It changes nothing else: the pinned text, the slots
  chosen and the receipt are the same bytes with or without it.
- Types: `SlotChannelRank`, `SlotWhy`, `PackSlot.why`, and `ContextUseEntry` (with `slots`), the
  server's per-delivery measurement, ids public.
- `BatchResponse.masked` and `IngestStatus.masked`: values held back from storage before it, by
  type (`card`, `cvv`, `password`, `secret`), counts only, never the values.
- Backed answers. `conversation.agent()` and `task.agent()` now read every number, date, code and
  amount the answer states (amounts with a currency or a money word, dates in PT, EN and ES, codes
  with three or more digits, numbers of three or more digits; never words, one or two digits, times
  or a year on its own) and look each up in what the agent had: the packs and suffixes it read, the
  customer's words, a human attendant's, the results of `action({ result })`, the history tools of
  `tools()`, and `toolResult()` for tools of your own. A sum or difference of two backed amounts, a
  sum of three, or a backed amount times a count are backed too. The turn carries the result as
  `backing` (`checked`, `unbacked_values` by kind, `guard_violations` by short id), never a value;
  `lastBacking` keeps the full `BackingReport`. `agent(text, { strict: true })` returns the values
  with no source (`UnbackedValue[]`, a card or document number masked) instead of sending the
  turn, and an empty array when it sent it. The check never fails a turn and costs well under
  5 ms an answer. `checkBacking()` and `BackingSources` run it on their own.
- Guard lines: `ContextResponse.guards` (`PackGuard`: `id`, `value_type`, `value`),
  `PackSlot.id` (the short id of the item a slot line states) and `section: "guard"` for a guard
  line. `agent()` checks the answer against the guards of the read before it and names the ones it
  went against on the turn, which the server turns into a `guard.violated` webhook at once; with
  `strict: true` the conflicting values come back too.
- Types: `Backing`, `ValueKind`, `EventItem.backing`, `TrackEvent.backing` (validated: only on an
  agent's message), `PackGuard`, `AgentTurnOptions`, `BackingReport`, `UnbackedValue`, `GuardLike`.

## [0.4.0] - 2026-09-25

Ready to publish; not on npm yet. It carries everything in 0.2.0 and 0.3.0, so since neither was ever
published, publishing 0.4.0 alone is enough. From a clean checkout of `main`, with the owner's npm passkey:

```sh
git checkout main && git pull --ff-only
pnpm install --frozen-lockfile && pnpm check && pnpm runtimes && npm publish --access public
```

(Or push the tag `v0.4.0` once trusted publishing is configured for `@niadra/sdk`; see
`.github/workflows/release.yml`.) The n8n and Flowise packages did not change.

### Added

- `search({ ..., limit })` caps the items after the token budget, and `filters.where` takes a
  condition tree for search and timeline: `AND`, `OR` and `NOT` over `id`, `kind`, `channel`,
  `category`, `outcome`, `source_id`, `vendor`, `at`, `valid_until`, `confidence`, `text`,
  `object_type` and `object_namespace`, with `eq`, `ne`, `in`, `nin`, `gt`, `gte`, `lt`, `lte`,
  `contains`, `icontains` and `exists`. It narrows what the policy let through; it never reorders.
- `feedbackBatch(items)`: up to 500 corrections in one call, each with its own idempotency key
  (minted when missing); per-item errors come back by index.
- `ingestStatus({ conversation_id } | { task_id })`: whether what was sent became memory yet
  (`open`, `processing`, `ready`, `failed` or `unknown`), states and times only.
- `whoami()`: what the key authenticates as (space, source, vendor, scopes, audience, whether agent
  memory is on), for any key.
- `niadra.admin`, for a key with the `admin` scope: `findProfiles`, `memory`, `factHistory`,
  `correct`, `correctBatch` (item `n` keyed `<key>:<n>`), `forget`, `forgetStatus` and `export`.
  They resolve `{ data, error }` and fail open like the rest of the client.
- Types: `IngestStatus`, `KeyIdentity`, `ProfileMemory`, `FactOut`, `FactHistory`, `ProfileMatch`,
  `CorrectionRequest`, `ForgetTarget`, `Erasure`, `ExportPackage`, `WhereExpression`.
- The customer's turn on the read path. A conversation sends the customer's last turn (the text of
  the last `customer()`) as `query` on every `context()`; `turn` passes another one and
  `turn: null` sends none. The answer keeps the pinned pack and adds `slots`, what that turn
  selected from memory, which `suffix` places after the live turns and before the delta, as the
  API documents it, so every integration gets it with no change. The pack is cached as the read
  without `query` and the slots never are; a read as data asks for the whole answer, so each turn's
  pack carries its own slots. An answer without slots made the client read the pinned pack again
  and stop sending the turn for ten minutes (removed in 0.6.0). `niadra.context()` takes `turn`
  too.
- The pack as data follows `context-pack.v1`: `pack.slots` lists the turn's lines typed as
  `PackSlot` (`section`, `derived`: `count`, `no_record` or `withheld`, `channels`, `text`) and
  `ContextResponse.slots` is the rendered block. A pack of the earlier version reads with
  `slots: []`. `spec/context-pack.v1.json` is the schema, and a test keeps the types equal to it.
- `niadra.prefetch()` and `conversation.prefetch()`: `POST /v1/context/prefetch` with a partial
  transcript of the customer's turn, so the server warms what the read that answers the turn will
  need. In the background, one at a time per conversation (the newest text waits for the one in
  flight), never rejecting and never holding a turn; a server without the route is not asked again
  for ten minutes. `timeouts.prefetch` bounds it (1 s).
- Voice adapters: `@niadra/sdk/livekit` sends the turn so far on each `user_input_transcribed`
  event, and `@niadra/sdk/retell` on each `update_only` event of the custom LLM websocket whose
  transcript ends with the caller speaking. Types: `PackSlot`, `PackSlotDerived`,
  `PrefetchRequest`, `PrefetchParams`.

### Changed

- `suffix` (and `renderSuffix()`) puts the live turns first and the delta last (it was the delta
  first), the order the API documents with the slots between them. Only the end of the prompt
  moves; the pinned pack and the provider's prompt cache are not affected.

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
