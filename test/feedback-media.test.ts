import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Niadra, NiadraAPIError, NiadraConfigError, NiadraValidationError, silentLogger } from "../src/index.js";
import { MockServer, makeClient, marina, problem } from "./helpers.js";

const UPLOAD = "https://media.example-bucket.s3.amazonaws.com/sp/med_1?X-Amz-Signature=abc";

const SIGNED = { "Content-Type": "audio/wav", "x-amz-checksum-sha256": "c2lnbmVk" };

function reserved(url: string = UPLOAD, headers?: Record<string, string>): { status: number; body: unknown } {
  const body = { media_ref: "med_1", upload_url: url, expires_at: "2026-09-22T17:22:00Z" };
  return { status: 201, body: headers ? { ...body, upload_headers: headers } : body };
}

describe("feedback()", () => {
  it("sends the contract body with its idempotency key", async () => {
    const server = new MockServer().on("POST /v1/feedback", { body: { accepted: 1, duplicates: 0, errors: [] } });
    const result = await makeClient(server).feedback({
      subject: marina,
      action: "correct_fact",
      fact_id: "f-9",
      value: "prefers e-mail",
      reason: "told the agent",
      idempotency_key: "fb-1",
    });
    expect(result).toEqual({ ok: true, idempotency_key: "fb-1", error: null });
    expect(server.calls[0]!.body).toEqual({
      idempotency_key: "fb-1",
      subject: marina,
      action: "correct_fact",
      fact_id: "f-9",
      value: "prefers e-mail",
      reason: "told the agent",
    });
    expect(server.calls[0]!.headers["idempotency-key"]).toBe("fb-1");
  });

  it("reports a correction the server rejected", async () => {
    const server = new MockServer().on("POST /v1/feedback", {
      status: 207,
      body: { accepted: 0, duplicates: 0, errors: [{ index: 0, code: "scope_denied" }] },
    });
    const result = await makeClient(server).feedback({ subject: marina, action: "retract_fact", fact_id: "f-1" });
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(NiadraValidationError);
    expect(result.error?.message).toBe("scope_denied");
  });

  it("fails open, retries transient errors, and throws in strict mode", async () => {
    const server = new MockServer().on(
      "POST /v1/feedback",
      problem(503, "unavailable"),
      { body: { accepted: 1, duplicates: 0, errors: [] } },
    );
    const niadra = makeClient(server, { queue: { retryDelayMs: 1 } });
    expect((await niadra.feedback({ subject: marina, action: "retract_fact", fact_id: "f-1" })).ok).toBe(true);
    expect(server.calls).toHaveLength(2);

    const invalid = await niadra.feedback({ subject: marina, action: "nonsense" as never });
    expect(invalid.error).toBeInstanceOf(NiadraValidationError);

    const denied = new MockServer().on("POST /v1/feedback", problem(403, "forbidden"));
    await expect(
      makeClient(denied, { strict: true }).feedback({ subject: marina, action: "retract_fact", fact_id: "f-1" }),
    ).rejects.toBeInstanceOf(NiadraAPIError);
  });
});

describe("uploadMedia()", () => {
  it("reserves the upload, then puts the bytes without the key", async () => {
    const bytes = new TextEncoder().encode("RIFF....WAVEfmt ");
    const server = new MockServer()
      .on("POST /v1/media/uploads", reserved(UPLOAD, SIGNED))
      .on("PUT /sp/med_1", problem(503, "SlowDown"), { status: 200 });
    const niadra = makeClient(server, { queue: { retryDelayMs: 1 }, defaultHeaders: { "x-tenant": "acme" } });
    const { data, error } = await niadra.uploadMedia({ data: bytes, content_type: "audio/wav", subject: marina });
    expect(error).toBeNull();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(data).toEqual({
      media_ref: "med_1",
      media_sha256: sha256,
      content_type: "audio/wav",
      size_bytes: bytes.byteLength,
      expires_at: "2026-09-22T17:22:00Z",
    });
    expect(server.calls[0]!.body).toEqual({ content_type: "audio/wav", size_bytes: bytes.byteLength, sha256, subject: marina });
    const puts = server.callsTo("PUT /sp/med_1");
    expect(puts).toHaveLength(2);
    expect(puts[1]!.url.href).toBe(UPLOAD);
    expect(puts[1]!.bytes).toEqual(bytes);
    expect(puts[1]!.headers).toEqual({ "content-type": "audio/wav", "x-amz-checksum-sha256": "c2lnbmVk" });
  });

  it("sends only the content type when the reservation names no headers", async () => {
    const server = new MockServer().on("POST /v1/media/uploads", reserved()).on("PUT /sp/med_1", { status: 200 });
    await makeClient(server).uploadMedia({ data: new Uint8Array([1]), content_type: "image/png" });
    expect(server.callsTo("PUT /sp/med_1")[0]!.headers).toEqual({ "content-type": "image/png" });
  });

  it("accepts an ArrayBuffer or a Blob", async () => {
    const server = new MockServer().on("POST /v1/media/uploads", reserved()).on("PUT /sp/med_1", { status: 200 });
    const niadra = makeClient(server);
    const fromBuffer = await niadra.uploadMedia({ data: new Uint8Array([1, 2, 3]).buffer, content_type: "image/png" });
    const fromBlob = await niadra.uploadMedia({ data: new Blob([new Uint8Array([1, 2, 3])]), content_type: "image/png" });
    expect(fromBuffer.data?.media_sha256).toBe(fromBlob.data?.media_sha256);
    expect(fromBlob.data?.size_bytes).toBe(3);
  });

  it("refuses to send media over plain HTTP", async () => {
    const server = new MockServer()
      .on("POST /v1/media/uploads", reserved("http://bucket.example.com/med_1"))
      .on("PUT /med_1", { status: 200 });
    const { data, error } = await makeClient(server).uploadMedia({ data: new Uint8Array([1]), content_type: "image/png" });
    expect(data).toBeNull();
    expect(error).toBeInstanceOf(NiadraValidationError);
    expect(server.callsTo("PUT /med_1")).toHaveLength(0);
  });

  it("skips the transfer when the server needs no bytes", async () => {
    const server = new MockServer().on("POST /v1/media/uploads", reserved(""));
    const { data } = await makeClient(server).uploadMedia({ data: new Uint8Array([1]), content_type: "text/plain" });
    expect(data?.media_ref).toBe("med_1");
    expect(server.calls).toHaveLength(1);
  });

  it("fails open on empty files, refused uploads and disabled clients", async () => {
    const server = new MockServer().on("POST /v1/media/uploads", reserved()).on("PUT /sp/med_1", problem(403, "AccessDenied"));
    const niadra = makeClient(server);
    expect((await niadra.uploadMedia({ data: new Uint8Array(), content_type: "image/png" })).error).toBeInstanceOf(
      NiadraValidationError,
    );
    expect((await niadra.uploadMedia({ data: new Uint8Array([1]), content_type: "image/png" })).error).toBeInstanceOf(
      NiadraAPIError,
    );
    const disabled = new Niadra({ apiKey: "", flushOnExit: false, logger: silentLogger });
    expect((await disabled.uploadMedia({ data: new Uint8Array([1]), content_type: "image/png" })).error).toBeInstanceOf(
      NiadraConfigError,
    );
    expect((await disabled.feedback({ subject: marina, action: "retract_fact" })).ok).toBe(false);
  });
});
