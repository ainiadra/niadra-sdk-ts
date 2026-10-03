# Changelog

All notable changes to this package are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.10.1] - 2026-10-03

### Added

- `contextUse({ since, until, group_by, source_id, channel, view, experiment_group })`: the context-use report
  (`GET /v1/context-use`) as `ContextUseReport`, with its buckets typed and the other blocks passing through.
  A key of an `analyst` source with the `analytics` scope reads every source of the space.
- `link({ person, organization, role })` and `endLink(linkId)`: a system of record that knows who works for whom
  (a CRM, an HR system) links a person to the account or partner they act for, and ends the link, with a key
  that has the `identity:link` scope instead of `admin`. `can_see_contacts` still needs `admin`. `Link` and
  `LinkRequest` are the types.

## [0.10.0] - 2026-10-03

### Added

- `open(id, { about })`: with the person bound in `subject`, also an item of the organization they act for that
  their view shows (the pack's account block). `tools()` bound with `about` passes it, so the kit reaches what
  the pack shows.
- `about_unlinked` on `ContextResponse`, `SearchResponse` and `TimelineResponse`: `about` named an organization
  with no active link to the subject, and the read went on with the subject's own memory. A conversation or a
  task warns once through its `logger`.
- `explain(error)`: an API refusal for a log line, with its code, detail and request id. A coordination check
  takes the client's `logger`, and `HistoryItemKind` includes `system_event`.

### Changed

- An API error's `message` ends with the request id: `422 invalid_input: <detail> (request <id>)`.
- `govIdHmac` and `orgRegistryHmac` take the document number itself; the space keeps only a keyed hash of it.
- Idle connections are kept for `keepAliveMs` between turns, and a call that has to open a connection gets
  `timeouts.connect` (1,000 ms by default) on top of its method's budget, once per cold period, so a first read
  after idle no longer times out on the TLS handshake.
- A coordination check the API refuses (400, 401, 403 or 422) is `invalid_request`, never `unchecked`: an
  outbound contact is deferred and an inbound one allowed, and `strict` throws. Refusals of background writes
  (the outbox, turn records) log the problem's detail and request id.
- The tool definitions follow the server's: the timeline tool says it also lists the open items, facts,
  patterns or objects `filters.item_kinds` names.

## [0.9.1] - 2026-10-02

### Changed

- The canonical phone of the suppression list follows the revised rules of the suppression spec (3.1 and 3.4): Mexico's and Argentina's mobile prefixes, an 11-digit North American number, a carrier code, `(0)`, `tel:` and direction marks. The key the SDK computes for an opted-out contact matches the server's again.

### Added

- A route or field the API deprecates answers with the `Deprecation`, `Sunset` and `Link` headers; the
  client logs one warning per deprecated route per process through its `logger`, with the two dates and the
  migration note, never the path.

## [0.9.0] - 2026-09-30

### Added

- `ContextResult.ageMs`: how long ago Niadra sent or confirmed the pack a read served. It is 0 for an answer
  just received and grows while the cache serves the pack (`cache`, `stale`, or `fallback` with Niadra down).
- The chaos test (`test/chaos.test.ts`): Niadra's process killed, its network gone silent, answering 503 and
  answering past the deadline, in the middle of a conversation.
- A state read's objects carry `derived`: the type's derived fields over its related objects (a look's
  `all_pieces_available`), computed at the read, each with `v`, `logic`, `over` and `unknown`
  (`DerivedState`). A shared object of a derived type carries `derived_status`, and its push's `inputs` name
  shared objects.

### Fixed

- The local copy of the suppression list is read to its end against the server: a page shorter than the limit
  ends a read, and its cursor is where the next read starts. The server names the cursor on the last page
  too, so the copy read 50 pages of nothing and was never held: `mayContact()` and a check that Niadra did not
  answer fell back on the purpose's direction. The stand-in cell answers as the server does.
- A batch of events that still fails after its attempts with an error that may pass goes back to the front of
  the queue and leaves again after a pause, doubling up to a minute, instead of being dropped: what an agent
  said during an outage longer than a few seconds reached Niadra only in part.
- A check about an outbound contact keeps the local copy of the suppression list, read in the background once
  a minute. Before, only `mayContact()` read it, so an agent that only called `check()` had no copy when Niadra
  went down, and a purpose that fails open (`service`, `transactional`) went out to a customer who had opted
  out of it.

## [0.8.0] - 2026-09-30

### Added

- The claim guard takes the offers a context read served as evidence: each object in the constraints block's
  `already_presented` carries the numbers it was last shown with (`values`: price, total, discount,
  installment), each with its role and whether it may be claimed now, and `blockValues()` turns them into
  values the guard checks a number against, as it checks a tool's result. An offer shown too long ago to claim makes the
  number `stale`, and a price only the pack's text states is still `unsupported`. The constraints block's
  `Shown` model gains `values` (`ShownValue`).

### Removed

- `tool(..., { binding })`, `new Counterfactual(..., { bindings })` and `niadra counterfactual --bindings`: a
  tool's binding comes only from the space's `tool-bindings` document, which the SDK profile serves. A
  counterfactual for a tool the space does not bind stops before calling it.

## [0.7.0] - 2026-09-30

The agent core. Every turn an agent takes is recorded in its own process; what it says is checked against
what its tools returned; agents, people and systems coordinate before they contact a customer or act; the
objects a company's systems push reach the agent as typed state with the freshness to say them; each agent
keeps its working state; and a company replays turns, derives its types and measures a tool's
counterfactual in its own CI. The framework adapters record turns. Every feature is off until the space
turns it on, and a space that did not ask sees no change.

The versions published before it were previews: nothing of theirs carries over, and none of their names,
options or fallbacks is kept.

### Added

- `Niadra`, with the endpoint derived from the source key and fail-open behavior on every public method
  (`strict: true` to throw instead), in Node, Deno, Bun, Cloudflare Workers and edge runtimes.
- `context()` before the model call, cached per conversation and revalidated by ETag, with the customer's
  last turn as `query` (the turn's `slots`), `prefetch()` while the customer speaks, the voice read path,
  `format: "json"` for the pack as data (`context-pack.v1`) and `explain: true` for why each slot was chosen.
- History navigation (`search()`, `timeline()`, `open()`) and `tools()`, the same navigation as
  function-calling tools bound to one customer, with `subjectToken()` for MCP.
- Writes through a bounded queue with one batch in flight (`track()`, `action()`, `identify()`, `verify()`,
  `handoff()`), `conversation()` and `task()`, `feedback()`, `feedbackBatch()`, `uploadMedia()`,
  `ingestStatus()`, `whoami()`, `objectState()` (the object as a state read serves it, `ObjectRead`) and
  `objectTimeline()`.
- Agent memory (`agentMemory()`, `searchAgentMemory()`, `remember()`), backed answers and the guard lines a
  read carries; `niadra.admin` for a key with the `admin` scope.
- `wrap()` for OpenAI-compatible clients and the adapters under `@niadra/sdk/<integration>`; the n8n and
  Flowise nodes in `packages/`.
- `niadra.api` (`Api`): one method per route of turn records, replay and scenarios, typed state and the
  agent's working state, subject signals and measurement, and coordination, named in camelCase as the
  server names the operation. Unlike the rest of the client they never fail open.
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
- The `niadra` command for Node (`npx niadra`): `resolver-worker`, `replay`, `counterfactual`,
  `types derive` (with `--check`) and `contract test`, with the Python command's arguments and exit codes.
  `types derive` reads one PostgreSQL table's catalog (never a row), computes the same fingerprint as the
  Python SDK and passes the `type-derive` vectors; `--check` sends Niadra only the fingerprint and the
  counts.
- The blocks a read asks for reach the model: with `include`, the state view's lines and the constraints
  block go in `suffix` after the slots, inside one `<niadra>` section in the pack's language, byte for byte
  what the Python SDK writes; a read without blocks keeps its suffix. The context answer also carries the
  coordination block.
- `niadra.internalText`: fingerprints of the company's own prompt (the same SHA-256 shingles as the Python
  SDK); a repeated passage gives way to the claim contract's `redact` line and is recorded with
  `internal_text_found`, never the text.
- `tool(name, fn, { binding })` records what a call did with the constraints block, and `maskOutput: true`
  keeps the fields the key may not read from the model (the last profile read while Niadra is down,
  `onUnknown: "block"` to fail closed). A turn keeps the pack, the block and the working state it read, and
  what the person was shown or engaged with (`frame.interact`).
- The tool counterfactual: `Counterfactual` behaves as the Python runner, sending Niadra only overlaps and
  positions.
- A replay starts from the working state the recorded turn read, and a sub-turn of a replayed turn is
  replayed and never sent. Mastra tools answer from the record; LangChain tools passed through
  `recordTools()` too, and the handler refuses any other with `NiadraReplayRefusedError` before it runs.
- Turn records from OpenAI Agents JS, Google ADK and VoltAgent with `turns: true`: each run is a turn, with
  each tool call (the framework's own call id) and each model call. ADK tools answer from the record in a
  replay; OpenAI Agents JS and VoltAgent cannot stop a tool from their hooks, so wrap those tools with
  `tool()` to replay them.
- One example per concept of the agent core (`examples/claim-guard.ts`, `coordination.ts`, `object-state.ts`,
  `working-state.ts`, `masked-tool.ts`, `tool-counterfactual.ts`) and `examples/ci/niadra-checks.yml`, each
  run by the tests.
- `ContextResponse.budget` (`BudgetBlock`, with `BudgetPack`, `BudgetUse` and `BudgetCut`): with
  `include: ["budget"]`, what the pack costs per section, what this agent already spent in the conversation
  and the case, and the units the measurement says it leaves unused. Shown, never enforced.
- `niadra.api.overview()`: the coordination overview in counts (`GET /v1/coordination/overview`).
- `pnpm sync-spec --spec` also copies the Context Pack schema (`spec/context-pack.v1.json`), and
  `test/spec.test.ts` holds `ContextResponse` and every include block to it.
- The tool bindings the space declares come in the SDK profile (`SdkProfile.tool_bindings`, typed
  `ToolBinding`), for this source's tools. A tool without a binding in code measures the constraints block
  and runs its counterfactual through the binding served for its name, and `binding` in code wins.
  Left unset, `maskOutput` follows the served binding's `capabilities.mask_output`. `api.constraints()` with
  `tool` answers the block rendered for that tool, as advice.
- Watch revalidation in `ResolverWorker` and `npx niadra resolver-worker`: a watch fires only on a value its
  source confirmed. The worker serves `watch_revalidation` requests first, pushes every object it read with
  the `request_id` it answers (which settles the request and decides the object's due watches even when the
  value did not change), and releases a request it cannot answer
  (`POST /v1/state/refresh-requests/{id}/release`), as `not_found` when the resolver returns `NOT_FOUND` and
  `failed` when it fails. A type without a resolver, or whose resolver's circuit is open, still waits out its
  lease. `Resolvers.fetch()` says why a read brought no object.
- `ConstraintsBlock.text`: the constraints block as the server writes it for a model, each field by its
  type's label and each operator in words, in the space's language. The suffix places it as it places the
  state view's text.
- The claim contract reads the computed values a state read serves as evidence, by their name, while they
  are claim-safe, and the claim guard takes as evidence every value the include blocks placed in the turn
  block. A value that is not claim-safe backs nothing.
- A hedged number is no claim (the claim contract spec, 5.4): "I can't confirm the $24.90 still applies" or
  "$689.00, not $612.00" state no such price.
