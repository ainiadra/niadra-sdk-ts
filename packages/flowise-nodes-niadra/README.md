# Niadra nodes for Flowise

Two [Flowise](https://flowiseai.com) nodes for [Niadra](https://niadra.com/en), the shared customer memory for every AI agent in a company:

- **Niadra Customer Memory** (Memory): connect it to an agent's Memory input (Tool Agent, Conversational Agent). Before every model call it hands the agent the customer's context as a system message right after the agent's system prompt, followed by the chat's own messages (from the memory you connect as **Chat History**, or the last 100 kept in the process). What the agent adds is recorded as the customer's and the agent's turns.
- **Niadra Customer History** (Tools): connect it to an agent's Tools input. It gives the model `search_customer_history`, `get_customer_timeline` and `open_history_item` (and `search_agent_memory` with **Agent Memory** on), bound to the chat's customer. No tool has a parameter that names a customer.

Both take the customer's handle (bind it to a variable or the override config, never to text the model writes), the channel, the verification level the chat proved, and the API key (or the `NIADRA_API_KEY` environment variable). The Flowise chat session is the Niadra conversation. When Niadra is slow or down, the agent gets the chat's messages alone.

## Install

Flowise loads nodes from its components package. Build and copy:

```sh
pnpm build                                   # dist/NiadraMemory.js, dist/NiadraTools.js, the icon
cp dist/*.js dist/niadra.svg <flowise>/packages/components/dist/nodes/niadra/
cd <flowise>/packages/components && pnpm add @niadra/sdk
```

Restart Flowise; the nodes appear under Memory and Tools. Tested with `@langchain/core` 1.2 through the same prompt the Tool Agent builds.

## License

Apache 2.0. The node interface types and the memory node's layout come from Flowise (Apache 2.0); see [NOTICE](NOTICE).
