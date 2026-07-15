import { describe, expect, it } from "vitest";
import {
  evaluateDeliveryCommunication,
  evaluateDeliveryControl,
  readDeliveryControlConfig,
} from "./delivery-control.js";

const companyId = "company-1";
const issueId = "issue-1";
const triggerAt = "2026-07-15T00:00:00.000Z";

describe("delivery-control SLA and liveness shadow evaluator", () => {
  it("audits Critical queue/start/result timestamps and the five-minute start SLA", () => {
    const result = evaluateDeliveryControl({
      companyId,
      issueId,
      priority: "critical",
      status: "in_progress",
      triggerAt,
      queuedAt: "2026-07-15T00:01:00.000Z",
      runStartedAt: "2026-07-15T00:04:00.000Z",
      resultAt: "2026-07-15T00:06:00.000Z",
      lastProgressAt: "2026-07-15T00:06:00.000Z",
      hasActiveRun: true,
      now: "2026-07-15T00:07:00.000Z",
    });

    expect(result).toMatchObject({
      enabled: true,
      livenessState: "active",
      startSla: { status: "met", deadlineAt: "2026-07-15T00:05:00.000Z" },
      audit: {
        measurementStartAt: triggerAt,
        queueEntryAt: "2026-07-15T00:01:00.000Z",
        runStartAt: "2026-07-15T00:04:00.000Z",
        resultAt: "2026-07-15T00:06:00.000Z",
      },
    });
  });

  it("marks an overdue queued Critical issue stalled instead of falsely covered", () => {
    const result = evaluateDeliveryControl({
      companyId,
      issueId,
      priority: "critical",
      status: "todo",
      triggerAt,
      queuedAt: "2026-07-15T00:01:00.000Z",
      hasQueuedWake: true,
      now: "2026-07-15T00:05:01.000Z",
    });
    expect(result).toMatchObject({
      livenessState: "stalled",
      startSla: { status: "breached" },
      recovery: { status: "waiting", dueAt: "2026-07-15T00:15:00.000Z", blockerRequired: false },
    });
  });

  it("uses 15/30 minutes for Critical and 30/60 minutes for High recovery/escalation", () => {
    const critical = evaluateDeliveryControl({
      companyId,
      issueId,
      priority: "critical",
      status: "in_progress",
      triggerAt,
      runStartedAt: triggerAt,
      lastProgressAt: triggerAt,
      now: "2026-07-15T00:30:00.000Z",
    });
    expect(critical).toMatchObject({
      livenessState: "stalled",
      recovery: { status: "due", dueAt: "2026-07-15T00:15:00.000Z" },
      escalation: { status: "due", dueAt: "2026-07-15T00:30:00.000Z" },
    });

    const high = evaluateDeliveryControl({
      companyId,
      issueId,
      priority: "high",
      status: "in_progress",
      triggerAt,
      runStartedAt: triggerAt,
      lastProgressAt: triggerAt,
      now: "2026-07-15T01:00:00.000Z",
    });
    expect(high).toMatchObject({
      recovery: { status: "due", dueAt: "2026-07-15T00:30:00.000Z" },
      escalation: { status: "due", dueAt: "2026-07-15T01:00:00.000Z" },
    });
  });

  it("requires a first-class blocker after two automatic recovery attempts", () => {
    const result = evaluateDeliveryControl({
      companyId,
      issueId,
      priority: "high",
      status: "in_progress",
      triggerAt,
      runStartedAt: triggerAt,
      lastProgressAt: triggerAt,
      recoveryAttemptCount: 2,
      now: "2026-07-15T00:31:00.000Z",
    });
    expect(result).toMatchObject({
      livenessState: "needs_attention",
      recovery: { status: "exhausted", attemptCount: 2, maximumAttempts: 2, blockerRequired: true },
    });
  });

  it("treats comments and process existence as insufficient unless a persisted path is supplied", () => {
    const result = evaluateDeliveryControl({
      companyId,
      issueId,
      priority: "high",
      status: "in_progress",
      triggerAt,
      runStartedAt: triggerAt,
      lastProgressAt: triggerAt,
      now: "2026-07-15T00:31:00.000Z",
    });
    expect(result.livenessState).toBe("stalled");
  });

  it("does not call an over-capacity queue or incoherent/orphaned lock covered", () => {
    const queued = evaluateDeliveryControl({
      companyId,
      issueId,
      priority: "high",
      status: "todo",
      triggerAt,
      hasQueuedWake: true,
      queueCapacityAvailable: false,
      now: "2026-07-15T00:01:00.000Z",
    });
    expect(queued.livenessState).toBe("stalled");

    const incoherent = evaluateDeliveryControl({
      companyId,
      issueId,
      priority: "critical",
      status: "in_progress",
      triggerAt,
      runStartedAt: triggerAt,
      lastProgressAt: "2026-07-15T00:01:00.000Z",
      hasActiveRun: true,
      executionLockCoherent: false,
      now: "2026-07-15T00:02:00.000Z",
    });
    expect(incoherent.livenessState).toBe("stalled");

    const orphaned = evaluateDeliveryControl({
      companyId,
      issueId,
      priority: "critical",
      status: "in_progress",
      triggerAt,
      runStartedAt: triggerAt,
      lastProgressAt: "2026-07-15T00:01:00.000Z",
      hasActiveRun: true,
      hasOrphanedResourceLock: true,
      now: "2026-07-15T00:02:00.000Z",
    });
    expect(orphaned.livenessState).toBe("needs_attention");
  });

  it("does not treat an owner or an unscheduled recovery record as durable coverage", () => {
    const humanOwned = evaluateDeliveryControl({
      companyId,
      issueId,
      priority: "critical",
      status: "blocked",
      triggerAt,
      hasHumanOwner: true,
      now: "2026-07-15T00:16:00.000Z",
    });
    expect(humanOwned.livenessState).toBe("stalled");

    const unscheduledRecovery = evaluateDeliveryControl({
      companyId,
      issueId,
      priority: "critical",
      status: "blocked",
      triggerAt,
      hasUnscheduledRecoveryAction: true,
      now: "2026-07-15T00:16:00.000Z",
    });
    expect(unscheduledRecovery.livenessState).toBe("needs_attention");
  });

  it("keeps enforce mode canary-scoped and defaults unknown modes to shadow", () => {
    expect(readDeliveryControlConfig(companyId, {
      mode: "enforce",
      canaryCompanyIds: "another-company, company-1",
    }).effectiveMode).toBe("enforce");
    expect(readDeliveryControlConfig(companyId, {
      mode: "enforce",
      canaryCompanyIds: "another-company",
    }).effectiveMode).toBe("shadow");
    expect(readDeliveryControlConfig(companyId, { mode: "invalid" }).effectiveMode).toBe("shadow");
  });
});

