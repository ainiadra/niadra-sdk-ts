import { afterEach, describe, expect, it, vi } from "vitest";
import { Niadra, NiadraConfigError, baseURLFromKey, parseApiKey, silentLogger } from "../src/index.js";
import { BASE, KEY, MockServer, contextBody, marina, spyLogger } from "./helpers.js";

describe("parseApiKey", () => {
  it("reads mode, region, space and key id, and never returns the secret", () => {
    const parsed = parseApiKey(KEY);
    expect(parsed).toEqual({ mode: "test", region: "sa-east-1", space: "acme-sandbox", keyId: "k7Qx" });
    expect(JSON.stringify(parsed)).not.toContain("s3cr3t");
  });

  it("accepts live keys", () => {
    expect(parseApiKey("nia_sk_live_eu-central-1_globex_k1_abc")?.mode).toBe("live");
  });

  it.each([
    ["wrong prefix", "sk_live_sa-east-1_acme_k1_abc"],
    ["unknown mode", "nia_sk_prod_sa-east-1_acme_k1_abc"],
    ["missing secret", "nia_sk_live_sa-east-1_acme_k1"],
    ["empty secret", "nia_sk_live_sa-east-1_acme_k1_"],
    ["uppercase region", "nia_sk_live_SA-EAST-1_acme_k1_abc"],
    ["space with a dot", "nia_sk_live_sa-east-1_ac.me_k1_abc"],
    ["space ending in a hyphen", "nia_sk_live_sa-east-1_acme-_k1_abc"],
    ["key id with a hyphen", "nia_sk_live_sa-east-1_acme_k-1_abc"],
  ])("rejects a key with %s", (_, key) => {
    expect(parseApiKey(key)).toBeNull();
  });

  it("derives the space's stable address", () => {
    expect(baseURLFromKey(parseApiKey(KEY)!)).toBe(BASE);
  });
});

describe("client configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sends requests to the address derived from the key", async () => {
    const server = new MockServer().on("POST /v1/context", { body: contextBody() });
    const niadra = new Niadra({ apiKey: KEY, fetch: server.fetch, flushOnExit: false });
    await niadra.context({ subject: marina });
    expect(server.calls[0]!.url.origin).toBe(BASE);
  });

  it("lets baseURL override the derived address, trailing slash included", async () => {
    const server = new MockServer().on("POST /v1/context", { body: contextBody() });
    const niadra = new Niadra({ apiKey: KEY, baseURL: "http://localhost:4010/", fetch: server.fetch, flushOnExit: false });
    await niadra.context({ subject: marina });
    expect(server.calls[0]!.url.href).toBe("http://localhost:4010/v1/context");
  });

  it("accepts a key in another format when baseURL is given, for the local emulator", () => {
    const niadra = new Niadra({ apiKey: "local-dev", baseURL: "http://localhost:4010", flushOnExit: false });
    expect(niadra.enabled).toBe(true);
  });

  it("reads NIADRA_API_KEY and NIADRA_BASE_URL from the environment", async () => {
    vi.stubEnv("NIADRA_API_KEY", KEY);
    vi.stubEnv("NIADRA_BASE_URL", "http://emulator:4010");
    const server = new MockServer().on("POST /v1/context", { body: contextBody() });
    const niadra = new Niadra({ fetch: server.fetch, flushOnExit: false });
    await niadra.context({ subject: marina });
    expect(server.calls[0]!.url.origin).toBe("http://emulator:4010");
    expect(server.calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("becomes a no-op without a key, and says so once", () => {
    vi.stubEnv("NIADRA_API_KEY", "");
    const logger = spyLogger();
    const niadra = new Niadra({ logger, flushOnExit: false });
    expect(niadra.enabled).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toContain("no API key");
  });

  it("becomes a no-op with a malformed key and no baseURL", () => {
    const niadra = new Niadra({ apiKey: "nia_sk_bad", logger: silentLogger, flushOnExit: false });
    expect(niadra.enabled).toBe(false);
  });

  it("throws a configuration error in strict mode", () => {
    vi.stubEnv("NIADRA_API_KEY", "");
    expect(() => new Niadra({ strict: true })).toThrow(NiadraConfigError);
    expect(() => new Niadra({ apiKey: "nia_sk_bad", strict: true })).toThrow(/does not look like/);
  });

  it("never puts the key in log output", () => {
    const logger = spyLogger();
    new Niadra({ apiKey: "nia_sk_live_XX_secretvalue", logger, flushOnExit: false });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("secretvalue");
  });
});
