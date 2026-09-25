import { MockServer, batchOk, contextBody, makeClient, marina } from "../helpers.js";
import type { Niadra } from "../../src/index.js";

export { MockServer, batchOk, contextBody, makeClient, marina };

export const PACK = "<context>Marina · customer since 2021</context>";
export const LIVE = [
  { at: "2026-09-22T17:07:02Z", channel: "whatsapp", kind: "message" as const, speaker: "customer", text: "sent the photo", source_id: "s" },
];
export const SUFFIX = '<live_turns source="niadra">\n[2026-09-22T17:07:02Z] whatsapp · customer: sent the photo\n</live_turns>';

export const SEARCH = {
  items: [{ id: "ep_1", kind: "episode", at: "2026-09-01T10:00:00Z", channel: "voice", summary: "Asked for a refund" }],
  withheld: 0,
  tokens_used: 40,
};

/** A mock Niadra with the routes every adapter touches, and a client pointed at it. */
export function setup(options: { live?: boolean } = {}): { server: MockServer; niadra: Niadra } {
  const server = new MockServer()
    .on("POST /v1/context", { body: contextBody(options.live === false ? {} : { live: LIVE }) })
    .on("POST /v1/batch", batchOk())
    .on("POST /v1/history/search", { body: SEARCH });
  const niadra = makeClient(server, { cache: false, flushOnExit: false });
  return { server, niadra };
}

/** Every item sent in `/v1/batch`, in order. */
export function sent(server: MockServer): any[] {
  return server.callsTo("POST /v1/batch").flatMap((call) => call.body.items as unknown[]);
}

export function turns(server: MockServer): { role: string; text: string; item: any }[] {
  return sent(server)
    .filter((item) => item.type === "event" && item.kind === "message")
    .map((item) => ({
      role: item.speaker.role,
      text: item.content?.text ?? item.content?.transcript,
      item,
    }));
}

/** The order of the requests, as `METHOD /path` or the batch item types. */
export function sequence(server: MockServer): string[] {
  return server.calls.flatMap((call) =>
    call.path === "/v1/batch"
      ? (call.body.items as { type: string }[]).map((item) => `batch:${item.type}`)
      : [`${call.method} ${call.path}`],
  );
}
