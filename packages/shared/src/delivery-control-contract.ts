import type { IssuePriority } from "./constants.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

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
      "human_owner",
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
