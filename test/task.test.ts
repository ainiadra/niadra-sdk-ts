import { describe, expect, it } from "vitest";
import { MockServer, batchOk, contextBody, makeClient, marina } from "./helpers.js";

describe("task()", () => {
  it("reads context for the task with the brief view by default", async () => {
    const server = new MockServer().on("POST /v1/context", { body: contextBody() });
    const task = makeClient(server).task({ task_id: "t-1", channel: "billing-agent", subject: marina, verification: "no_customer" });
    await task.context({ query: "august invoice" });
    expect(server.calls[0]!.body).toEqual({
      subject: marina,
      view: "brief",
      task_id: "t-1",
      verification: "no_customer",
      query: "august invoice",
    });
  });

  it("reads the object when the task has no person", async () => {
    const server = new MockServer().on("POST /v1/context", { body: contextBody() });
    await makeClient(server).task({ channel: "billing-agent", object: "invoice:erp:0823", view: "task:billing" }).context();
    expect(server.calls[0]!.body).toMatchObject({ object: { type: "invoice", namespace: "erp", id: "0823" }, view: "task:billing" });
  });

  it("centers on its object when it has one, and asks for deltas after the first pack", async () => {
    const server = new MockServer().on(
      "POST /v1/context",
      { body: contextBody() },
      { body: contextBody({ delta: "[New] payment received" }) },
    );
    const task = makeClient(server, { cache: false }).task({
      task_id: "t-1",
      channel: "billing-agent",
      subject: marina,
      object: "invoice:erp:0823",
      view: "task:billing",
    });
    await task.context();
    const second = await task.context();
    expect(server.calls[0]!.body.subject).toBeUndefined();
    expect(server.calls[0]!.body.object).toEqual({ type: "invoice", namespace: "erp", id: "0823" });
    expect(server.calls[1]!.body.delta).toBe(true);
    expect(second.suffix).toBe("[New] payment received");
  });

  it("stamps the agent's answers and actions, and raises the level after verify()", async () => {
    const server = new MockServer().on("POST /v1/context", { body: contextBody() }).on("POST /v1/batch", batchOk());
    const niadra = makeClient(server);
    const task = niadra.task({ task_id: "t-1", channel: "billing-agent", subject: marina });
    const ctx = await task.context();
    task.markInjected(ctx, new Date("2026-09-22T17:06:00Z"));
    task.agent("Credited R$ 40 on the August invoice");
    task.action({ operation: "credit" });
    expect((await task.verify({ method: "kba", level: "V1" })).ok).toBe(true);
    await task.context();
    await niadra.flush();
    const items = server.callsTo("POST /v1/batch").flatMap((call) => call.body.items);
    const stamp = { etag: "etag-1", injected_at: "2026-09-22T17:06:00.000Z" };
    expect(items[0]).toMatchObject({ speaker: { role: "ai_agent" }, task_id: "t-1", context_stamp: stamp });
    expect(items[1]).toMatchObject({ kind: "action", context_stamp: stamp });
    expect(items.find((item: any) => item.type === "verify")).toMatchObject({ task_id: "t-1", handle: marina });
    expect(server.callsTo("POST /v1/context")[1]!.body).toMatchObject({ verification: "V1" });
    expect(task.timings.firstAgentTurnAt).toBeInstanceOf(Date);
  });

  it("cannot verify a task that has no subject without a handle", async () => {
    const server = new MockServer();
    const task = makeClient(server).task({ channel: "billing-agent", object: "invoice:erp:0823" });
    const result = await task.verify({ method: "kba", level: "V1" });
    expect(result.ok).toBe(false);
    expect(server.calls).toHaveLength(0);
  });

  it("binds task id, subject and object to events", async () => {
    const server = new MockServer().on("POST /v1/batch", batchOk());
    const niadra = makeClient(server);
    const task = niadra.task({ task_id: "t-1", channel: "billing-agent", subject: marina, object: "invoice:erp:0823" });
    task.action({ operation: "credit", result: "R$ 40" });
    task.track({ speaker: "ai_agent", text: "Customer notified", channel: "email" });
    await niadra.flush();
    const [action, message] = server.calls[0]!.body.items;
    expect(action).toMatchObject({
      kind: "action",
      task_id: "t-1",
      channel: "billing-agent",
      handles: [marina],
      object_refs: [{ type: "invoice", namespace: "erp", id: "0823" }],
    });
    expect(message).toMatchObject({ channel: "email", task_id: "t-1" });
  });

  it("fails open on a malformed object instead of throwing", async () => {
    const server = new MockServer();
    const task = makeClient(server).task({ channel: "billing-agent", object: "not-a-ref" });
    expect((await task.context()).source).toBe("none");
    expect(task.track({ speaker: "system", kind: "system_event", canonical_type: "x.y" })).toBeNull();
    expect(task.tools()).toBeNull();
  });

  it("emits task.ended once", async () => {
    const server = new MockServer().on("POST /v1/batch", batchOk());
    const task = makeClient(server).task({ task_id: "t-1", channel: "billing-agent", subject: marina });
    await task.end();
    await task.end();
    const items = server.calls.flatMap((c) => c.body.items);
    expect(items).toEqual([expect.objectContaining({ type: "task.ended", task_id: "t-1" })]);
  });

  it("gives tools that follow the task's current level", async () => {
    const server = new MockServer()
      .on("POST /v1/history/search", { body: { items: [], withheld: 0, tokens_used: 0 } })
      .on("POST /v1/batch", batchOk());
    const task = makeClient(server).task({ task_id: "t-1", channel: "billing-agent", subject: marina });
    const kit = task.tools()!;
    await task.verify({ method: "kba", level: "V1" });
    await kit.call("search_customer_history", { query: "credit" });
    expect(server.callsTo("POST /v1/history/search")[0]!.body).toMatchObject({ verification: "V1", task_id: "t-1" });
  });

  it("binds its tools to the task", async () => {
    const server = new MockServer().on("POST /v1/history/search", { body: { items: [], withheld: 0, tokens_used: 0 } });
    const task = makeClient(server).task({ task_id: "t-1", channel: "billing-agent", subject: marina });
    await task.tools()!.call("search_customer_history", { query: "credit" });
    expect(server.calls[0]!.body).toMatchObject({ subject: marina, task_id: "t-1" });
  });
});
