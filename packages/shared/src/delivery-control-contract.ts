import type { IssuePriority } from "./constants.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const DELIVERY_CONTROL_ACTION_CLASSES = [
  "read_only",
  "review",
  "vault_write",
  "isolated_write",
  "shared_write",
  "deploy",
  "external_action",
] as const;

export const DELIVERY_CONTROL_CONTRACT_V1 = {
  id: "paperclip.delivery-control",
  version: "1.0.0",
  lifecycleContract: {
    id: "paperclip.issue-lifecycle-execution",
    minimumVersion: "1.0.0",
  },
  rollout: {
    modes: ["off", "shadow", "enforce"],
    defaultMode: "shadow",
    enforcementRequiresCanary: true,
    canaryScope: "explicit_company_id_allowlist",
  },
  priorities: {
    critical: {
      startSlaMs: 5 * MINUTE_MS,
      recoveryAfterMs: 15 * MINUTE_MS,
      escalationAfterMs: 30 * MINUTE_MS,
      communicationMaxGapMs: 30 * MINUTE_MS,
    },
    high: {
      startSlaMs: 15 * MINUTE_MS,
      recoveryAfterMs: 30 * MINUTE_MS,
      escalationAfterMs: HOUR_MS,
      communicationMaxGapMs: 2 * HOUR_MS,
    },
  },
  recovery: {
    maximumAutomaticAttempts: 2,
    exhaustedDisposition: "first_class_blocker",
    exactlyOnce: "stable_issue_reason_source_run_attempt_key",
  },
  liveness: {
    states: ["active", "covered", "stalled", "needs_attention", "terminal"],
    activeRequiresAny: ["active_run_with_recent_progress"],
    coveredRequiresAny: [
      "queued_wake_within_start_sla",
      "scheduled_retry",
      "scheduled_monitor",
      "typed_review_or_approval",
      "live_dependency_path",
      "explicit_recovery_action",
    ],
    commentsAndBackgroundProcessesAreEvidenceOnly: true,
  },
  criticalPath: {
    propagationEdges: ["blocks"],
    parentChildIsDependency: false,
    maximumDependencyDepth: 3,
  },
  incidentLane: {
    maximumActiveTechnicalPackages: 3,
  },
  resourceControl: {
    actionClasses: DELIVERY_CONTROL_ACTION_CLASSES,
    parallelSafeWithoutLease: ["read_only", "review", "vault_write", "isolated_write"],
    exclusiveLeaseRequired: ["shared_write", "deploy", "external_action"],
    externalParallelismDefault: "blocked_until_action_class_canary",
    lease: {
      defaultTtlMs: 5 * MINUTE_MS,
      renewalIntervalMs: MINUTE_MS,
      expiredLeaseDisposition: "recovery_required_before_reacquire",
      ownershipRequiredFor: ["renew", "release", "complete"],
      completionRequiresTargetStateReadback: true,
    },
    queueTelemetryFields: [
      "actionClass",
      "resourceKey",
      "waitReason",
      "blockingRunId",
      "waitingSinceAt",
      "queuePosition",
      "nextCheckAt",
    ],
    targetMaxConcurrentRuns: 20,
    canary: {
      minimumConcurrentIndependentRunsPerReferenceRole: 3,
      referenceRoles: ["cto", "frontend_engineer"],
    },
  },
  communication: {
    reasons: [
      "phase_change",
      "real_blocker",
      "sla_risk",
      "user_decision",
      "live_acceptance",
      "long_run_delta",
    ],
    requiredFields: ["completed", "currentAction", "remaining", "owner", "nextCheckAt"],
    noDelta: "suppress",
    exactlyOnce: "stable_issue_reason_delta_fingerprint",
  },
} as const;

