// The agent's working state: a small state its code keeps between turns, written by code, never by a
// model. Two sub-agents of one conversation write different fields with `merge_by_key` and never lose each
// other's writes. A read after a write serves at least what was written. With Niadra down, the write
// applies to the local copy at once and leaves later.
//   NIADRA_API_KEY=...   (the space's `agent_state` feature)
import type { Conversation } from "@niadra/sdk";

/** The offer sub-agent's field. */
export async function rememberOffer(conversation: Conversation, status: string): Promise<Record<string, unknown>> {
  await conversation.agentState.put({ offer: { status } }, { mode: "merge_by_key" });
  return (await conversation.agentState.get()).body;
}

/** The delivery sub-agent's field, written without reading the offer first. */
export async function rememberAddress(conversation: Conversation, city: string): Promise<Record<string, unknown>> {
  await conversation.agentState.put({ delivery: { city } }, { mode: "merge_by_key" });
  return (await conversation.agentState.get()).body;
}
