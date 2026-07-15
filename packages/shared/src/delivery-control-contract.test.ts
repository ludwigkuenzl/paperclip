import { describe, expect, it } from "vitest";
import {
  DELIVERY_CONTROL_CONTRACT_V1,
  analyzeDeliveryCriticalPaths,
  buildDeliveryControlResourceIdempotencyKey,
  buildDeliveryControlResourceQueueTelemetry,
  buildDeliveryControlRecoveryWakeIdempotencyKey,
  evaluateDeliveryControlResourceLease,
  deliveryControlPolicyForPriority,
  evaluateDeliveryIncidentLane,
} from "./delivery-control-contract.js";

describe("delivery-control contract", () => {
  it("publishes the accepted Critical and High SLA values and bounded recovery limit", () => {
    expect(DELIVERY_CONTROL_CONTRACT_V1).toMatchObject({
      lifecycleContract: { id: "paperclip.issue-lifecycle-execution", minimumVersion: "1.0.0" },
      priorities: {
        critical: {
          startSlaMs: 5 * 60_000,
          recoveryAfterMs: 15 * 60_000,
          escalationAfterMs: 30 * 60_000,
          communicationMaxGapMs: 30 * 60_000,
        },
        high: {
          startSlaMs: 15 * 60_000,
          recoveryAfterMs: 30 * 60_000,
          escalationAfterMs: 60 * 60_000,
          communicationMaxGapMs: 2 * 60 * 60_000,
        },
      },
      recovery: { maximumAutomaticAttempts: 2, exhaustedDisposition: "first_class_blocker" },
      criticalPath: { maximumDependencyDepth: 3, parentChildIsDependency: false },
      incidentLane: { maximumActiveTechnicalPackages: 3 },
      resourceControl: {
        exclusiveLeaseRequired: ["shared_write", "deploy", "external_action"],
        externalParallelismDefault: "blocked_until_action_class_canary",
        targetMaxConcurrentRuns: 20,
        canary: { minimumConcurrentIndependentRunsPerReferenceRole: 3 },
      },
    });
    expect(deliveryControlPolicyForPriority("medium")).toBeNull();
  });

  it("propagates priority only across explicit blocker edges and reports excessive depth", () => {
    const nodes = [
      { id: "root", priority: "critical" as const },
      { id: "blocker-1", priority: "low" as const },
      { id: "blocker-2", priority: "medium" as const },
      { id: "blocker-3", priority: "low" as const },
      { id: "blocker-4", priority: "low" as const },
      { id: "child-without-edge", priority: "low" as const },
    ];
    const result = analyzeDeliveryCriticalPaths({
      nodes,
      edges: [
        { blockedIssueId: "root", blockerIssueId: "blocker-1" },
        { blockedIssueId: "blocker-1", blockerIssueId: "blocker-2" },
        { blockedIssueId: "blocker-2", blockerIssueId: "blocker-3" },
        { blockedIssueId: "blocker-3", blockerIssueId: "blocker-4" },
      ],
    });

    expect(result.effectivePriorityByIssueId).toMatchObject({
      root: "critical",
      "blocker-1": "critical",
      "blocker-2": "critical",
      "blocker-3": "critical",
      "blocker-4": "low",
      "child-without-edge": "low",
    });
    expect(result.depthLimitExceeded).toBe(true);
    expect(result.paths).toContainEqual(expect.objectContaining({
      issueIds: ["root", "blocker-1", "blocker-2", "blocker-3", "blocker-4"],
      depth: 4,
      truncated: true,
    }));
  });

  it("detects dependency cycles without recursing indefinitely", () => {
    const result = analyzeDeliveryCriticalPaths({
      nodes: [
        { id: "root", priority: "high" },
        { id: "blocker", priority: "low" },
      ],
      edges: [
        { blockedIssueId: "root", blockerIssueId: "blocker" },
        { blockedIssueId: "blocker", blockerIssueId: "root" },
      ],
    });
    expect(result.cycleDetected).toBe(true);
    expect(result.paths[0]).toMatchObject({ cycle: true, truncated: true });
  });

  it("enforces the incident lane at three active technical packages", () => {
    expect(evaluateDeliveryIncidentLane(["pkg-3", "pkg-1", "pkg-2"])).toMatchObject({
      activeCount: 3,
      limit: 3,
      overLimit: false,
      availableSlots: 0,
    });
    expect(evaluateDeliveryIncidentLane(["pkg-4", "pkg-3", "pkg-2", "pkg-1"])).toMatchObject({
      overLimit: true,
      excessIssueIds: ["pkg-4"],
    });
  });

  it("builds stable attempt-scoped recovery keys for duplicate-wake suppression", () => {
    const input = {
      issueId: "issue-1",
      reason: "issue_continuation_needed",
      sourceRunId: "run-1",
      attempt: 2,
    };
    expect(buildDeliveryControlRecoveryWakeIdempotencyKey(input)).toBe(
      "delivery_control_recovery:issue-1:issue_continuation_needed:run-1:2",
    );
    expect(buildDeliveryControlRecoveryWakeIdempotencyKey(input)).toBe(
      buildDeliveryControlRecoveryWakeIdempotencyKey(input),
    );
  });

  it("keeps safe action classes parallel and fails closed on incomplete external-write metadata", () => {
    expect(evaluateDeliveryControlResourceLease({
      actionClass: "isolated_write",
      runId: "run-1",
    })).toMatchObject({ decision: "parallel_safe", reason: "action_class_parallel_safe" });
    expect(evaluateDeliveryControlResourceLease({
      actionClass: "deploy",
      runId: "run-1",
      resourceKey: "vps:production",
    })).toMatchObject({ decision: "deny", reason: "change_id_required" });
  });

  it("serializes one concrete resource while leaving unrelated resources independent", () => {
    const activeLease = {
      resourceKey: "vps:production",
      actionClass: "deploy" as const,
      ownerRunId: "run-1",
      changeId: "change-1",
      idempotencyKey: "idem-1",
      status: "active" as const,
      acquiredAt: "2026-07-15T00:00:00.000Z",
      expiresAt: "2026-07-15T00:05:00.000Z",
    };
    expect(evaluateDeliveryControlResourceLease({
      actionClass: "deploy",
      runId: "run-2",
      resourceKey: "vps:production",
      changeId: "change-2",
      idempotencyKey: "idem-2",
      currentLease: activeLease,
      now: "2026-07-15T00:01:00.000Z",
    })).toMatchObject({ decision: "wait", blockingRunId: "run-1" });
    expect(evaluateDeliveryControlResourceLease({
      actionClass: "deploy",
      runId: "run-2",
      resourceKey: "vps:staging",
      changeId: "change-2",
      idempotencyKey: "idem-2",
    })).toMatchObject({ decision: "acquire", blockingRunId: null });
  });

  it("requires recovery before stealing an expired lease and replays completed changes only with readback", () => {
    const lease = {
      resourceKey: "customer:123",
      actionClass: "external_action" as const,
      ownerRunId: "run-1",
      changeId: "change-1",
      idempotencyKey: "idem-1",
      status: "active" as const,
      acquiredAt: "2026-07-15T00:00:00.000Z",
      expiresAt: "2026-07-15T00:05:00.000Z",
    };
    expect(evaluateDeliveryControlResourceLease({
      actionClass: "external_action",
      runId: "run-2",
      resourceKey: "customer:123",
      changeId: "change-2",
      idempotencyKey: "idem-2",
      currentLease: lease,
      now: "2026-07-15T00:05:01.000Z",
    })).toMatchObject({ decision: "recovery_required", blockingRunId: "run-1" });
    expect(evaluateDeliveryControlResourceLease({
      actionClass: "external_action",
      runId: "run-2",
      resourceKey: "customer:123",
      changeId: "change-1",
      idempotencyKey: "idem-1",
      currentLease: { ...lease, status: "completed", targetStateReadback: { externalId: "ext-1" } },
    })).toMatchObject({
      decision: "replay_completed",
      targetStateReadback: { externalId: "ext-1" },
    });
  });

  it("builds stable resource idempotency keys and deterministic per-resource queue positions", () => {
    expect(buildDeliveryControlResourceIdempotencyKey({
      companyId: "company-1",
      actionClass: "deploy",
      resourceKey: "vps:production",
      changeId: "sha-123",
    })).toBe("resource_control:company-1:deploy:vps%3Aproduction:sha-123");

    expect(buildDeliveryControlResourceQueueTelemetry([
      {
        runId: "run-b",
        actionClass: "deploy",
        resourceKey: "vps:production",
        waitReason: "resource_held_by_another_run",
        blockingRunId: "run-owner",
        waitingSinceAt: "2026-07-15T00:02:00.000Z",
        nextCheckAt: "2026-07-15T00:03:00.000Z",
      },
      {
        runId: "run-a",
        actionClass: "deploy",
        resourceKey: "vps:production",
        waitReason: "resource_held_by_another_run",
        blockingRunId: "run-owner",
        waitingSinceAt: "2026-07-15T00:01:00.000Z",
        nextCheckAt: "2026-07-15T00:03:00.000Z",
      },
      {
        runId: "run-c",
        actionClass: "shared_write",
        resourceKey: "repo:other",
        waitReason: "resource_held_by_another_run",
        blockingRunId: "run-other-owner",
        waitingSinceAt: "2026-07-15T00:02:00.000Z",
        nextCheckAt: "2026-07-15T00:03:00.000Z",
      },
    ])).toEqual([
      expect.objectContaining({ runId: "run-c", resourceKey: "repo:other", queuePosition: 1 }),
      expect.objectContaining({ runId: "run-a", resourceKey: "vps:production", queuePosition: 1 }),
      expect.objectContaining({ runId: "run-b", resourceKey: "vps:production", queuePosition: 2 }),
    ]);
  });
});
