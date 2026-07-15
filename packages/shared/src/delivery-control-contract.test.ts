import { describe, expect, it } from "vitest";
import {
  DELIVERY_CONTROL_CONTRACT_V1,
  analyzeDeliveryCriticalPaths,
  buildDeliveryControlRecoveryWakeIdempotencyKey,
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
});