export type DeliveryControlContractV1 = typeof DELIVERY_CONTROL_CONTRACT_V1;
export type DeliveryControlPriority = keyof DeliveryControlContractV1["priorities"];
export type DeliveryControlMode = "off" | "shadow" | "enforce";
export type DeliveryControlLivenessState = DeliveryControlContractV1["liveness"]["states"][number];
export type DeliveryControlCommunicationReason =
  DeliveryControlContractV1["communication"]["reasons"][number];
export type DeliveryControlActionClass =
  DeliveryControlContractV1["resourceControl"]["actionClasses"][number];

export interface DeliveryControlResourceLeaseSnapshot {
  resourceKey: string;
  actionClass: DeliveryControlActionClass;
  ownerRunId: string;
  changeId: string;
  idempotencyKey: string;
  status: "active" | "completed" | "released" | "recovery_required";
  acquiredAt: Date | string;
  expiresAt: Date | string;
  completedAt?: Date | string | null;
  targetStateReadback?: Record<string, unknown> | null;
}

export type DeliveryControlResourceLeaseDecision =
  | {
      decision: "parallel_safe" | "acquire" | "owned";
      resourceKey: string | null;
      blockingRunId: null;
      reason: string;
    }
  | {
      decision: "wait" | "recovery_required";
      resourceKey: string;
      blockingRunId: string;
      reason: string;
    }
  | {
      decision: "replay_completed";
      resourceKey: string;
      blockingRunId: null;
      reason: string;
      targetStateReadback: Record<string, unknown>;
    }
  | {
      decision: "deny";
      resourceKey: string | null;
      blockingRunId: string | null;
      reason: string;
    };

export interface DeliveryControlResourceQueueEntry {
  runId: string;
  actionClass: DeliveryControlActionClass;
  resourceKey: string;
  waitReason: string;
  blockingRunId: string | null;
  waitingSinceAt: Date | string;
  nextCheckAt: Date | string;
}

export interface DeliveryControlResourceQueueTelemetry {
  actionClass: DeliveryControlActionClass;
  resourceKey: string;
  waitReason: string;
  blockingRunId: string | null;
  waitingSinceAt: string;
  queuePosition: number;
  nextCheckAt: string;
}

export interface DeliveryControlResourceQueueTelemetryRecord
  extends DeliveryControlResourceQueueTelemetry {
  runId: string;
}

export function isDeliveryControlPriority(priority: IssuePriority | string): priority is DeliveryControlPriority {
  return priority === "critical" || priority === "high";
}

export function deliveryControlPolicyForPriority(priority: IssuePriority | string) {
  return isDeliveryControlPriority(priority)
    ? DELIVERY_CONTROL_CONTRACT_V1.priorities[priority]
    : null;
}

const PRIORITY_RANK: Record<IssuePriority, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function higherIssuePriority(left: IssuePriority, right: IssuePriority): IssuePriority {
  return PRIORITY_RANK[left] >= PRIORITY_RANK[right] ? left : right;
}

export function buildDeliveryControlRecoveryWakeIdempotencyKey(input: {
  issueId: string;
  reason: string;
  sourceRunId?: string | null;
  attempt: number;
}) {
  const sourceRunId = input.sourceRunId?.trim() || "no_source_run";
  const reason = input.reason.trim().replace(/[^a-zA-Z0-9_.-]+/g, "_") || "recovery";
  const attempt = Math.max(1, Math.floor(input.attempt));
  return `delivery_control_recovery:${input.issueId}:${reason}:${sourceRunId}:${attempt}`;
}

export interface DeliveryControlCriticalPathNode {
  id: string;
  priority: IssuePriority;
}

export interface DeliveryControlDependencyEdge {
  blockerIssueId: string;
  blockedIssueId: string;
}

export interface DeliveryControlCriticalPath {
  rootIssueId: string;
  issueIds: string[];
  effectivePriority: DeliveryControlPriority;
  depth: number;
  truncated: boolean;
  cycle: boolean;
}

