# n8n-nodes-niadra

An [n8n](https://n8n.io) community node for [Niadra](https://niadra.com/en), the shared customer memory for every AI agent in a company. Put it before and after your AI Agent node (or give it to the agent as a tool) so the agent starts every conversation knowing what the customer already told your other agents, and so what it says reaches them too.

## Operations

| Operation | What it does |
| --- | --- |
| Get Context | The customer's context for the agent's prompt: `text` (after your system message) and `suffix` (the live turns from other channels, for the end of the prompt) |
| Track Turn | Records what the customer or the agent said, keyed by the provider's message id so a retried step is recorded once |
| Search History | Searches past conversations, promises, actions and business objects; `When` takes the period in the customer's words ("last week", "semana passada") |
| Verify | Records that the customer proved who they are (an OTP, a login, the carrier's attestation) |
| Handoff | Records a transfer to a person or to another agent |
| End | Records that the conversation ended |

Every operation fails open by default: when Niadra is slow or down, the node returns an empty result with an `error` field and the workflow goes on. Turn **Fail Open** off to stop the workflow instead.

Bind **Customer Handle** to your trigger's data (the WhatsApp `wa_id`, the caller's number, your user id), never to a value the model writes: the customer is never something the model chooses.

## Credential

**Niadra API**: a source key of your space (`nia_sk_...`). The key names the region and the space, so the address comes from it; set **Base URL** only for a local emulator.

## Install

In n8n, **Settings > Community Nodes > Install** and enter `n8n-nodes-niadra`. Built and tested against `n8n-workflow` 2.16.

## License

Apache 2.0. The layout of the node and its credential follows Mem0's n8n node (MIT); see [NOTICE](NOTICE).
