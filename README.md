# Niadra TypeScript SDK

[![npm](https://img.shields.io/npm/v/@niadra/sdk)](https://www.npmjs.com/package/@niadra/sdk)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

**Niadra is the shared customer memory for every AI agent in a company.** The WhatsApp agent, the
voice agent, the billing agent and the human team read the same memory before they act and write
back what they said and did. This package connects a TypeScript or JavaScript agent to it, on Node
18+ and on edge runtimes (Vercel, Cloudflare Workers, Deno).

[Website](https://niadra.com/en) · [Documentation](https://docs.niadra.com/en) ·
[Talk to us](https://niadra.com/en/enterprise) · [Python SDK](https://github.com/ainiadra/niadra-sdk-python)

```sh
npm install @niadra/sdk
```

## The problem it solves

A customer tells your WhatsApp agent that order 4471 arrived with a broken lid and that she needs a
replacement by Friday. An hour later she calls. Without shared memory, the voice agent asks her to
explain everything again, and nobody remembers the Friday promise. With Niadra, the voice agent
starts the call knowing about the open replacement and its deadline, and when the billing agent
credits her invoice, the other agents see it within seconds.

Niadra does the remembering for you:

- it turns conversations and system events into facts, open items and promises, each with the
  turns that prove it;
- it ties them to the right person across phone numbers, e-mails, WhatsApp ids and CRM ids, and to
  the companies and partners that person acts for;
- it compiles a short context for each agent, holding back what the customer's verification level
  does not allow, and records a receipt of every read.

Your agents keep their own models, prompts and vendors. Niadra is the memory layer they share.

## Quickstart

```ts
import { Niadra, handles } from "@niadra/sdk";

const niadra = new Niadra({ apiKey: process.env.NIADRA_API_KEY });
const marina = handles.phone("+5511987654321");
const convo = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "wa-8812" });

convo.customer(inbound.text, { idempotency_key: inbound.id }); // what the customer wrote
const ctx = await convo.context();                                // what this agent needs to know now
convo.markInjected(ctx);
const reply = await callModel(instructions + "\n\n" + ctx.text, history, ctx.suffix);
convo.agent(reply);                                               // what the agent answered
await convo.end();
```

Three moments cover most agents: read the context before the model call, record the turns after
it, and record an `action()` when the agent does something in a system (a refund, a new delivery
date). `wrap()` does the reading and recording for you around an OpenAI-compatible client. Ships
ESM and CommonJS builds with full type definitions; it only needs `fetch`.

## What your agent gets

| Call | What it returns |
|---|---|
| `context()` | a few lines about this customer, compiled from every channel and agent, pinned for the conversation |
| `search()`, `timeline()`, `open()` | the full history on demand, with how often a problem happened before |
| `tools()` | the same history as function-calling tools bound to one customer, for any model provider |
| `subjectToken()` | a token that binds an MCP connection to one customer |
| `track()`, `action()` | messages, system events and actions, sent in the background, never blocking the agent |
| `identify()`, `verify()` | which ids belong to the same person, and what the conversation proved about who is there |
| `objectState()`, `objectTimeline()` | a business object (an order, an invoice, a ticket) as the systems of record reported it |
| `feedback()` | a correction of what Niadra derived, audited like any other event |

## Questions people ask

**How do I give my AI agent memory of past conversations on other channels?** Record the turns
with `track()` or `conversation()` in every agent, and read `context()` before each model call.
Niadra ties the turns to the person, whichever id each channel uses.

**How is this different from keeping chat history in my database or in a vector store?** Stored
history is raw text for one channel. Niadra keeps derived facts and open items with evidence,
resolves identity across channels and systems, closes items when a system of record confirms an
action, and filters what each agent may read by the verification level of the conversation.

**What happens if Niadra is slow or down?** The agent keeps answering without the memory. Every
call has its own time budget (150 ms for voice context, 300 ms otherwise) and resolves with an
error value instead of throwing, unless you ask for strict mode.

**What about privacy and LGPD or GDPR?** Items carry a verification level and a purpose, and the
policy decides what each agent sees. Every read leaves a receipt, and a person can be erased or
exported on request. The SDK never logs handles or message text.

**Which models and frameworks does it work with?** Any. The context is text you place in your
prompt, the tools follow the common function-calling format, and `wrap()` covers
OpenAI-compatible clients.

## Concepts

### Keys and endpoints

A source key looks like `nia_sk_<live|test>_<region>_<space>_<key_id>_<secret>`. The SDK derives the endpoint from it, `https://<space>.<region>.api.niadra.com`, so there is nothing else to configure. `live` keys reach production spaces and `test` keys reach sandbox spaces, which never share data.

Pass `baseURL` (or set `NIADRA_BASE_URL`) to point at the local emulator or a private endpoint.

### Handles

A handle identifies a customer in some channel or system. Use the builders so the type and scope are right:

```ts
handles.phone("+5511987654321");
handles.email("marina@example.com");
handles.waId("5511987654321");
handles.systemId("C-0042", "crm");      // scope: the system that issued the id
handles.emailDomain("acme.com");        // an organization, not a person
```

Handles are personal data. The SDK only ever sends them in request bodies, never in URLs, and never writes them to logs.

### Context

```ts
const ctx = await niadra.context({
  subject: marina,
  conversation_id: "wa-8812",
  view: "chat",              // "voice", "brief", "full", "account", "task:billing", ...
  verification: "V1",        // what the customer has proven in this conversation
});

const system = `${agentInstructions}\n\n${ctx.text}`;
const messages = [...history, { role: "user", content: `${ctx.suffix}\n\n${userTurn}` }];
```

- `text` is the pack. Inside a conversation the server pins it: the same bytes on every turn, so your model provider's prompt cache keeps hitting.
- `suffix` holds what changes turn by turn: the delta and the live turns from other channels that the pack has not absorbed yet. It belongs at the end of the prompt, after the conversation.
- `delta: true` asks for what changed since this agent last read the subject. The server sends each change once, so the SDK hands each delta out once too, even one fetched by a background refresh; `conversation()` keeps them for you.
- `source` says where the result came from (`network`, `cache`, `stale`, `fallback` or `none`), and `error` says what went wrong when something did.
- Pass `object: "invoice:erp:0823"` instead of `subject` when the task is about a business object, and `about` for the account a person acts for.

### Conversations

`conversation()` wraps one customer thread: it reads the pack the server pins, keeps the deltas, captures turns and ends the conversation.

```ts
const convo = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "wa-8812" });

convo.customer(inbound.text, { idempotency_key: inbound.id });
const ctx = await convo.context();
convo.markInjected(ctx);                                        // when the pack went into the prompt
const reply = await callModel(ctx.text, history, ctx.suffix);
convo.agent(reply);                                             // carries the context stamp

await convo.verify({ method: "otp_whatsapp", level: "V2" });   // later reads use the new level
await convo.handoff({ target: "human", reason: "asked for a person" });
await convo.end();
```

After the first pack, each read also asks for the delta, and the conversation keeps every delta it receives, in order, in `suffix`, ahead of the live turns. When the server pins a new pack, after `verify()` for instance, the kept deltas are dropped: the new pack already has them. A read with `query` is a one-off and leaves them alone.

Call `markInjected()` each time you put the pack in a prompt. The agent's turns and actions that follow carry it as `context_stamp`, with the pack's etag, which is how Niadra tells a context that arrived after the agent spoke from one the agent had and did not use. `timings` keeps the first injection and the first agent turn, for your own checks.

### Wrapping an OpenAI-compatible client

```ts
import OpenAI from "openai";
import { wrap } from "@niadra/sdk";

const openai = wrap(new OpenAI(), convo);
const completion = await openai.chat.completions.create({ model: "gpt-4.1", messages });
```

Every `chat.completions.create` and `chat.completions.parse` call through the wrapper, streaming or not, gets the pack after your leading system messages and the suffix at the end. The injection is stamped, and the model's answer (its first choice) is recorded as the agent's turn: at once, or when a stream ends or you stop reading it. `.withResponse()` keeps working and records too; `.asResponse()` returns the raw HTTP response, so nothing is recorded then. Pass a function instead of a conversation to pick one per call; when it returns `null`, the call passes through untouched. Nothing the wrapper does can fail your call: a context it cannot fetch is left out, and a failure to record the answer is logged, without content.

### Tasks

Internal agents (billing, collections, triage) work in tasks rather than conversations. A task centers its pack on its object, keeps deltas and stamps like a conversation, scopes the cache, groups events and ends with `task.ended`.

```ts
const task = niadra.task({ channel: "billing-agent", object: "invoice:erp:0823", view: "task:billing" });
const ctx = await task.context();
task.markInjected(ctx);
task.action({ operation: "credit", result: "R$ 40 credited", closes: { object: { type: "invoice", namespace: "erp", id: "0823" }, operation: "credit" } });
await task.end();
```

### Writing

| Method | Records | Delivery |
| --- | --- | --- |
| `track(event)` | A message, a system event (`kind: "system_event"`) or an action (`kind: "action"`) | Queued, batched |
| `action(event)` | What an agent did in a system of record; `closes` resolves the open item it fulfils | Queued, batched |
| `identify({ handles })` | That several handles belong to the same person or organization | Sent at once |
| `verify({ handle, method, level })` | That the customer proved who they are, for one conversation or task | Sent at once |
| `handoff({ conversation_id, target })` | A transfer to a human or another agent | Sent at once |
| `feedback({ subject, action, ... })` | A correction of what Niadra derived: `retract_fact`, `correct_fact`, `resolve_open_item`, `conversation_outcome` | Sent at once |

Every item carries an idempotency key: the provider's message id when you pass one, a UUIDv7 otherwise. Retrying the same event is harmless.

`identify()`, `verify()`, `handoff()` and `feedback()` resolve to `{ ok, idempotency_key, error }` once the server has answered. A correction is recorded as an event, so it is audited like any other. A `context()` call made after `identify()` or `verify()` resolves already reflects it.

### History navigation

When the pack is not enough, search the customer's history. Each call resolves to `{ data, error }`, with exactly one of the two set:

```ts
const { data, error } = await niadra.search({ subject: marina, query: "technician visit", filters: { channels: ["voice"] } });
const page = await niadra.timeline({ subject: marina, limit: 20 });

const first = data?.items[0];
if (first) {
  const opened = await niadra.open(first.id, { conversation_id: "wa-8812" });
}
```

`search()` also reports recurrence: how many times the same kind of issue came back, and how it was last resolved.

### Business objects

```ts
const { data: invoice } = await niadra.objectState("invoice:erp:0823");        // state, as_of, open items
const { data: page } = await niadra.objectTimeline("invoice:erp:0823", { limit: 20 });
```

The state comes only from what the systems of record reported; an agent's action counts once a system confirms it. The timeline lists system events and agent actions, newest first, never what anyone said. Object ids are record ids, not personal data, so they go in the URL; an id with a slash cannot be addressed that way.

### Media

```ts
const { data: upload } = await niadra.uploadMedia({ data: recording, content_type: "audio/wav", subject: marina });
if (upload) {
  convo.track({ speaker: "customer", content: { type: "audio", media_ref: upload.media_ref, media_sha256: upload.media_sha256, transcript } });
}
```

Media never travels inside an event. `uploadMedia()` takes a `Uint8Array`, `ArrayBuffer` or `Blob`, reserves an upload, sends the bytes straight to storage over a signed URL (HTTPS only, with exactly the headers the signature covers and nothing else, so never your key or default headers; storage checks the body against the declared size and digest), and resolves with the reference and digest for the event. With `subject`, the file is stored under that person, so erasing them erases it even if no event ever references it. Hashing uses Web Crypto, which Node 18 only exposes behind a flag.

### Tools for any model

`tools(subject)` returns the navigation kit as function-calling definitions, with the customer bound in the SDK rather than in the tool arguments. The model chooses what to look for, never whom it is about, so a prompt injection has no argument to switch customers with.

```ts
const kit = convo.tools();   // or niadra.tools(marina, { conversation_id: "wa-8812" })

const response = await openai.chat.completions.create({ model, messages, tools: kit.definitions });
for (const call of response.choices[0].message.tool_calls ?? []) {
  if (kit.has(call.function.name)) {
    messages.push({ role: "tool", tool_call_id: call.id, content: await kit.call(call.function.name, call.function.arguments) });
  }
}
```

The definitions use the `{ type: "function", function: { name, description, parameters } }` shape. For APIs that expect `{ name, description, input_schema }`, map `function.parameters` to `input_schema`.

### Subject tokens for MCP

`subjectToken()` mints a signed token, valid for 15 minutes, that binds one customer, conversation and verification level. Call it from your backend and pass the token to the MCP connection; tools served over MCP then read that customer only.

```ts
const { data } = await niadra.subjectToken({ subject: marina, conversation_id: "wa-8812", verification: "V1" });
```

## Failure behavior

Memory should make an agent better, never make it fail. By default:

| Situation | What happens |
| --- | --- |
| No API key | The client is a no-op. Every method resolves with an empty result and nothing is sent. One warning is logged. |
| Invalid arguments | Logged and dropped. `context()` resolves with empty `text`; `track()` returns `null`. |
| Timeout, network error, 5xx | Reads resolve with an empty result, or with the last good pack of the conversation (`source: "fallback"`). |
| A `degraded` answer while a good pack is cached | The good pack is kept and served (`source: "fallback"`). |
| 401 or 403 | Not treated as an outage: the cached packs are dropped (all of them on 401, the one requested on 403) and `context()` returns empty. Revoking a key also stops what the process had cached. |
| 421 (the space moved to another cell) | Retried at once, up to three attempts. |
| 429 on a batch | Retried after `Retry-After`. |
| Batch failure | Retried with exponential backoff and jitter, three attempts. 4xx answers other than 408, 421 and 429 are never retried. A batch that still fails is dropped and logged. |
| Queue full (10,000 items) | New events are dropped and logged. |
| Server rejects one item of a batch (207) | Only that item fails; the rest are stored. |

Every read has its own time budget, independent of your platform's:

| Call | Default |
| --- | --- |
| `context()` | 300 ms, 150 ms with `view: "voice"` |
| `search()`, `timeline()`, `open()`, `objectState()`, `objectTimeline()` | 600 ms, 300 ms through voice conversations and voice-bound tools |
| `subjectToken()` | 2 s |
| Each attempt of a batch, `feedback()` or an upload reservation | 5 s |
| Each attempt of an `uploadMedia()` transfer | 60 s |

Override them with `timeouts`, or per call with `{ timeout }`. Pass `{ signal }` to cancel a call.

### The context cache

Inside a conversation or task, packs are cached in memory:

- younger than 10 s: returned without a request;
- up to 10 minutes older: returned at once while one background request refreshes it;
- when a request fails: the last good pack, if it is less than 30 minutes old;
- at most 1,000 packs, the least recently used evicted first.

Refreshes send the cached ETag, so an unchanged pack costs a `not_modified` answer instead of the
full text, and only one background refresh per pack runs at a time. A 401 or 403 is not an
outage: the cached packs go (all of them on 401, the one requested on 403), so cutting a vendor's
access also cuts what it had cached. A plain read and a `delta` read of one conversation share one
entry, and each delta is handed out once.

Configure it with `cache: { ttlMs, staleWhileRevalidateMs, maxStaleMs, maxEntries }`, or turn it off with `cache: false`.

### Strict mode

`new Niadra({ strict: true })` throws instead of logging: configuration errors from the constructor, validation errors from `track()`, request errors from reads, and lost batches from `flush()`. Use it in tests and during development.

## Runtimes and shutdown

- **Long-running Node services:** queued events are flushed when the event loop runs out of work (`beforeExit`). That event does not fire on signals or `process.exit()`, so call `await niadra.shutdown()` in your SIGTERM handler.
- **Serverless functions:** `await niadra.flush()` before returning.
- **Edge runtimes:** pass the flush to the platform, for example `ctx.waitUntil(niadra.flush())`.

Create one client per process and share it: it owns the queue and the cache.

## Configuration

```ts
new Niadra({
  apiKey: "nia_sk_live_...",                 // default: NIADRA_API_KEY
  baseURL: "http://localhost:4010",          // default: NIADRA_BASE_URL, then derived from the key
  timeouts: { context: 300, contextVoice: 150, navigation: 600, navigationVoice: 300, write: 5000, token: 2000, upload: 60_000 },
  cache: { ttlMs: 10_000, staleWhileRevalidateMs: 600_000, maxStaleMs: 1_800_000, maxEntries: 1000 },
  queue: { flushAt: 15, flushIntervalMs: 1000, maxBatchSize: 100, maxQueueSize: 10_000, maxAttempts: 3 },
  strict: false,
  flushOnExit: true,
  logger: console,                           // anything with debug, warn and error
  fetch: globalThis.fetch,
  defaultHeaders: {},
});
```

Log lines carry status codes, error codes and request ids. They never carry handles, message text or the API key.

## Errors

All errors extend `NiadraError`. API errors are `NiadraAPIError` with `status`, `code` (from the problem document), `requestId` and `problem`; `NiadraAuthenticationError` (401), `NiadraPermissionError` (403) and `NiadraRateLimitError` (429, with `retryAfterMs`) narrow it. The others are `NiadraTimeoutError`, `NiadraConnectionError`, `NiadraAbortError`, `NiadraValidationError` and `NiadraConfigError`.

Include `requestId` when you contact support.

## Development

```sh
pnpm install
pnpm check     # typecheck, lint, tests
pnpm build     # ESM and CommonJS into dist/
```

## Em português

A Niadra é a memória de clientes compartilhada por todos os agentes de IA de uma empresa: o agente
do WhatsApp, o de voz, o de cobrança e o time humano leem a mesma memória antes de agir e registram
o que disseram e fizeram. Este pacote conecta um agente em TypeScript ou JavaScript a essa memória:
`context()` antes de chamar o modelo, `track()` depois, e `action()` quando o agente faz algo num
sistema. Documentação em [docs.niadra.com](https://docs.niadra.com) e contato em
[niadra.com/enterprise](https://niadra.com/enterprise).

## License

Apache 2.0. See [LICENSE](./LICENSE).