export interface DeliveryControlCriticalPathAnalysis {
  effectivePriorityByIssueId: Record<string, IssuePriority>;
  paths: DeliveryControlCriticalPath[];
  maximumDependencyDepth: number;
  depthLimitExceeded: boolean;
  cycleDetected: boolean;
}

export function analyzeDeliveryCriticalPaths(input: {
  nodes: DeliveryControlCriticalPathNode[];
  edges: DeliveryControlDependencyEdge[];
  maximumDependencyDepth?: number;
}): DeliveryControlCriticalPathAnalysis {
  const maximumDependencyDepth = Math.max(
    1,
    Math.floor(input.maximumDependencyDepth ?? DELIVERY_CONTROL_CONTRACT_V1.criticalPath.maximumDependencyDepth),
  );
  const nodesById = new Map(input.nodes.map((node) => [node.id, node]));
  const blockersByIssueId = new Map<string, string[]>();
  for (const edge of input.edges) {
    if (!nodesById.has(edge.blockedIssueId) || !nodesById.has(edge.blockerIssueId)) continue;
    const blockers = blockersByIssueId.get(edge.blockedIssueId) ?? [];
    if (!blockers.includes(edge.blockerIssueId)) blockers.push(edge.blockerIssueId);
    blockersByIssueId.set(edge.blockedIssueId, blockers);
  }
  for (const blockers of blockersByIssueId.values()) blockers.sort((left, right) => left.localeCompare(right));

  const effectivePriorityByIssueId = new Map(
    input.nodes.map((node) => [node.id, node.priority] as const),
  );
  const paths: DeliveryControlCriticalPath[] = [];
  let depthLimitExceeded = false;
  let cycleDetected = false;

  const visit = (
    rootIssueId: string,
    effectivePriority: DeliveryControlPriority,
    issueId: string,
    issueIds: string[],
  ) => {
    const blockers = blockersByIssueId.get(issueId) ?? [];
    if (blockers.length === 0) {
      paths.push({
        rootIssueId,
        issueIds,
        effectivePriority,
        depth: Math.max(0, issueIds.length - 1),
        truncated: false,
        cycle: false,
      });
      return;
    }

    for (const blockerIssueId of blockers) {
      const nextIssueIds = [...issueIds, blockerIssueId];
      const depth = nextIssueIds.length - 1;
      if (issueIds.includes(blockerIssueId)) {
        cycleDetected = true;
        paths.push({
          rootIssueId,
          issueIds: nextIssueIds,
          effectivePriority,
          depth,
          truncated: true,
          cycle: true,
        });
        continue;
      }
      if (depth > maximumDependencyDepth) {
        depthLimitExceeded = true;
        paths.push({
          rootIssueId,
          issueIds: nextIssueIds,
          effectivePriority,
          depth,
          truncated: true,
          cycle: false,
        });
        continue;
      }

      const currentPriority = effectivePriorityByIssueId.get(blockerIssueId) ?? "low";
      effectivePriorityByIssueId.set(
        blockerIssueId,
        higherIssuePriority(currentPriority, effectivePriority),
      );
      visit(rootIssueId, effectivePriority, blockerIssueId, nextIssueIds);
    }
  };

  const roots = input.nodes
    .filter((node): node is DeliveryControlCriticalPathNode & { priority: DeliveryControlPriority } =>
      isDeliveryControlPriority(node.priority))
    .sort((left, right) => left.id.localeCompare(right.id));
  for (const root of roots) visit(root.id, root.priority, root.id, [root.id]);

  return {
    effectivePriorityByIssueId: Object.fromEntries(
      [...effectivePriorityByIssueId.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
    paths,
    maximumDependencyDepth,
    depthLimitExceeded,
    cycleDetected,
  };
}

export function evaluateDeliveryIncidentLane(
  activeTechnicalPackageIssueIds: string[],
  maximumActiveTechnicalPackages = DELIVERY_CONTROL_CONTRACT_V1.incidentLane.maximumActiveTechnicalPackages,
) {
  const issueIds = [...new Set(activeTechnicalPackageIssueIds)].sort();
  const limit = Math.max(1, Math.floor(maximumActiveTechnicalPackages));
  return {
    issueIds,
    activeCount: issueIds.length,
    limit,
    availableSlots: Math.max(0, limit - issueIds.length),
    overLimit: issueIds.length > limit,
    excessIssueIds: issueIds.slice(limit),
  } as const;
}

const DELIVERY_CONTROL_ACTION_CLASS_SET = new Set<string>(
  DELIVERY_CONTROL_CONTRACT_V1.resourceControl.actionClasses,
);
const DELIVERY_CONTROL_EXCLUSIVE_ACTION_CLASS_SET = new Set<string>(
  DELIVERY_CONTROL_CONTRACT_V1.resourceControl.exclusiveLeaseRequired,
);

function requiredIdentifier(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function contractDate(value: Date | string, field: string) {
  const parsed = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid resource-control date for ${field}`);
  return parsed;
}

export function isDeliveryControlActionClass(value: string): value is DeliveryControlActionClass {
  return DELIVERY_CONTROL_ACTION_CLASS_SET.has(value);
}

export function deliveryControlActionClassRequiresLease(actionClass: DeliveryControlActionClass) {
  return DELIVERY_CONTROL_EXCLUSIVE_ACTION_CLASS_SET.has(actionClass);
}

export function normalizeDeliveryControlResourceKey(value: string | null | undefined) {
  const normalized = requiredIdentifier(value)?.replace(/\s+/g, " ");
  if (!normalized) return null;
  if (normalized.length > 512) throw new Error("Resource key must not exceed 512 characters");
  return normalized;
}

export function buildDeliveryControlResourceIdempotencyKey(input: {
  companyId: string;
  actionClass: DeliveryControlActionClass;
  resourceKey: string;
  changeId: string;
}) {
  const companyId = requiredIdentifier(input.companyId);
  const resourceKey = normalizeDeliveryControlResourceKey(input.resourceKey);
  const changeId = requiredIdentifier(input.changeId);
  if (!companyId || !resourceKey || !changeId) {
    throw new Error("Resource idempotency keys require companyId, resourceKey, and changeId");
  }
  return `resource_control:${companyId}:${input.actionClass}:${encodeURIComponent(resourceKey)}:${encodeURIComponent(changeId)}`;
}

export function evaluateDeliveryControlResourceLease(input: {
  actionClass: DeliveryControlActionClass;
  resourceKey?: string | null;
  runId: string;
  changeId?: string | null;
  idempotencyKey?: string | null;
  currentLease?: DeliveryControlResourceLeaseSnapshot | null;
  now?: Date | string;
}): DeliveryControlResourceLeaseDecision {
  const runId = requiredIdentifier(input.runId);
  if (!runId) {
    return { decision: "deny", resourceKey: null, blockingRunId: null, reason: "run_id_required" };
  }
  if (!deliveryControlActionClassRequiresLease(input.actionClass)) {
    return {
      decision: "parallel_safe",
      resourceKey: normalizeDeliveryControlResourceKey(input.resourceKey),
      blockingRunId: null,
      reason: "action_class_parallel_safe",
    };
  }

  const resourceKey = normalizeDeliveryControlResourceKey(input.resourceKey);
  const changeId = requiredIdentifier(input.changeId);
  const idempotencyKey = requiredIdentifier(input.idempotencyKey);
  if (!resourceKey) {
    return { decision: "deny", resourceKey: null, blockingRunId: null, reason: "resource_key_required" };
  }
  if (!changeId) {
    return { decision: "deny", resourceKey, blockingRunId: null, reason: "change_id_required" };
  }
  if (!idempotencyKey) {
    return { decision: "deny", resourceKey, blockingRunId: null, reason: "idempotency_key_required" };
  }

  const lease = input.currentLease ?? null;
  if (!lease) {
    return { decision: "acquire", resourceKey, blockingRunId: null, reason: "resource_available" };
  }
  if (lease.resourceKey !== resourceKey) {
    return { decision: "deny", resourceKey, blockingRunId: lease.ownerRunId, reason: "lease_resource_mismatch" };
  }
  if (lease.actionClass !== input.actionClass) {
    return { decision: "deny", resourceKey, blockingRunId: lease.ownerRunId, reason: "lease_action_class_mismatch" };
  }
  if (lease.idempotencyKey === idempotencyKey && lease.status === "completed") {
    if (!lease.targetStateReadback) {
      return {
        decision: "deny",
        resourceKey,
        blockingRunId: null,
        reason: "completed_lease_missing_target_state_readback",
      };
    }
    return {
      decision: "replay_completed",
      resourceKey,
      blockingRunId: null,
      reason: "idempotent_change_already_completed",
      targetStateReadback: lease.targetStateReadback,
    };
  }
  if (lease.status !== "active") {
    return { decision: "acquire", resourceKey, blockingRunId: null, reason: "prior_lease_terminal" };
  }
  if (lease.ownerRunId === runId) {
    if (lease.changeId !== changeId || lease.idempotencyKey !== idempotencyKey) {
      return { decision: "deny", resourceKey, blockingRunId: runId, reason: "owner_context_mismatch" };
    }
    return { decision: "owned", resourceKey, blockingRunId: null, reason: "lease_owned_by_run" };
  }

  const now = contractDate(input.now ?? new Date(), "now");
  const expiresAt = contractDate(lease.expiresAt, "currentLease.expiresAt");
  if (expiresAt.getTime() <= now.getTime()) {
    return {
      decision: "recovery_required",
      resourceKey,
      blockingRunId: lease.ownerRunId,
      reason: "expired_lease_requires_owner_and_target_state_recovery",
    };
  }
  return {
    decision: "wait",
    resourceKey,
    blockingRunId: lease.ownerRunId,
    reason: "resource_held_by_another_run",
  };
}

export function buildDeliveryControlResourceQueueTelemetry(
  entries: DeliveryControlResourceQueueEntry[],
): DeliveryControlResourceQueueTelemetryRecord[] {
  const normalized = entries.map((entry) => ({
    ...entry,
    resourceKey: normalizeDeliveryControlResourceKey(entry.resourceKey),
    waitingSinceAt: contractDate(entry.waitingSinceAt, "waitingSinceAt"),
    nextCheckAt: contractDate(entry.nextCheckAt, "nextCheckAt"),
  }));
  for (const entry of normalized) {
    if (!entry.resourceKey) throw new Error("Queue telemetry requires resourceKey");
    if (!requiredIdentifier(entry.runId)) throw new Error("Queue telemetry requires runId");
  }

  const positionByRunId = new Map<string, number>();
  const byResource = new Map<string, typeof normalized>();
  for (const entry of normalized) {
    const resourceEntries = byResource.get(entry.resourceKey!) ?? [];
    resourceEntries.push(entry);
    byResource.set(entry.resourceKey!, resourceEntries);
  }
  for (const resourceEntries of byResource.values()) {
    resourceEntries
      .sort((left, right) =>
        left.waitingSinceAt.getTime() - right.waitingSinceAt.getTime() || left.runId.localeCompare(right.runId))
      .forEach((entry, index) => positionByRunId.set(entry.runId, index + 1));
  }

  return normalized
    .map((entry) => ({
      runId: entry.runId,
      actionClass: entry.actionClass,
      resourceKey: entry.resourceKey!,
      waitReason: entry.waitReason,
      blockingRunId: entry.blockingRunId,
      waitingSinceAt: entry.waitingSinceAt.toISOString(),
      queuePosition: positionByRunId.get(entry.runId)!,
      nextCheckAt: entry.nextCheckAt.toISOString(),
    }))
    .sort((left, right) => left.resourceKey.localeCompare(right.resourceKey) || left.queuePosition - right.queuePosition);
}
