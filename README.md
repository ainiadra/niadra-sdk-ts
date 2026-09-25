# Niadra TypeScript SDK

[![npm](https://img.shields.io/npm/v/@niadra/sdk)](https://www.npmjs.com/package/@niadra/sdk)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

**Niadra is the shared customer memory for every AI agent in a company.** The WhatsApp agent, the
voice agent, the billing agent and the human team read the same memory before they act and write
back what they said and did. This package connects a TypeScript or JavaScript agent to it, on
Node 20+, Deno, Bun, Cloudflare Workers and the Vercel Edge Runtime: it needs only `fetch` and
Web Crypto, and CI runs the build on each of them.

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
OpenAI-compatible clients; `agent(text, { usage })` takes the usage of an OpenAI or Anthropic
response.

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
- `format: "json"` also returns `pack`: the same pack as typed sections (`context-pack.v0`: `preamble`, `sections` with a stable `name`, a `layer` and their `lines`, `variables` and the `stamp`), for programs that build their own prompt. `convo.context({ format: "json" })` works the same way.

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

#### The provider's prompt cache

The agent's turn also carries the usage the provider reported for the call: every input token (`usage.prompt_tokens`), the ones read from its prompt cache (`usage.prompt_tokens_details.cached_tokens`) and, through gateways that pass Anthropic's fields along, the ones written to it. A stream reports usage only when you ask for it with `stream_options: { include_usage: true }`; the wrapper never changes your request to get it. Niadra sums the usage per agent, vendor and model, and the Console shows the cache's hit rate and the estimated savings next to the rest of the space's usage.

Without `wrap()`, pass the provider's response with the turn. An OpenAI response and an Anthropic one are both understood (Anthropic's `usage.input_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens`):

```ts
const message = await anthropic.messages.create({ model: "claude-sonnet-4-5", max_tokens: 1024, system, messages });
convo.agent(textOf(message), { usage: message });

// or build it yourself
convo.agent(reply, { usage: { provider: "openai", model: "gpt-4.1", prompt_tokens: 3000, cached_tokens: 2048 } });
```

`modelUsage(response)` reads one yourself. A response without usage is left out, and the turn is recorded either way.

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

Queued items leave in batches when 15 are waiting or a second after the first one, whichever comes first. A message with a `conversation_id` is a turn the other agents read in `live`, so it leaves within 200 ms (`queue.turnFlushIntervalMs`), taking whatever else is waiting along.

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

`filters.when` takes the period in the customer's own words, in Portuguese, English or Spanish (`"semana passada"`, `"last week"`, `"en marzo"`); the answer says in `window` how the server read it, and lists in `ignored` a filter it could not read. Items whose validity ended (an event recorded with `valid_until`, such as an offer valid until Friday) leave reads unless you pass `show_expired: true`. An opened item carries its `versions`, oldest first.

The handle, the search and the conversation id go in request bodies, never in a URL: a conversation id may be a phone number or an e-mail. `open()` sends `POST /v1/history/open`, and the tool kit adds the bound customer to it, so the server opens only that customer's items.

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

Media never travels inside an event. `uploadMedia()` takes a `Uint8Array`, `ArrayBuffer` or `Blob`, reserves an upload, sends the bytes straight to storage over a signed URL (HTTPS only, with exactly the headers the signature covers and nothing else, so never your key or default headers; storage checks the body against the declared size and digest), and resolves with the reference and digest for the event. With `subject`, the file is stored under that person, so erasing them erases it even if no event ever references it. Hashing uses Web Crypto.

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

The definitions use the `{ type: "function", function: { name, description, parameters } }` shape. For APIs that expect `{ name, description, input_schema }`, map `function.parameters` to `input_schema`. They are, word for word, the definitions the server publishes (`GET /v1/history/tools`) and the Python SDK ships, so a model sees one toolset whatever language the agent is written in; a test checks it byte for byte. The kit still reads the flat filter fields the 0.1 definitions offered.

### The agent's own memory

Besides the customer's memory, an agent can keep working notes about its job: a procedure that worked, how a tool or a process of the company behaves, a pitfall to avoid. Never anything about a customer: the server refuses a note with personal data (422 `personal_data_in_agent_memory`) instead of masking it. The space turns it on; reading needs the `agent_memory` (or `context`) scope and writing `agent_memory:write`.

```ts
const notes = await convo.agentMemory({ max_tokens: 300 });   // or niadra.agentMemory({ view, tags })
const system = [instructions, notes.text, ctx.text].filter(Boolean).join("\n\n");

const kit = convo.tools({ agentMemory: true, writeAgentMemory: true }); // + search_agent_memory and remember
await niadra.remember({ kind: "tool_note", title: "Dates need a time zone", body: "The scheduling API refuses dates without one.", tags: ["scheduling"] });
const { data: found } = await niadra.searchAgentMemory("credit on an invoice", { tags: ["erp"] });
```

The block goes after your instructions and before the customer's context: it is the same for every customer, so it stays in the cacheable prefix. It is served from an ETag cache like the context, and is empty (never an error) when the space has it off. `remember()` waits for the server and resolves with the note, or with a `proposal_id` when the space wants a person to approve notes; through the `remember` tool, a refusal for personal data reaches the model as a request to rewrite the note. Every integration takes `agentMemory: true` (or `{ write: true, max_tokens, tags }`) to do all of this for you.

### Subject tokens for MCP

`subjectToken()` mints a signed token, valid for 15 minutes, that binds one customer, conversation and verification level. Call it from your backend and pass the token to the MCP connection; tools served over MCP then read that customer only.

```ts
const { data } = await niadra.subjectToken({ subject: marina, conversation_id: "wa-8812", verification: "V1" });
```

## Integrations

Each integration is a subpath of this package, with its framework as an optional peer dependency: `@niadra/sdk` itself loads no framework, and you install only the one you use. Every adapter wires the same five things into the framework's own lifecycle:

1. **Context before the model call**: the pack after your instructions, the suffix (deltas and live turns) at the end, within the read budget (150 ms on voice).
2. **Turns**: what the customer said and what the agent answered, with the provider's usage when the framework exposes it, and the end of the conversation.
3. **Tools**: `search_customer_history`, `get_customer_timeline` and `open_history_item` in the framework's tool format, bound to the customer outside the model's reach. No tool has a parameter that names a customer.
4. **Verification**: what the framework or the carrier proved, recorded with `verify()` before the first context read.
5. **Handoff**: a transfer to another agent or to a person, recorded with `handoff()`.

All of it is fail-open: when Niadra is slow or down, the agent answers without memory, and nothing throws into the framework. Runnable examples are in [`examples/`](examples).

| Import | For | Tested with |
| --- | --- | --- |
| `@niadra/sdk/livekit` | LiveKit Agents (Node) | `@livekit/agents` 1.9.0 |
| `@niadra/sdk/elevenlabs` | ElevenLabs Agents Platform (webhooks and server tools) | recorded payloads; signatures checked against `@elevenlabs/elevenlabs-js` 2.69.0 |
| `@niadra/sdk/vapi` | Vapi (server URL) | recorded payloads typed with `@vapi-ai/server-sdk` 2.0.1 |
| `@niadra/sdk/whatsapp` | WhatsApp Cloud API (Meta webhooks) | recorded payloads, signatures computed in the test |
| `@niadra/sdk/twilio` | Twilio Voice, Messaging and Conversations webhooks | recorded payloads; signatures checked against `twilio` 6.1.1 |
| `@niadra/sdk/ai-sdk` | Vercel AI SDK 5, 6 and 7 | `ai` 7.0.114 with its mock models (v4 and v3 specifications) |
| `@niadra/sdk/mastra` | Mastra | `@mastra/core` 1.71.0, a real `Agent` over a mock model |
| `@niadra/sdk/langchain` | LangChain.js and LangGraph.js | `@langchain/core` 1.2.12, `@langchain/langgraph` 1.4.17, a real graph with `ToolNode` |
| `@niadra/sdk/openai-agents` | OpenAI Agents SDK (JavaScript) | `@openai/agents` 0.18.0, a real `Runner` over a scripted model |
| `@niadra/sdk/anthropic` | Anthropic SDK (`messages.create`, streaming or not) | `@anthropic-ai/sdk` 0.128.0 over recorded API answers |
| `@niadra/sdk/google-genai` | Google Gen AI SDK (`generateContent`, `generateContentStream`) | `@google/genai` 2.24.0 over recorded API answers |
| `@niadra/sdk/bedrock` | Amazon Bedrock Converse (`ConverseCommand`, `ConverseStreamCommand`) | `@aws-sdk/client-bedrock-runtime` 3.1140.0 with a recorded service answer |
| `@niadra/sdk/retell` | Retell AI (inbound and agent webhooks, custom functions, custom LLM websocket) | recorded payloads; signatures made by `retell-sdk` 6.0.1 and tool configurations typed with it |
| `@niadra/sdk/llamaindex` | LlamaIndex.TS (agents, multi-agent workflows, chat engines) | `@llamaindex/core` 0.6.23 and `@llamaindex/workflow` 1.1.25, real agents over a scripted LLM |
| `@niadra/sdk/genkit` | Genkit (Firebase Genkit for JavaScript) | `genkit` 1.42.0 with its own mock model, tool loop included |
| `@niadra/sdk/voltagent` | VoltAgent | `@voltagent/core` 2.10.0 on AI SDK 6.0.291 (its peer range), a real `Agent` over a mock model |
| `@niadra/sdk/google-adk` | Agent Development Kit for TypeScript (Google ADK) | `@google/adk` 2.1.0, a real `InMemoryRunner` with sub-agents over a scripted model |
| `@niadra/sdk/strands` | Strands Agents for TypeScript (AWS), Node 22+ | `@strands-agents/sdk` 1.19.0, a real `Agent` through its AI SDK model adapter |
| `@niadra/sdk/cloudflare-agents` | Cloudflare Agents SDK (`Agent`, `AIChatAgent`, voice agents, the Workers AI binding) | `agents` 0.24.0 types; run inside workerd by `pnpm runtimes` |

Pipecat has no subpath here: its pipeline, where the model call happens, runs in Python (the Python SDK has `niadra[pipecat]`), and its JavaScript packages are browser clients and transports, where a Niadra key must never go. Daily's JavaScript SDK is a browser call client too. LangGraph.js is covered by `@niadra/sdk/langchain`: `withNiadraContext()` inside the model node gives the context without writing it into the graph's checkpointed state.

Two more live in [`packages/`](packages), each with its own `package.json`, tests and README, apart from `@niadra/sdk`: [`n8n-nodes-niadra`](packages/n8n-nodes-niadra) (an n8n community node: Get Context, Track Turn, Search History, Verify, Handoff, End) and [`flowise-nodes-niadra`](packages/flowise-nodes-niadra) (a Flowise memory node that puts the context before every model call and records the turns, and a tool node with the kit).

### LiveKit Agents

```ts
import { NiadraAgent, NiadraMemory, attestationProof, sipConversationId, sipSubject } from "@niadra/sdk/livekit";

const caller = await ctx.waitForParticipant();
const conversation = niadra.conversation({
  subject: sipSubject(caller),                                   // sip.phoneNumber, else the identity
  channel: "voice",
  conversation_id: sipConversationId(caller, ctx.room.name),     // sip.callID, else the room
});
const memory = new NiadraMemory({ conversation, verify: attestationProof(caller.attributes["sip.h.x-stir-verstat"]) });
memory.attach(session);                                          // answers, handoffs, end of call
await session.start({ agent: new NiadraAgent({ instructions, memory }), room: ctx.room });
```

`NiadraAgent` is a LiveKit `Agent` whose `onUserTurnCompleted` records the final transcript (with its STT confidence), then puts the pack in the turn's chat context right after the instructions and the suffix after the new message. LiveKit builds that context for one reply only, so nothing piles up in the agent's history and the prompt prefix stays the same turn after turn. The navigation kit joins the agent's own tools as the `niadra` toolset. With your own `Agent` subclass, call `memory.onUserTurnCompleted(turnCtx, newMessage)` from your hook and add `memory.toolset()` to its tools.

`attach(session)` records the agent's answers from `conversation_item_added` (with the LLM usage LiveKit measured), a handoff for each `AgentHandoffItem` (`session.updateAgent()` or a tool that returns another agent), and the end of the conversation on `close`. Call `memory.handoffToHuman(reason)` right before a SIP transfer to a person. LiveKit's SIP attributes carry no STIR/SHAKEN attestation: map the carrier's header to a participant attribute in the trunk settings and pass it to `attestationProof()` (`A` proves V2, `B` and `C` prove V1).

### ElevenLabs Agents Platform

For calls that reach ElevenLabs by phone, the integration lives on your server, in three webhooks. No ElevenLabs package is needed, and the handlers run on Node, Deno, Bun, Workers and the Edge Runtime.

```ts
import { elevenLabs } from "@niadra/sdk/elevenlabs";

const handlers = elevenLabs({ niadra, secret: process.env.NIADRA_ELEVENLABS_SECRET, webhookSecret: process.env.ELEVENLABS_WEBHOOK_SECRET });
const respond = (c, { status, body }) => c.json(body, status);   // Hono here; any framework works

app.post("/elevenlabs/initiation", async (c) => respond(c, await handlers.initiation(await c.req.json(), c.req.raw.headers)));
app.post("/elevenlabs/tools", async (c) => respond(c, await handlers.tool(await c.req.json(), c.req.raw.headers)));
app.post("/elevenlabs/post-call", async (c) => respond(c, await handlers.postCall(await c.req.text(), c.req.raw.headers)));
```

- `initiation` answers the conversation initiation webhook: it opens the conversation by ElevenLabs' `conversation_id`, records what the call proved (`verify: (call) => attestationProof(...)`), reads the voice context and returns it as the dynamic variables `niadra_context` and `niadra_turn`. Put `{{niadra_context}}` in the agent's system prompt. When Niadra is slow or down, the call goes on with empty variables.
- `tool` serves the navigation kit as server tools. `handlers.toolConfigs({ url, secretId })` writes their configuration with the same descriptions as every other SDK; the conversation id and the caller come from ElevenLabs' system variables (`system__conversation_id`, `system__caller_id`), which the model never fills. The caller and level the initiation webhook saw are kept in a `CallStore`, in memory by default; pass one backed by your key-value store on serverless.
- `postCall` checks `ElevenLabs-Signature` (HMAC-SHA256 over `timestamp.body`, 30-minute window), records every turn of the transcript with its time in the call and the LLM usage ElevenLabs reports, records `transfer_to_agent` and `transfer_to_number` as handoffs, and ends the conversation.

The initiation and tool endpoints return customer context, so both require `secret` in the `x-niadra-secret` header: keep it as an ElevenLabs workspace secret and reference it in the webhook's and the tools' request headers. The full server is in [`examples/elevenlabs-hono.ts`](examples/elevenlabs-hono.ts).

### Vapi

One handler for the assistant's server URL takes every server message and answers the ones that matter. It checks the server secret (`x-vapi-secret`, or `Authorization: Bearer`).

```ts
import { vapi, vapiTools } from "@niadra/sdk/vapi";

const handle = vapi({ niadra, secret: process.env.VAPI_SERVER_SECRET, assistant: "YOUR_ASSISTANT_ID" });
app.post("/vapi", async (c) => {
  const { status, body } = await handle(await c.req.json(), c.req.raw.headers);
  return c.json(body, status);
});
```

- `assistant-request` opens the conversation by Vapi's call id with the customer's number as the subject, records what the call proved (`verify`), reads the voice context and answers with your assistant: a saved one gets the context in its variables (`{{niadra_context}}`, `{{niadra_turn}}`); a transient one also gets the pack as a system message right after its own. `assistant` can be a function of the call and its context.
- `tool-calls` runs the navigation kit for the caller of that call. Add the tools to the assistant with `vapiTools({ url, secret })`, which carries the SDK's descriptions; tool calls that are not Niadra's go to `otherTool(name, args, call)`.
- `transfer-destination-request` and `transfer-update` record the transfer to a person, once per call, and answer with your `transfer(call)` destination.
- `end-of-call-report` records every spoken turn with its time and ends the conversation.

The full server is in [`examples/vapi-hono.ts`](examples/vapi-hono.ts).

### Retell AI

The same design as ElevenLabs and Vapi, on your server. Every request is checked against `X-Retell-Signature` (HMAC-SHA256 of the raw body and its timestamp, keyed with the Retell API key that signs webhooks, five-minute window), so the handlers take the raw body.

```ts
import { retell } from "@niadra/sdk/retell";

const handlers = retell({ niadra, apiKey: process.env.RETELL_API_KEY });
const respond = (c, { status, body }) => c.json(body, status);

app.post("/retell/inbound", async (c) => respond(c, await handlers.inbound(await c.req.text(), c.req.raw.headers)));
app.post("/retell/webhook", async (c) => respond(c, await handlers.webhook(await c.req.text(), c.req.raw.headers)));
app.post("/retell/tools", async (c) => respond(c, await handlers.tool(await c.req.text(), c.req.raw.headers)));
```

- `inbound` answers the phone number's inbound webhook: it opens the conversation by `call_inbound.call_id`, records what the call proved (`verify`), reads the voice context and returns it as the dynamic variables `niadra_context` and `niadra_turn` (plus your `inboundFields(call)`, such as `override_agent_id`). Put `{{niadra_context}}` in the agent's prompt.
- `tool` serves the navigation kit as custom functions; `handlers.toolConfigs({ url })` writes them for the LLM's `general_tools`. The customer comes from the call Retell sends with each function call, never from the arguments; other functions go to `otherTool(name, args, call)`.
- `webhook` takes the agent webhook: `call_started` keeps the customer of outbound and web calls (the callee on outbound calls), `transfer_started` records the transfer to a person once, and `call_ended` records every utterance of `transcript_object` with its time in the call and ends the conversation.
- `llm(callId, { send, instructions })` serves a custom LLM websocket: `open()` asks for the call details (and speaks your greeting), `receive(event)` answers pings, records the utterances once a response is required and resolves to a turn whose `messages` carry your instructions, the pack and the call so far with the suffix at the end; `turn.respond(text)` sends the response (streamed with `{ complete: false }`, with `endCall` or `transferNumber`). Utterances carry the same idempotency key on the websocket and in `call_ended`, so recording both ways stores them once.

### WhatsApp Cloud API

Translation only: it never sends a message.

```ts
import { readWhatsApp, recordInbound, recordOutbound, whatsAppChallenge } from "@niadra/sdk/whatsapp";

app.get("/whatsapp", (c) => c.text(whatsAppChallenge(new URL(c.req.url).searchParams, VERIFY_TOKEN).body));
app.post("/whatsapp", async (c) => {
  const { status, messages } = await readWhatsApp(await c.req.text(), c.req.raw.headers, { appSecret: META_APP_SECRET });
  for (const inbound of messages) {
    const convo = niadra.conversation({ subject: inbound.subject, channel: "whatsapp", conversation_id: threadIdFor(inbound) });
    recordInbound(convo, inbound);                        // keyed by the wamid: redeliveries are harmless
    const ctx = await convo.context();
    // ... answer with your model, send through the Graph API ...
    recordOutbound(convo, reply, await sendResponse.json()); // keyed by the wamid Meta returned
  }
  return c.body(null, status);
});
```

`readWhatsApp` checks `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with the app secret) and reads each message with the customer as `wa_id`, the profile name, the business number, the text (or caption, or the title of a button or list reply), the media reference and the message it replies to. For media, download it with the Graph API, pass it to `niadra.uploadMedia()` and hand the result to `recordInbound(convo, inbound, upload)`. See [`examples/whatsapp-cloud.ts`](examples/whatsapp-cloud.ts).

### Twilio

```ts
import { readTwilio, recordTwilioInbound, verifyTwilio } from "@niadra/sdk/twilio";

const { status, request } = await readTwilio(`${PUBLIC_URL}/twilio/voice`, await c.req.text(), c.req.raw.headers, { authToken });
const convo = niadra.conversation({ subject: request.subject, channel: request.channel, conversation_id: request.conversationId });
await verifyTwilio(convo, request);   // StirVerstat: TN-Validation-Passed-A proves V2, B and C prove V1
recordTwilioInbound(convo, request);  // Body, or SpeechResult with its Confidence
```

`readTwilio` checks `X-Twilio-Signature` against the exact public URL Twilio called and reads the request: WhatsApp by `WaId`, voice and SMS by the number on the customer's side (`To` on outbound calls), Conversations by `Author`; `CallSid` or `ConversationSid` as the conversation id; `MessageSid` as the idempotency key. Record the attestation once, on the call's first webhook, and open later ones at `request.proof.level`, as [`examples/twilio-voice.ts`](examples/twilio-voice.ts) does.

### Vercel AI SDK

A language model middleware, so it works with every provider, and the navigation kit as AI SDK tools:

```ts
import { streamText, wrapLanguageModel } from "ai";
import { niadraMiddleware, niadraTools } from "@niadra/sdk/ai-sdk";

const convo = niadra.conversation({ subject: handles.appUserId(session.userId), channel: "web_chat", conversation_id: chatId });
const result = streamText({
  model: wrapLanguageModel({ model: openai("gpt-4.1"), middleware: niadraMiddleware(convo, { verify: { method: "login", level: "V2" } }) }),
  system: "You are Acme's support agent.",
  messages,
  tools: { ...niadraTools(convo), ...yourTools },
});
```

On every model call, `transformParams` records the newest user message as the customer's turn (once, however many steps a tool loop takes), puts the pack as a system message right after your system prompt, and adds the suffix as a text part at the end of the last user message, where every provider accepts it. `wrapGenerate` and `wrapStream` record the model's text as the agent's turn with the usage the provider reported, including prompt cache reads and writes; steps that only call tools record nothing. Pass a function instead of a conversation to wrap the model once and pick the conversation per call. The same middleware works with AI SDK 5, 6 and 7. See [`examples/ai-sdk.ts`](examples/ai-sdk.ts).

### Mastra

A processor that goes in both of the agent's processor lists, and the navigation kit as Mastra tools. Mastra's own `Memory` stays as it is; Niadra is the customer's memory shared with the company's other agents.

```ts
import { niadraProcessor, niadraTools } from "@niadra/sdk/mastra";

const niadraContext = niadraProcessor();
const support = new Agent({
  id: "support", name: "Acme support", model: openai("gpt-4.1"),
  instructions: "You are Acme's support agent.",
  tools: ({ requestContext }) => niadraTools(requestContext.get("niadra")),
  inputProcessors: [niadraContext],
  outputProcessors: [niadraContext],
});

await support.generate(text, { requestContext: new RequestContext([["niadra", convo]]) });
```

`processLLMRequest` rewrites only the prompt sent to the model, not the message list, so the pack and the suffix never land in Mastra's memory: the pack goes after the system messages, the suffix at the end of the last user message, and the customer's newest message is recorded once per turn. `processOutputResult` records the final answer with the usage Mastra summed for the run. The conversation comes from the request context under `niadra` (or pass `niadraProcessor({ session })`). For an agent that cannot take processors, `niadraInstructions(base)` returns dynamic instructions with the context, without recording turns. See [`examples/mastra.ts`](examples/mastra.ts).

### LangChain.js and LangGraph.js

```ts
import { NiadraCallbackHandler, niadraContext, niadraTools, withNiadraContext } from "@niadra/sdk/langchain";

// LCEL: a runnable before the model
const chain = niadraContext(convo).pipe(model);
await chain.invoke(messages, { callbacks: [new NiadraCallbackHandler(convo)] });

// LangGraph: inside the model node, so the context never lands in the graph's state
const tools = niadraTools(convo);
graph.addNode("agent", async (state) => ({ messages: [await model.bindTools(tools).invoke(await withNiadraContext(convo, state.messages))] }));
graph.addNode("tools", new ToolNode(tools));
```

`niadraContext` and `withNiadraContext` record the newest human message once and return the messages with the pack as a system message after the leading ones and the suffix at the end of the last human message. `NiadraCallbackHandler` records each answer with the usage LangChain standardizes in `usage_metadata` (prompt cache reads and writes included); answers that only call tools record nothing. `niadraTools` returns `DynamicStructuredTool`s bound to the customer. See [`examples/langgraph.ts`](examples/langgraph.ts).

### OpenAI Agents SDK

```ts
import { NiadraSession, niadraInstructions, niadraRunHooks, niadraTools } from "@niadra/sdk/openai-agents";

const agent = new Agent({
  name: "Support",
  instructions: niadraInstructions("You are Acme's support agent.", convo),
  tools: niadraTools(convo),
});
niadraRunHooks(runner, convo);                                  // handoffs between agents
await runner.run(agent, text, { session: new NiadraSession(convo) });
```

`niadraInstructions` makes the instructions dynamic: your text, then the pack, then the suffix (the SDK builds the system prompt from the instructions alone). `NiadraSession` is a `Session` that keeps the run's items in another session (`MemorySession` by default, or yours as `inner`) and records the customer's messages and the agent's answers. `niadraTools` returns non-strict function tools bound to the customer, since the canonical schemas have optional fields. `niadraRunHooks` records each `agent_handoff`. See [`examples/openai-agents.ts`](examples/openai-agents.ts).

### LlamaIndex.TS

```ts
import { agent } from "@llamaindex/workflow";
import { NiadraMemory, niadraTools } from "@niadra/sdk/llamaindex";

const support = agent({ llm, systemPrompt: "You are Acme's support agent.", tools: niadraTools(convo), memory: new NiadraMemory(convo) });
await support.run(text);
```

`NiadraMemory` is a LlamaIndex `Memory` (it takes the same messages and options as `createMemory()`), so it serves agents, multi-agent workflows and chat engines alike. In `getLLM()`, which every model call goes through, it records the customer's newest message once and returns a copy of the messages with the pack after the leading system messages and the suffix at the end of the last user message; the stored history keeps only what was said. `add()` records the final answer and a `handOff` between agents. For a memory you build yourself, `NiadraMemoryBlock` gives the same context as a fixed block (priority 0). `niadraTools` returns `FunctionTool`s with the canonical JSON Schemas.

### Genkit

```ts
import { niadraMiddleware, niadraTools } from "@niadra/sdk/genkit";

const { text } = await ai.generate({
  model: googleAI.model("gemini-2.5-flash"),
  system: "You are Acme's support agent.",
  prompt: text,
  tools: niadraTools(convo),
  use: [niadraMiddleware(convo, { model: "googleai/gemini-2.5-flash" })],
});
```

The middleware runs around every model call of the request, tool loop included: the pack joins your system message as a text part (several providers read only one system message), the suffix joins the last user message, the customer's newest message is recorded once and the answer with Genkit's usage (`inputTokens`, `cachedContentTokens`) when you name the model, which a model middleware does not see. The tools are unregistered Genkit tools, so each request carries the ones bound to its own customer.

### VoltAgent

```ts
import { niadraHooks, niadraTools } from "@niadra/sdk/voltagent";

const support = new Agent({ name: "support", instructions: "You are Acme's support agent.", model: openai("gpt-4.1"), hooks: niadraHooks() });
await support.generateText(text, { context: { niadra: convo }, tools: niadraTools(convo) });
```

`onPrepareModelMessages` puts the pack after your instructions and the suffix at the end of the last user message only in what goes to the model, so VoltAgent's own memory keeps what was said; `onEnd` records the answer with the operation's usage; `onHandoff` records delegations to sub-agents when the hooks are built for one conversation. The conversation comes from the operation context under `niadra`. VoltAgent 2.x runs on AI SDK 6.

### Google ADK

```ts
import { niadraAdk } from "@niadra/sdk/google-adk";

const memory = niadraAdk({
  session: (context) => niadra.conversation({ subject: handles.appUserId(context.userId), channel: "web_chat", conversation_id: context.sessionId }),
});
const support = new LlmAgent({ name: "support", model: "gemini-2.5-flash", instruction: "You are Acme's support agent.", ...memory });
```

One agent definition serves every ADK session: `session` is called once per ADK session id. `beforeModelCallback` records the user's message of each invocation once and adds the pack after your instruction in `systemInstruction` and the suffix to the last user content; ADK rebuilds the request from the session's events on every call, so nothing lands in the session. `afterModelCallback` records the final answer with `usageMetadata` and `transfer_to_agent` as a handoff. The tools declare the canonical JSON Schemas (`parametersJsonSchema`) and find the customer from the tool's context. Give the same `...memory` to sub-agents.

### Strands Agents

```ts
import { NiadraPlugin } from "@niadra/sdk/strands";

const support = new Agent({ model, systemPrompt: "You are Acme's support agent.", plugins: [new NiadraPlugin(convo)] });
await support.invoke(text);
```

A Strands plugin: an input middleware of `InvokeModelStage` adds the pack after your system prompt and folds the suffix into the last user message (keeping the cache point before it, as Strands' own context injector does) without touching `agent.messages`; an output middleware records the answer with the model's usage (Bedrock and Anthropic count cached tokens apart, the others inside); `getTools()` adds the kit. Strands for TypeScript needs Node 22 or later.

### Cloudflare Agents SDK

```ts
import { niadraAgent } from "@niadra/sdk/cloudflare-agents";

export class Support extends AIChatAgent<Env> {
  async onChatMessage() {
    niadra ??= new Niadra({ apiKey: this.env.NIADRA_API_KEY });
    const memory = niadraAgent(this, { niadra, subject: handles.appUserId(this.name) });
    const result = streamText({
      model: wrapLanguageModel({ model: workersAI("@cf/openai/gpt-oss-120b"), middleware: memory.middleware }),
      system: "You are Acme's support agent.",
      messages: await convertToModelMessages(this.messages),
      tools: { ...memory.tools(), ...yourTools },
    });
    return result.toUIMessageStreamResponse();
  }
}
```

`niadraAgent(this, ...)` returns one helper per agent instance (a Durable Object), bound to a conversation whose id is the agent's name unless you give another. `middleware` is the AI SDK middleware with one addition: after each answer it hands the queued writes to `ctx.waitUntil()`. For a model called without the AI SDK (the Workers AI binding, a voice agent's `onTurn()`), `prepare(messages)` returns the messages with the context in place and `record(text, { usage: workersAiUsage(answer, model) })` records the answer. Only web APIs and the AI SDK: `pnpm runtimes` bundles it and runs it inside workerd.

### Anthropic, Google Gen AI and Amazon Bedrock

The same idea as `wrap()` for OpenAI, one wrapper per SDK. The client itself is never modified.

```ts
import { wrapAnthropic } from "@niadra/sdk/anthropic";
import { wrapGoogleGenAI } from "@niadra/sdk/google-genai";
import { wrapBedrock } from "@niadra/sdk/bedrock";

const claude = wrapAnthropic(new Anthropic(), convo);          // messages.create, streaming or not
const gemini = wrapGoogleGenAI(new GoogleGenAI({}), convo);    // models.generateContent and generateContentStream
const bedrock = wrapBedrock(new BedrockRuntimeClient({}), convo); // ConverseCommand and ConverseStreamCommand
```

Each call gets the pack after your system text (Anthropic's `system`, Gemini's `config.systemInstruction`, one more Converse `system` block) and the suffix at the end of the last user message; the newest user text is recorded as the customer's turn and the answer as the agent's, with the provider's usage and prompt cache counts: Anthropic's `input_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens`, Gemini's `promptTokenCount` and `cachedContentTokenCount`, Bedrock's `inputTokens`, `cacheReadInputTokens` and `cacheWriteInputTokens`. On Anthropic, the pack's system block gets a cache breakpoint only when you already use prompt caching and one of the four is left. `.withResponse()` keeps working. For Anthropic's `messages.stream()` helper, prepare the body with `anthropicParams(convo, body)` and pass the final message to `recordAnthropic(convo, message)`. Azure OpenAI needs nothing new: `AzureOpenAI` has the OpenAI client's shape, so `wrap()` covers it. See [`examples/anthropic.ts`](examples/anthropic.ts), [`examples/google-genai.ts`](examples/google-genai.ts) and [`examples/bedrock.ts`](examples/bedrock.ts).

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

Every call you wait for has its own time budget for the whole call, retries and waits included, independent of your platform's:

| Call | Default |
| --- | --- |
| `context()` | 300 ms, 150 ms with `view: "voice"` |
| `search()`, `timeline()`, `open()`, `objectState()`, `objectTimeline()` | 600 ms, 300 ms through voice conversations and voice-bound tools |
| `subjectToken()` | 2 s |
| `identify()`, `verify()`, `handoff()`, `feedback()` and the reservation in `uploadMedia()` | 5 s |
| The transfer in `uploadMedia()` | 60 s |

An `identify()`, `verify()` or `handoff()` that runs out of time resolves with a `NiadraTimeoutError` and stays in the queue, which keeps sending it. `track()` never waits; each attempt of a background batch has 5 s. Override them with `timeouts`, or per call with `{ timeout }`. Pass `{ signal }` to cancel a call.

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

Create one client per process and share it: it owns the queue and the cache.

## Configuration

```ts
new Niadra({
  apiKey: "nia_sk_live_...",                 // default: NIADRA_API_KEY
  baseURL: "http://localhost:4010",          // default: NIADRA_BASE_URL, then derived from the key
  timeouts: { context: 300, contextVoice: 150, navigation: 600, navigationVoice: 300, write: 5000, token: 2000, upload: 60_000 },
  cache: { ttlMs: 10_000, staleWhileRevalidateMs: 600_000, maxStaleMs: 1_800_000, maxEntries: 1000 },
  queue: { flushAt: 15, flushIntervalMs: 1000, turnFlushIntervalMs: 200, maxBatchSize: 100, maxQueueSize: 10_000, maxAttempts: 3 },
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
pnpm check     # typecheck, lint, tests (the integrations with their frameworks' real types)
pnpm build     # ESM and CommonJS into dist/, one entry per integration
pnpm runtimes  # the build on Deno, Bun, workerd and the Edge Runtime
pnpm --filter "./packages/*" check   # the n8n and Flowise nodes
```

VoltAgent 2.x runs on AI SDK 6 while every other test runs on AI SDK 7; `.pnpmfile.cjs` gives VoltAgent its own copy at install. The Strands tests run on Node 22 and later and skip on Node 20.

## Documentation in Portuguese

The documentation is also available in Portuguese at [docs.niadra.com](https://docs.niadra.com),
and the contact page in Portuguese at [niadra.com/enterprise](https://niadra.com/enterprise).

## License

Apache 2.0. See [LICENSE](./LICENSE).
