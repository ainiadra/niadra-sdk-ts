// Field access at a tool's output: a field the agent may not read never reaches its model. The type
// registry says, per field, who may read it (`access`). The SDK profile tells each key which fields of each
// type it may not read, and `maskOutput: true` removes the denied ones and masks the others in what the
// tool returns, before the model sees it. The turn records what the model got. When Niadra is down the
// last profile read keeps applying; with none ever read, `onUnknown: "block"` withholds the result instead.
//   NIADRA_API_KEY=...   (the space's `state` feature, a type whose fields declare `access`)
import type { Niadra } from "@niadra/sdk";

interface Proposal {
  proposal_id: string;
  price_full: number;
  health_declaration?: string;
}

/** The CRM read as the agent's tool, bound to this client's key and its SDK profile. */
export function proposalTool(niadra: Niadra): (proposalId: string) => Proposal {
  return niadra.tool("get_proposal", (proposalId: string): Proposal => ({ proposal_id: proposalId, price_full: 812.4, health_declaration: "(from the CRM)" }), {
    provenance: (p) => [{ ref: `proposal:crm:${p.proposal_id}`, fields: { price_full: p.price_full } }],
    maskOutput: true,
    onUnknown: "block",
  });
}
