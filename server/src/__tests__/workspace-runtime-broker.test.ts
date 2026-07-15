import { describe, expect, it, vi } from "vitest";
import {
  invokeRuntimeBroker,
  readRuntimeBrokerOperation,
  redactRuntimeBrokerJson,
  selectRuntimeBrokerAuditFields,
  validateRuntimeBrokerInvocation,
} from "../services/workspace-runtime-broker.js";

const actorAgentId = "00000000-0000-4000-8000-000000000001";
const issueId = "00000000-0000-4000-8000-000000000002";

function serviceConfig() {
  return {
    broker: {
      enabled: true,
      operations: [{
        id: "member-smoke",
        method: "POST",
        path: "/v1/smoke",
        readOnly: true,
        agentIds: [actorAgentId],
        issueIds: [issueId],
        requiredFields: ["sid", "url", "viewport", "readback"],
        payloadAllowlist: {
          sid: ["member-a", "member-b"],
          url: [
            "https://training.example.test/hub/member-a",
            "https://training.example.test/hub/member-b",
          ],
          viewport: ["desktop", "mobile"],
          readback: ["screenshot", "dom", "iframe", "console", "network_metadata"],
        },
        auditFields: ["sid", "viewport", "authorization"],
      }],
    },
  };
}

function context(overrides: Partial<{ actorAgentId: string; issueId: string; runId: string; operationId: string }> = {}) {
  return {
    actorAgentId,
    issueId,
    runId: "300fd7ec-9b55-48cf-9714-3def0d4e05c2",
    operationId: "member-smoke",
    ...overrides,
  };
}

function payload() {
  return {
    sid: "member-a",
    url: "https://training.example.test/hub/member-a",
    viewport: "desktop",
    readback: ["screenshot", "dom", "iframe", "console", "network_metadata"],
  };
}

describe("workspace runtime broker", () => {
  it("accepts the exact actor, issue, target and readback allowlists", () => {
    const operation = readRuntimeBrokerOperation(serviceConfig(), "member-smoke");
    expect(validateRuntimeBrokerInvocation({ operation, context: context(), payload: payload() })).toEqual(payload());
    expect(selectRuntimeBrokerAuditFields(operation, payload())).toEqual({ sid: "member-a", viewport: "desktop" });
  });

  it.each([
    ["foreign actor", context({ actorAgentId: "11111111-1111-4111-8111-111111111111" }), payload(), "actor_forbidden"],
    ["foreign issue", context({ issueId: "22222222-2222-4222-8222-222222222222" }), payload(), "issue_forbidden"],
    ["foreign sid", context(), { ...payload(), sid: "unknown" }, "payload_value_forbidden"],
    ["foreign url", context(), { ...payload(), url: "https://example.com/" }, "payload_value_forbidden"],
    ["arbitrary navigation", context(), { ...payload(), navigate: "https://example.com/" }, "payload_field_forbidden"],
    ["secret request", context(), { ...payload(), includeHeaders: true }, "sensitive_field_forbidden"],
  ])("rejects %s", (_name, brokerContext, brokerPayload, code) => {
    const operation = readRuntimeBrokerOperation(serviceConfig(), "member-smoke");
    expect(() => validateRuntimeBrokerInvocation({
      operation,
      context: brokerContext as ReturnType<typeof context>,
      payload: brokerPayload,
    })).toThrowError(expect.objectContaining({ code }));
  });

  it("rejects write methods even when the config attempts to enable them", () => {
    const config = serviceConfig();
    config.broker.operations[0]!.method = "DELETE";
    expect(() => readRuntimeBrokerOperation(config, "member-smoke")).toThrowError(
      expect.objectContaining({ code: "operation_not_read_only" }),
    );
  });

  it("redacts sensitive response keys recursively", () => {
    expect(redactRuntimeBrokerJson({
      ok: true,
      authorization: "Bearer secret",
      nested: { cookie: "session", requestHeaders: { safe: false }, status: 200 },
    })).toEqual({
      ok: true,
      authorization: "[REDACTED]",
      nested: { cookie: "[REDACTED]", requestHeaders: "[REDACTED]", status: 200 },
    });
  });

  it("invokes only the configured loopback operation with verified context headers", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify({
      ok: true,
      network: { status: 200, setCookie: "must-not-leak" },
    }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } }));

    const result = await invokeRuntimeBroker({
      serviceUrl: "http://127.0.0.1:43111",
      serviceConfig: serviceConfig(),
      context: context(),
      payload: payload(),
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:43111/v1/smoke");
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: expect.objectContaining({
        "x-paperclip-actor-agent-id": actorAgentId,
        "x-paperclip-issue-id": issueId,
      }),
    });
    expect(result).toEqual({
      status: 200,
      body: { ok: true, network: { status: 200, setCookie: "[REDACTED]" } },
    });
  });

  it("rejects non-loopback services and non-JSON upstream responses", async () => {
    await expect(invokeRuntimeBroker({
      serviceUrl: "https://example.com",
      serviceConfig: serviceConfig(),
      context: context(),
      payload: payload(),
    })).rejects.toMatchObject({ code: "service_url_forbidden" });

    await expect(invokeRuntimeBroker({
      serviceUrl: "http://127.0.0.1:43111",
      serviceConfig: serviceConfig(),
      context: context(),
      payload: payload(),
      fetchImpl: vi.fn(async () => new Response("secret", { status: 200, headers: { "content-type": "text/plain" } })) as typeof fetch,
    })).rejects.toMatchObject({ code: "response_content_type_forbidden" });
  });
});
