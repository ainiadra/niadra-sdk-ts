// Object state: before the agent states a value of an order, invoice or quote, it asks whether it may.
// Niadra answers from what the company's systems pushed, with each field's freshness. When the value is
// stale and the company registered a resolver for the type, the SDK reads it fresh from the company's own
// system, within the same budget; a stale value is never verified.
//   NIADRA_API_KEY=...   (the space's `state` feature, the type `health_quote` declared)
import type { Conversation, StateRef } from "@niadra/sdk";

export const QUOTE = "health_quote:op:q-77";
const QUOTES: Record<string, Record<string, unknown>> = { "q-77": { price_full: 499.9, plan: "ouro" } };

/** The company's own read of a quote, the fields asked: here a fixed table, in production its quoting system. */
export async function requote(ref: StateRef, fields?: readonly string[] | null): Promise<{ fields: Record<string, unknown>; version: number }> {
  const quote = QUOTES[ref.id] ?? {};
  return Promise.resolve({ fields: Object.fromEntries(Object.entries(quote).filter(([k]) => !fields || fields.includes(k))), version: 7 });
}

/** What the agent says about the quote's full price: the price only when it may be claimed now. */
export async function priceLine(conversation: Conversation, price: number): Promise<string> {
  const verdict = await conversation.verifyClaim(QUOTE, "price_full", price);
  if (verdict.claimSafe) return `O plano sai por R$ ${price.toFixed(2)}.`;
  if (typeof verdict.value === "number") return `O plano sai por R$ ${verdict.value.toFixed(2)}.`;
  return "Vou confirmar o valor atualizado e já te digo.";
}
