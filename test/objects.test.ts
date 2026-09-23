import { describe, expect, it } from "vitest";
import { NiadraPermissionError, NiadraValidationError } from "../src/index.js";
import { KEY, MockServer, makeClient, problem } from "./helpers.js";

const state = {
  ref: { type: "invoice", namespace: "erp", id: "0823" },
  state: { status: "credited", amount: "40.00" },
  as_of: "2026-09-22T17:06:00Z",
  source_id: "erp",
  open_items: [],
};

describe("object reads", () => {
  it("reads an object's state from its path", async () => {
    const server = new MockServer().on("GET /v1/objects/invoice/erp/0823", { body: state });
    const { data, error } = await makeClient(server).objectState("invoice:erp:0823");
    expect(error).toBeNull();
    expect(data?.state).toEqual({ status: "credited", amount: "40.00" });
    expect(server.calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("pages an object's timeline and encodes each segment", async () => {
    const server = new MockServer().on("GET /v1/objects/ticket/zendesk%20eu/A%3A1%23/timeline", {
      body: { ref: { type: "ticket", namespace: "zendesk eu", id: "A:1#" }, items: [], next_cursor: "c2" },
    });
    const { data } = await makeClient(server).objectTimeline(
      { type: "ticket", namespace: "zendesk eu", id: "A:1#" },
      { cursor: "c1", limit: 5 },
    );
    expect(data?.next_cursor).toBe("c2");
    expect(Object.fromEntries(server.calls[0]!.url.searchParams)).toEqual({ cursor: "c1", limit: "5" });
  });

  it("rejects what the server's route cannot address, before sending", async () => {
    const server = new MockServer();
    const niadra = makeClient(server);
    expect((await niadra.objectState("invoice:erp:08/23")).error).toBeInstanceOf(NiadraValidationError);
    expect((await niadra.objectTimeline("invoice:erp:0823", { limit: 500 })).error).toBeInstanceOf(NiadraValidationError);
    expect(server.calls).toHaveLength(0);
  });

  it("fails open, and throws in strict mode", async () => {
    const server = new MockServer().on("GET /v1/objects/invoice/erp/0823", problem(403, "forbidden"));
    const lenient = await makeClient(server).objectState("invoice:erp:0823");
    expect(lenient.data).toBeNull();
    expect(lenient.error).toBeInstanceOf(NiadraPermissionError);
    await expect(makeClient(server, { strict: true }).objectState("invoice:erp:0823")).rejects.toBeInstanceOf(
      NiadraPermissionError,
    );
  });
});
