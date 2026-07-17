import { describe, expect, it } from "vitest";
import {
  evaluateIssueResourceLease,
  readResourceControlConfig,
  resolveIssueResourceControl,
  resolveResourceControlClaimGate,
} from "./resource-control.js";

const baseIssue = {
  id: "issue-1",
  companyId: "company-1",
  status: "in_progress",
  workMode: "standard",
  projectId: "project-1",
};

describe("resource control issue classification", () => {
  it("keeps read, review, and isolated workspace work parallel-safe", () => {
    expect(resolveIssueResourceControl({ ...baseIssue, workMode: "ask" })).toMatchObject({
      actionClass: "read_only",
      leaseRequired: false,
      productiveParallelismAllowed: true,
    });
    expect(resolveIssueResourceControl({ ...baseIssue, status: "in_review" })).toMatchObject({
      actionClass: "review",
      leaseRequired: false,
    });
    expect(resolveIssueResourceControl({
      ...baseIssue,
      executionWorkspaceId: "workspace-1",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    })).toMatchObject({
      actionClass: "isolated_write",
      resourceKey: "execution_workspace:workspace-1",
      leaseRequired: false,
    });
  });

  it("classifies unannotated shared work conservatively and keeps productive concurrency gated", () => {
    expect(resolveIssueResourceControl(baseIssue)).toMatchObject({
      source: "inferred",
      actionClass: "shared_write",
      resourceKey: "project:project-1",
      leaseRequired: true,
      productiveParallelismAllowed: false,
      blockedReason: "exclusive_action_requires_explicit_resource_change_and_idempotency_context",
    });
  });

  it("accepts an explicit external resource and derives a stable idempotency key", () => {
    expect(resolveIssueResourceControl({
      ...baseIssue,
      executionWorkspaceSettings: {
        resourceControl: {
          actionClass: "deploy",
          resourceKey: "vps:production",
          changeId: "sha-123",
        },
      },
    })).toMatchObject({
      source: "explicit",
      actionClass: "deploy",
      resourceKey: "vps:production",
      changeId: "sha-123",
      idempotencyKey: "resource_control:company-1:deploy:vps%3Aproduction:sha-123",
      blockedReason: null,
    });
  });

  it("keeps inferred shared writes in shadow but fails closed in the company canary", () => {
    const inferred = resolveIssueResourceControl(baseIssue);
    expect(resolveResourceControlClaimGate(inferred, "shadow")).toEqual({
      enforced: false,
      blockedReason: null,
    });
    expect(resolveResourceControlClaimGate(inferred, "enforce")).toEqual({
      enforced: true,
      blockedReason: "exclusive_action_requires_explicit_resource_change_and_idempotency_context",
    });
  });

  it("requires its own explicit company canary independently of delivery control", () => {
    const notAllowlisted = readResourceControlConfig("company-1", {
      mode: "enforce",
      canaryCompanyIds: "company-2, company-3",
    });
    expect(notAllowlisted).toMatchObject({ configuredMode: "enforce", effectiveMode: "shadow" });
    expect(resolveResourceControlClaimGate(
      resolveIssueResourceControl(baseIssue),
      notAllowlisted.effectiveMode,
    )).toEqual({ enforced: false, blockedReason: null });
    expect(readResourceControlConfig("company-1", {
      mode: "enforce",
      canaryCompanyIds: "company-2, company-1",
    })).toMatchObject({ configuredMode: "enforce", effectiveMode: "enforce" });
    expect(readResourceControlConfig("company-1", {
      mode: "off",
      canaryCompanyIds: "company-1",
    })).toMatchObject({ configuredMode: "off", effectiveMode: "off" });
  });

  it("preserves explicit external lease enforcement without adding a global rollout gate", () => {
    const external = resolveIssueResourceControl({
      ...baseIssue,
      executionWorkspaceSettings: {
        resourceControl: {
          actionClass: "external_action",
          resourceKey: "customer:123",
          changeId: "message-1",
          idempotencyKey: "customer-123-message-1",
        },
      },
    });
    expect(resolveResourceControlClaimGate(external, "shadow")).toEqual({
      enforced: true,
      blockedReason: null,
    });
    expect(resolveResourceControlClaimGate(external, "enforce")).toEqual({
      enforced: true,
      blockedReason: null,
    });
  });

  it("produces a wait decision for the same resource and an acquire decision for a different resource", () => {
    const issue = {
      ...baseIssue,
      executionWorkspaceSettings: {
        resourceControl: {
          actionClass: "external_action",
          resourceKey: "customer:123",
          changeId: "change-2",
          idempotencyKey: "idem-2",
        },
      },
    };
    const currentLease = {
      resourceKey: "customer:123",
      actionClass: "external_action" as const,
      ownerRunId: "run-1",
      changeId: "change-1",
      idempotencyKey: "idem-1",
      status: "active" as const,
      acquiredAt: "2026-07-15T00:00:00.000Z",
      expiresAt: "2026-07-15T00:05:00.000Z",
    };
    expect(evaluateIssueResourceLease({
      issue,
      runId: "run-2",
      currentLease,
      now: "2026-07-15T00:01:00.000Z",
    }).decision).toMatchObject({ decision: "wait", blockingRunId: "run-1" });
    expect(evaluateIssueResourceLease({
      issue: {
        ...issue,
        executionWorkspaceSettings: {
          resourceControl: {
            actionClass: "external_action",
            resourceKey: "customer:456",
            changeId: "change-3",
            idempotencyKey: "idem-3",
          },
        },
      },
      runId: "run-3",
    }).decision).toMatchObject({ decision: "acquire", blockingRunId: null });
  });
});