describe("delivery-control delta communication", () => {
  const base = {
    issueId,
    priority: "critical" as const,
    phase: "active" as const,
    livenessState: "active" as const,
    startSlaStatus: "met" as const,
    recoveryStatus: "waiting" as const,
    escalationStatus: "waiting" as const,
    lastProgressAt: "2026-07-15T00:05:00.000Z",
    completed: "Repository audit complete",
    currentAction: "Running targeted tests",
    remaining: "Canary readback",
    owner: "CTO",
    nextCheckAt: "2026-07-15T00:30:00.000Z",
  };

  it("emits exactly one delta-rich phase update and suppresses a duplicate tick", () => {
    const first = evaluateDeliveryCommunication({ current: base, now: "2026-07-15T00:10:00.000Z" });
    expect(first).toMatchObject({
      emit: true,
      reason: "phase_change",
      payload: {
        completed: "Repository audit complete",
        currentAction: "Running targeted tests",
        remaining: "Canary readback",
        owner: "CTO",
        nextCheckAt: "2026-07-15T00:30:00.000Z",
      },
    });
    const duplicate = evaluateDeliveryCommunication({
      current: base,
      previous: base,
      lastEmittedFingerprint: first.fingerprint,
      lastEmittedAt: "2026-07-15T00:10:00.000Z",
      now: "2026-07-15T00:11:00.000Z",
    });
    expect(duplicate).toMatchObject({ emit: false, suppressedReason: "no_delta", eventKey: null });
  });

  it("does not emit a cadence message without a real progress delta", () => {
    const first = evaluateDeliveryCommunication({ current: base, now: "2026-07-15T00:00:00.000Z" });
    const noOp = evaluateDeliveryCommunication({
      current: base,
      previous: base,
      lastEmittedFingerprint: first.fingerprint,
      lastEmittedAt: "2026-07-15T00:00:00.000Z",
      now: "2026-07-15T00:31:00.000Z",
    });
    expect(noOp).toMatchObject({ emit: false, suppressedReason: "no_delta" });

    const progressed = evaluateDeliveryCommunication({
      current: {
        ...base,
        lastProgressAt: "2026-07-15T00:29:00.000Z",
        completed: "Repository audit and unit tests complete",
      },
      previous: base,
      lastEmittedFingerprint: first.fingerprint,
      lastEmittedAt: "2026-07-15T00:00:00.000Z",
      now: "2026-07-15T00:31:00.000Z",
    });
    expect(progressed).toMatchObject({ emit: true, reason: "long_run_delta" });
  });

  it("emits blocker, SLA-risk, user-decision and live-acceptance updates once per delta", () => {
    expect(evaluateDeliveryCommunication({
      current: { ...base, blockerFingerprint: "blocker-1", livenessState: "stalled" },
      previous: base,
    }).reason).toBe("real_blocker");
    expect(evaluateDeliveryCommunication({
      current: { ...base, startSlaStatus: "risk" },
      previous: { ...base, startSlaStatus: "pending" },
    }).reason).toBe("sla_risk");
    expect(evaluateDeliveryCommunication({
      current: { ...base, userDecisionPending: true },
      previous: base,
    }).reason).toBe("user_decision");
    expect(evaluateDeliveryCommunication({
      current: { ...base, liveAcceptance: true, phase: "terminal" },
      previous: base,
    }).reason).toBe("live_acceptance");
  });

  it("fails closed when a required communication field is missing", () => {
    expect(evaluateDeliveryCommunication({
      current: { ...base, remaining: "" },
    })).toMatchObject({ emit: false, suppressedReason: "missing_required_fields" });
  });
});
