# Changelog

All notable changes to this package are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

The first release this changelog records. The versions published before it were previews: nothing of theirs
carries over, and none of their names, options or fallbacks is kept.

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
  `ingestStatus()`, `whoami()`, `objectState()` and `objectTimeline()`.
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
- `ContextResponse.budget` (`BudgetBlock`, with `BudgetPack`, `BudgetUse` and `BudgetCut`): with
  `include: ["budget"]`, what the pack costs per section, what this agent already spent in the conversation
  and the case, and the units the measurement says it leaves unused. Shown, never enforced.
- `niadra.api.overview()`: the coordination overview in counts (`GET /v1/coordination/overview`).
- `pnpm sync-spec --spec` also copies the Context Pack schemas (`spec/context-pack.v1.json` and `v2`), and
  `test/spec.test.ts` holds `ContextResponse` and every include block to the v2 schema.
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
