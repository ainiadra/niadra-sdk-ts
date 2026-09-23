import { describe, expect, it } from "vitest";
import { NiadraValidationError, handles, toObjectRef } from "../src/index.js";

describe("handles", () => {
  it("builds unscoped handles", () => {
    expect(handles.phone("+5511987654321")).toEqual({ type: "phone_e164", value: "+5511987654321" });
    expect(handles.email("marina@example.com")).toEqual({ type: "email", value: "marina@example.com" });
    expect(handles.appUserId("u-1")).toEqual({ type: "app_user_id", value: "u-1" });
    expect(handles.anonId("dev-9")).toEqual({ type: "anon_id", value: "dev-9" });
  });

  it("puts the namespace of scoped handles in scope", () => {
    expect(handles.systemId("C-0042", "crm")).toEqual({ type: "system_id", value: "C-0042", scope: "crm" });
    expect(handles.waBsuid("BR.123", "waba-1")).toEqual({ type: "wa_bsuid", value: "BR.123", scope: "waba-1" });
    expect(handles.govIdHmac("ab12", "BR")).toEqual({ type: "gov_id_hmac", value: "ab12", scope: "BR" });
  });

  it("marks organization-only handles as accounts", () => {
    expect(handles.emailDomain("acme.com").subject_kind).toBe("account");
    expect(handles.orgRegistryHmac("ff00", "BR")).toEqual({
      type: "org_registry_hmac",
      value: "ff00",
      scope: "BR",
      subject_kind: "account",
    });
  });

  it("lets the caller set the subject kind", () => {
    expect(handles.systemId("P-9", "erp", { subjectKind: "partner" }).subject_kind).toBe("partner");
  });
});

describe("toObjectRef", () => {
  it("splits the shorthand on the first two colons only", () => {
    expect(toObjectRef("invoice:erp:2026:0823")).toEqual({ type: "invoice", namespace: "erp", id: "2026:0823" });
  });

  it("passes objects through", () => {
    const ref = { type: "ticket", namespace: "zendesk", id: "88" };
    expect(toObjectRef(ref)).toBe(ref);
  });

  it.each(["invoice", "invoice:erp", ":erp:1", "invoice::1", "invoice:erp:"])("rejects %j", (value) => {
    expect(() => toObjectRef(value)).toThrow(NiadraValidationError);
  });
});
