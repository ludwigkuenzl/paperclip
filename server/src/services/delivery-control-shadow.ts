import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvals,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueRelations,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  analyzeDeliveryCriticalPaths,
  buildDeliveryControlRecoveryWakeIdempotencyKey,
  deliveryControlPolicyForPriority,
  evaluateDeliveryIncidentLane,
  type IssuePriority,
} from "@paperclipai/shared";
import { parseObject, asNumber, asString } from "../adapters/utils.js";
import { logger } from "../middleware/logger.js";
import { evaluateAgentInvokabilityFromDb } from "./agent-invokability.js";
import { logActivity } from "./activity-log.js";
import {
  evaluateDeliveryCommunication,
  evaluateDeliveryControl,
  readDeliveryControlConfig,
  type DeliveryCommunicationSnapshot,
  type DeliveryControlEvaluation,
} from "./delivery-control.js";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import { issueService } from "./issues.js";

const DELIVERY_CONTROL_SCAN_LIMIT = 200;
const ACTIVE_RUN_STATUSES = ["running"] as const;
const ACTIVE_WAKE_STATUSES = ["queued", "deferred_issue_execution"] as const;
const PENDING_APPROVAL_STATUSES = ["pending", "revision_requested"] as const;
const DELIVERY_TRIGGER_WAKE_REASONS = [
  "issue_assigned",
  "issue_blockers_resolved",
  "approval_approved",
  "issue_commented",
  "issue_reopened_via_comment",
  "issue_status_changed",
] as const;
const DELIVERY_CONTROL_RECOVERY_CAUSE = "delivery_control_liveness";
const DELIVERY_CONTROL_EXHAUSTED_CAUSE = "delivery_control_liveness_exhausted";
const DELIVERY_CONTROL_OBSERVATION_ACTIONS = [
  "issue.delivery_control_shadow_finding",
  "issue.delivery_control_enforcement_observation",
] as const;
const DELIVERY_CONTROL_COMMUNICATION_ACTION = "issue.delivery_control_communication";
const DELIVERY_CONTROL_ESCALATION_ACTION = "issue.delivery_control_ceo_escalated";
const DELIVERY_CONTROL_BLOCKER_ACTION = "issue.delivery_control_blocker_created";

type DeliveryControlWakeup = (
  agentId: string,
  options: {
    source: "automation";
    triggerDetail: "system";
    reason: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
    requestedByActorType: "system";
    requestedByActorId: null;
    contextSnapshot: Record<string, unknown>;
  },
) => Promise<{ id: string } | null>;

export interface DeliveryControlEnforcementDependencies {
  enqueueWakeup: DeliveryControlWakeup;
}

function observationFingerprint(evaluation: DeliveryControlEvaluation) {
  const payload = JSON.stringify({
    contractVersion: evaluation.contractVersion,
    priority: evaluation.priority,
    phase: evaluation.phase,
    livenessState: evaluation.livenessState,
    startSla: {
      status: evaluation.startSla.status,
      deadlineAt: evaluation.startSla.deadlineAt,
      observedStartAt: evaluation.startSla.observedStartAt,
    },
    recovery: evaluation.recovery,
    escalation: evaluation.escalation,
    audit: evaluation.audit,
    nextCheckAt: evaluation.nextCheckAt,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function deliveryControlObservationFingerprint(evaluation: DeliveryControlEvaluation) {
  return observationFingerprint(evaluation);
}

function auditSafeContractVersion(version: string) {
  const [major, minor, patch] = version.split(".").map((segment) => Number(segment));
  return { major, minor, patch };
}

async function latestRunForIssue(db: Db, issue: typeof issues.$inferSelect) {
  return db
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      lastOutputAt: heartbeatRuns.lastOutputAt,
      lastUsefulActionAt: heartbeatRuns.lastUsefulActionAt,
      contextSnapshot: heartbeatRuns.contextSnapshot,
      createdAt: heartbeatRuns.createdAt,
    })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, issue.companyId),
      or(
        issue.executionRunId ? eq(heartbeatRuns.id, issue.executionRunId) : undefined,
        issue.checkoutRunId ? eq(heartbeatRuns.id, issue.checkoutRunId) : undefined,
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`,
        sql`${heartbeatRuns.contextSnapshot}->>'taskId' = ${issue.id}`,
      ),
    ))
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

async function latestQueuedWakeForIssue(db: Db, issue: typeof issues.$inferSelect) {
  return db
    .select({
      id: agentWakeupRequests.id,
      requestedAt: agentWakeupRequests.requestedAt,
    })
    .from(agentWakeupRequests)
    .where(and(
      eq(agentWakeupRequests.companyId, issue.companyId),
      inArray(agentWakeupRequests.status, [...ACTIVE_WAKE_STATUSES]),
      sql`${agentWakeupRequests.runId} is null`,
      or(
        sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`,
        sql`${agentWakeupRequests.payload}->>'taskId' = ${issue.id}`,
        sql`${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'issueId' = ${issue.id}`,
        sql`${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'taskId' = ${issue.id}`,
      ),
    ))
    .orderBy(desc(agentWakeupRequests.requestedAt), desc(agentWakeupRequests.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

async function latestDeliveryTriggerWakeForIssue(db: Db, issue: typeof issues.$inferSelect) {
  return db
    .select({ requestedAt: agentWakeupRequests.requestedAt })
    .from(agentWakeupRequests)
    .where(and(
      eq(agentWakeupRequests.companyId, issue.companyId),
      inArray(agentWakeupRequests.reason, [...DELIVERY_TRIGGER_WAKE_REASONS]),
      or(
        sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`,
        sql`${agentWakeupRequests.payload}->>'taskId' = ${issue.id}`,
        sql`${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'issueId' = ${issue.id}`,
        sql`${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'taskId' = ${issue.id}`,
      ),
    ))
    .orderBy(desc(agentWakeupRequests.requestedAt), desc(agentWakeupRequests.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

function latestDate(values: Array<Date | null | undefined>) {
  return values
    .filter((value): value is Date => value instanceof Date)
    .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;
}

async function evaluateIssue(
  db: Db,
  issue: typeof issues.$inferSelect,
  effectivePriority: IssuePriority,
  now: Date,
  hasLiveDependencyPath: boolean,
) {
  const [
    latestRun,
    latestWake,
    latestTriggerWake,
    latestUserComment,
    latestStatusChange,
    pendingInteraction,
    acceptedInteraction,
    pendingApproval,
    approvedApproval,
    recoveryAction,
  ] = await Promise.all([
    latestRunForIssue(db, issue),
    latestQueuedWakeForIssue(db, issue),
    latestDeliveryTriggerWakeForIssue(db, issue),
    db
      .select({ createdAt: issueComments.createdAt })
      .from(issueComments)
      .where(and(
        eq(issueComments.companyId, issue.companyId),
        eq(issueComments.issueId, issue.id),
        isNotNull(issueComments.authorUserId),
        isNull(issueComments.deletedAt),
      ))
      .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({ createdAt: activityLog.createdAt })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, issue.companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, issue.id),
        eq(activityLog.action, "issue.updated"),
        sql`${activityLog.details} ? 'status'`,
      ))
      .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({ id: issueThreadInteractions.id, createdAt: issueThreadInteractions.createdAt })
      .from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.companyId, issue.companyId),
        eq(issueThreadInteractions.issueId, issue.id),
        eq(issueThreadInteractions.status, "pending"),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({ resolvedAt: issueThreadInteractions.resolvedAt })
      .from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.companyId, issue.companyId),
        eq(issueThreadInteractions.issueId, issue.id),
        eq(issueThreadInteractions.status, "accepted"),
      ))
      .orderBy(desc(issueThreadInteractions.resolvedAt), desc(issueThreadInteractions.id))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({ id: approvals.id, createdAt: approvals.createdAt })
      .from(issueApprovals)
      .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
      .where(and(
        eq(issueApprovals.companyId, issue.companyId),
        eq(issueApprovals.issueId, issue.id),
        inArray(approvals.status, [...PENDING_APPROVAL_STATUSES]),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({ decidedAt: approvals.decidedAt })
      .from(issueApprovals)
      .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
      .where(and(
        eq(issueApprovals.companyId, issue.companyId),
        eq(issueApprovals.issueId, issue.id),
        eq(approvals.status, "approved"),
      ))
      .orderBy(desc(approvals.decidedAt), desc(approvals.id))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({
        id: issueRecoveryActions.id,
        cause: issueRecoveryActions.cause,
        status: issueRecoveryActions.status,
        ownerType: issueRecoveryActions.ownerType,
        ownerAgentId: issueRecoveryActions.ownerAgentId,
        ownerUserId: issueRecoveryActions.ownerUserId,
        attemptCount: issueRecoveryActions.attemptCount,
        timeoutAt: issueRecoveryActions.timeoutAt,
        lastAttemptAt: issueRecoveryActions.lastAttemptAt,
      })
      .from(issueRecoveryActions)
      .where(and(
        eq(issueRecoveryActions.companyId, issue.companyId),
        eq(issueRecoveryActions.sourceIssueId, issue.id),
        inArray(issueRecoveryActions.status, ["active", "escalated"]),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ]);

  const triggerAt = latestDate([
    issue.createdAt,
    latestTriggerWake?.requestedAt,
    latestUserComment?.createdAt,
    latestStatusChange?.createdAt,
    acceptedInteraction?.resolvedAt,
    approvedApproval?.decidedAt,
  ]) ?? issue.createdAt;
  const phaseRun = latestRun && latestRun.createdAt.getTime() >= triggerAt.getTime() ? latestRun : null;
  const phaseWake = latestWake && latestWake.requestedAt.getTime() >= triggerAt.getTime() ? latestWake : null;
  const runContext = parseObject(phaseRun?.contextSnapshot);
  const deliveryRecoveryAction = recoveryAction?.cause === DELIVERY_CONTROL_RECOVERY_CAUSE ||
    recoveryAction?.cause === DELIVERY_CONTROL_EXHAUSTED_CAUSE;
  const recoveryAttemptCount = Math.max(
    deliveryRecoveryAction ? recoveryAction?.attemptCount ?? 0 : 0,
    Math.max(0, Math.floor(asNumber(runContext.deliveryControlRecoveryAttempt, 0))),
  );
  const hasActiveRun = Boolean(
    phaseRun && ACTIVE_RUN_STATUSES.includes(phaseRun.status as (typeof ACTIVE_RUN_STATUSES)[number]),
  );
  const executionLockCoherent = !hasActiveRun || Boolean(
    phaseRun && (issue.executionRunId === phaseRun.id || issue.checkoutRunId === phaseRun.id),
  );
  const hasQueuedExecution = phaseRun?.status === "queued";
  const policy = deliveryControlPolicyForPriority(effectivePriority);
  const waitingPathFreshnessMs = policy?.escalationAfterMs ?? 0;
  const pendingInteractionIsFresh = Boolean(
    pendingInteraction && pendingInteraction.createdAt.getTime() + waitingPathFreshnessMs > now.getTime(),
  );
  const pendingApprovalIsFresh = Boolean(
    pendingApproval && pendingApproval.createdAt.getTime() + waitingPathFreshnessMs > now.getTime(),
  );
  const recoveryActionHasNextCheck = Boolean(
    recoveryAction?.timeoutAt && recoveryAction.timeoutAt.getTime() > now.getTime(),
  );

  const evaluation = evaluateDeliveryControl({
    issueId: issue.id,
    companyId: issue.companyId,
    priority: effectivePriority,
    status: issue.status,
    triggerAt,
    queuedAt: phaseWake?.requestedAt ?? phaseRun?.createdAt ?? null,
    runStartedAt: phaseRun?.startedAt ?? null,
    resultAt: phaseRun?.finishedAt ?? null,
    lastProgressAt: phaseRun?.lastUsefulActionAt ?? null,
    recoveryAttemptCount,
    hasActiveRun,
    hasQueuedWake: Boolean(phaseWake || hasQueuedExecution),
    queueCapacityAvailable: hasQueuedExecution,
    executionLockCoherent,
    hasScheduledRetry: phaseRun?.status === "scheduled_retry",
    hasScheduledMonitor: Boolean(issue.monitorNextCheckAt && issue.monitorNextCheckAt.getTime() > now.getTime()),
    hasTypedReviewOrApproval: pendingInteractionIsFresh || pendingApprovalIsFresh,
    hasLiveDependencyPath,
    hasExplicitRecoveryAction: recoveryActionHasNextCheck,
    hasUnscheduledRecoveryAction: Boolean(recoveryAction && !recoveryActionHasNextCheck),
    now,
  });
  return {
    evaluation,
    latestRunId: phaseRun?.id ?? null,
    pendingUserDecision: Boolean(pendingInteraction),
    recoveryAction,
    hasLiveDependencyPath,
  };
}

async function recordObservation(
  db: Db,
  evaluation: DeliveryControlEvaluation,
  effectiveMode: "shadow" | "enforce",
) {
  const fingerprint = observationFingerprint(evaluation);
  const action = effectiveMode === "shadow"
    ? "issue.delivery_control_shadow_finding"
    : "issue.delivery_control_enforcement_observation";
  const lockKey = `delivery_control:${evaluation.companyId}:${evaluation.issueId}:${action}`;

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    const existing = await tx
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, evaluation.companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, evaluation.issueId),
        eq(activityLog.action, action),
        sql`${activityLog.details}->>'fingerprint' = ${fingerprint}`,
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existing) return false;

    await logActivity(tx as unknown as Db, {
      companyId: evaluation.companyId,
      actorType: "system",
      actorId: "delivery_control",
      action,
      entityType: "issue",
      entityId: evaluation.issueId,
      details: {
        fingerprint,
        effectiveMode,
        contractId: evaluation.contractId,
        // Dotted numeric strings are intentionally redacted by the generic JWT
        // sanitizer, so keep the exact semantic version as numeric audit fields.
        contractVersion: auditSafeContractVersion(evaluation.contractVersion),
        priority: evaluation.priority,
        phase: evaluation.phase,
        livenessState: evaluation.livenessState,
        startSla: evaluation.startSla,
        recovery: evaluation.recovery,
        escalation: evaluation.escalation,
        nextCheckAt: evaluation.nextCheckAt,
        audit: evaluation.audit,
      },
    });
    return true;
  });
}

function priorityRank(priority: IssuePriority) {
  if (priority === "critical") return 3;
  if (priority === "high") return 2;
  if (priority === "medium") return 1;
  return 0;
}

async function recordDeliveryControlEventOnce(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    action: string;
    eventKey: string;
    details: Record<string, unknown>;
    agentId?: string | null;
    runId?: string | null;
  },
) {
  const lockKey = `delivery_control_event:${input.companyId}:${input.eventKey}`;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    const existing = await tx
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, input.issueId),
        eq(activityLog.action, input.action),
        sql`${activityLog.details}->>'eventKey' = ${input.eventKey}`,
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existing) return false;
    await logActivity(tx as unknown as Db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: "delivery_control",
      agentId: input.agentId ?? null,
      runId: input.runId ?? null,
      action: input.action,
      entityType: "issue",
      entityId: input.issueId,
      details: { eventKey: input.eventKey, ...input.details },
    });
    return true;
  });
}

type CandidateIssue = typeof issues.$inferSelect & { effectivePriority: IssuePriority };

async function buildFairCandidatePool(
  db: Db,
  opts: { companyId?: string | null; limit: number; issueCreatedAtGte?: Date | null },
) {
  const graphIssues = await db
    .select()
    .from(issues)
    .where(and(
      visibleIssueCondition(),
      isNull(issues.hiddenAt),
      inArray(issues.status, ["backlog", "todo", "in_progress", "in_review", "blocked"]),
      opts.companyId ? eq(issues.companyId, opts.companyId) : undefined,
      opts.issueCreatedAtGte ? gte(issues.createdAt, opts.issueCreatedAtGte) : undefined,
    ));
  const graphIssueIds = new Set(graphIssues.map((issue) => issue.id));
  const relations = graphIssues.length === 0
    ? []
    : await db
      .select({
        companyId: issueRelations.companyId,
        blockerIssueId: issueRelations.issueId,
        blockedIssueId: issueRelations.relatedIssueId,
      })
      .from(issueRelations)
      .where(and(
        eq(issueRelations.type, "blocks"),
        opts.companyId ? eq(issueRelations.companyId, opts.companyId) : undefined,
      ));

  const issuesByCompanyId = new Map<string, typeof graphIssues>();
  for (const issue of graphIssues) {
    const companyIssues = issuesByCompanyId.get(issue.companyId) ?? [];
    companyIssues.push(issue);
    issuesByCompanyId.set(issue.companyId, companyIssues);
  }
  const effectivePriorityByIssueId = new Map<string, IssuePriority>();
  const incidentLaneFindings: Array<{
    companyId: string;
    rootIssueId: string;
    activeTechnicalPackageIssueIds: string[];
    excessIssueIds: readonly string[];
    depthLimitExceeded: boolean;
    cycleDetected: boolean;
  }> = [];
  for (const [companyId, companyIssues] of issuesByCompanyId) {
    const analysis = analyzeDeliveryCriticalPaths({
      nodes: companyIssues.map((issue) => ({ id: issue.id, priority: issue.priority as IssuePriority })),
      edges: relations
        .filter((relation) => relation.companyId === companyId)
        .filter((relation) => graphIssueIds.has(relation.blockerIssueId) && graphIssueIds.has(relation.blockedIssueId))
        .map((relation) => ({
          blockerIssueId: relation.blockerIssueId,
          blockedIssueId: relation.blockedIssueId,
        })),
    });
    for (const [issueId, priority] of Object.entries(analysis.effectivePriorityByIssueId)) {
      effectivePriorityByIssueId.set(issueId, priority);
    }

    const issueById = new Map(companyIssues.map((issue) => [issue.id, issue]));
    for (const root of companyIssues.filter((issue) => issue.priority === "critical")) {
      const rootPaths = analysis.paths.filter((path) => path.rootIssueId === root.id);
      const activeTechnicalPackageIssueIds = [...new Set(
        rootPaths
          .flatMap((path) => path.issueIds)
          .filter((issueId) => issueId !== root.id)
          .filter((issueId) => {
            const status = issueById.get(issueId)?.status;
            return status === "in_progress" || status === "in_review";
          }),
      )];
      const lane = evaluateDeliveryIncidentLane(activeTechnicalPackageIssueIds);
      const depthLimitExceeded = rootPaths.some((path) => path.truncated && !path.cycle);
      const cycleDetected = rootPaths.some((path) => path.cycle);
      if (lane.overLimit || depthLimitExceeded || cycleDetected) {
        incidentLaneFindings.push({
          companyId,
          rootIssueId: root.id,
          activeTechnicalPackageIssueIds,
          excessIssueIds: lane.excessIssueIds,
          depthLimitExceeded,
          cycleDetected,
        });
      }
    }
  }

  const actionable = graphIssues
    .filter((issue) => issue.status !== "backlog")
    .map((issue): CandidateIssue => ({
      ...issue,
      effectivePriority: effectivePriorityByIssueId.get(issue.id) ?? issue.priority as IssuePriority,
    }))
    .filter((issue) => issue.effectivePriority === "critical" || issue.effectivePriority === "high");
  const lastScans = actionable.length === 0
    ? []
    : await db
      .select({
        issueId: activityLog.entityId,
        scannedAt: sql<Date>`max(${activityLog.createdAt})`,
      })
      .from(activityLog)
      .where(and(
        eq(activityLog.entityType, "issue"),
        inArray(activityLog.action, [...DELIVERY_CONTROL_OBSERVATION_ACTIONS]),
        opts.companyId ? eq(activityLog.companyId, opts.companyId) : undefined,
      ))
      .groupBy(activityLog.entityId);
  const lastScanByIssueId = new Map(lastScans.map((row) => [row.issueId, row.scannedAt]));
  actionable.sort((left, right) => {
    const leftOff = readDeliveryControlConfig(left.companyId).effectiveMode === "off" ? 1 : 0;
    const rightOff = readDeliveryControlConfig(right.companyId).effectiveMode === "off" ? 1 : 0;
    const leftScannedAt = lastScanByIssueId.get(left.id);
    const rightScannedAt = lastScanByIssueId.get(right.id);
    const leftScan = leftScannedAt ? new Date(leftScannedAt).getTime() : Number.NEGATIVE_INFINITY;
    const rightScan = rightScannedAt ? new Date(rightScannedAt).getTime() : Number.NEGATIVE_INFINITY;
    return leftOff - rightOff ||
      leftScan - rightScan ||
      priorityRank(right.effectivePriority) - priorityRank(left.effectivePriority) ||
      left.createdAt.getTime() - right.createdAt.getTime() ||
      left.id.localeCompare(right.id);
  });
  return {
    candidates: actionable.slice(0, opts.limit),
    graphIssues,
    effectivePriorityByIssueId,
    incidentLaneFindings,
  };
}

async function recordGraphControls(
  db: Db,
  input: Awaited<ReturnType<typeof buildFairCandidatePool>>,
) {
  let priorityPropagated = 0;
  let incidentLaneFindings = 0;
  for (const issue of input.graphIssues) {
    const effectivePriority = input.effectivePriorityByIssueId.get(issue.id) ?? issue.priority as IssuePriority;
    if (priorityRank(effectivePriority) <= priorityRank(issue.priority as IssuePriority)) continue;
    const config = readDeliveryControlConfig(issue.companyId, { issueId: issue.id });
    if (config.effectiveMode === "off") continue;
    const eventKey = `delivery_control_priority:${issue.id}:${issue.priority}:${effectivePriority}`;
    if (config.effectiveMode === "enforce") {
      await db
        .update(issues)
        .set({ priority: effectivePriority, updatedAt: new Date() })
        .where(and(
          eq(issues.id, issue.id),
          eq(issues.companyId, issue.companyId),
          eq(issues.priority, issue.priority),
        ));
    }
    const recorded = await recordDeliveryControlEventOnce(db, {
      companyId: issue.companyId,
      issueId: issue.id,
      action: config.effectiveMode === "enforce"
        ? "issue.delivery_control_priority_propagated"
        : "issue.delivery_control_priority_shadow_finding",
      eventKey,
      details: {
        effectiveMode: config.effectiveMode,
        previousPriority: issue.priority,
        effectivePriority,
      },
    });
    if (recorded && config.effectiveMode === "enforce") priorityPropagated += 1;
  }
  for (const finding of input.incidentLaneFindings) {
    const config = readDeliveryControlConfig(finding.companyId, { issueId: finding.rootIssueId });
    if (config.effectiveMode === "off") continue;
    const fingerprint = createHash("sha256").update(JSON.stringify(finding)).digest("hex");
    const recorded = await recordDeliveryControlEventOnce(db, {
      companyId: finding.companyId,
      issueId: finding.rootIssueId,
      action: config.effectiveMode === "enforce"
        ? "issue.delivery_control_incident_lane_violation"
        : "issue.delivery_control_incident_lane_shadow_finding",
      eventKey: `delivery_control_incident_lane:${finding.rootIssueId}:${fingerprint}`,
      details: {
        effectiveMode: config.effectiveMode,
        activeTechnicalPackageIssueIds: finding.activeTechnicalPackageIssueIds,
        excessIssueIds: finding.excessIssueIds,
        depthLimitExceeded: finding.depthLimitExceeded,
        cycleDetected: finding.cycleDetected,
      },
    });
    if (recorded) incidentLaneFindings += 1;
  }
  return { priorityPropagated, incidentLaneFindings };
}

function deliveryCommunicationSnapshot(
  evaluation: DeliveryControlEvaluation,
  input: {
    owner: string;
    pendingUserDecision: boolean;
    recoveryCause?: string | null;
    liveAcceptance?: boolean;
    now: Date;
  },
): DeliveryCommunicationSnapshot {
  const policy = deliveryControlPolicyForPriority(evaluation.priority)!;
  const nextCheckAt = evaluation.nextCheckAt ?? new Date(
    input.now.getTime() + policy.communicationMaxGapMs,
  ).toISOString();
  const blocked = evaluation.livenessState === "stalled" || evaluation.livenessState === "needs_attention";
  const currentAction = evaluation.recovery.status === "due"
    ? "Dispatching bounded liveness recovery"
    : evaluation.recovery.status === "exhausted"
      ? "Waiting for the first-class recovery blocker to be cleared"
      : evaluation.phase === "active"
        ? "Running the assigned delivery step"
        : evaluation.phase === "review"
          ? "Waiting on the typed review or approval path"
          : evaluation.phase === "waiting"
            ? "Waiting on the explicit dependency or monitor path"
            : "Waiting for executable delivery capacity";
  return {
    issueId: evaluation.issueId,
    priority: evaluation.priority,
    phase: evaluation.phase,
    livenessState: evaluation.livenessState,
    startSlaStatus: evaluation.startSla.status,
    recoveryStatus: evaluation.recovery.status,
    escalationStatus: evaluation.escalation.status,
    blockerFingerprint: blocked
      ? [evaluation.livenessState, evaluation.recovery.status, input.recoveryCause ?? "no_executable_path"].join(":")
      : null,
    userDecisionPending: input.pendingUserDecision,
    liveAcceptance: input.liveAcceptance === true,
    lastProgressAt: evaluation.lastProgressAt,
    completed: evaluation.lastProgressAt
      ? `Useful progress observed at ${evaluation.lastProgressAt}`
      : `Delivery phase measured as ${evaluation.phase}`,
    currentAction: input.liveAcceptance ? "Live acceptance recorded; delivery watchdog closed" : currentAction,
    remaining: input.liveAcceptance
      ? "No remaining delivery-control action"
      : blocked
      ? "Restore an executable owner, wake, review, monitor, or dependency path"
      : "Complete the remaining delivery path and live acceptance",
    owner: input.owner,
    nextCheckAt,
  };
}

function readCommunicationSnapshot(value: unknown): DeliveryCommunicationSnapshot | null {
  const snapshot = parseObject(value);
  return asString(snapshot.issueId, "") ? snapshot as unknown as DeliveryCommunicationSnapshot : null;
}

async function resolveOwnerLabel(
  db: Db,
  issue: CandidateIssue,
  recoveryAction: { ownerAgentId: string | null; ownerUserId: string | null; ownerType: string } | null,
) {
  const ownerAgentId = recoveryAction?.ownerAgentId ?? issue.assigneeAgentId;
  if (ownerAgentId) {
    const owner = await db
      .select({ name: agents.name })
      .from(agents)
      .where(and(eq(agents.id, ownerAgentId), eq(agents.companyId, issue.companyId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (owner) return owner.name;
  }
  return recoveryAction?.ownerUserId ?? issue.assigneeUserId ?? recoveryAction?.ownerType ?? "Paperclip board";
}

async function emitDeliveryCommunication(
  db: Db,
  issue: CandidateIssue,
  state: Awaited<ReturnType<typeof evaluateIssue>>,
  now: Date,
  liveAcceptance = false,
) {
  const latest = await db
    .select({ details: activityLog.details, createdAt: activityLog.createdAt })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, issue.companyId),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, issue.id),
      eq(activityLog.action, DELIVERY_CONTROL_COMMUNICATION_ACTION),
    ))
    .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const latestDetails = parseObject(latest?.details);
  const snapshot = deliveryCommunicationSnapshot(state.evaluation, {
    owner: await resolveOwnerLabel(db, issue, state.recoveryAction),
    pendingUserDecision: state.pendingUserDecision,
    recoveryCause: state.recoveryAction?.cause,
    liveAcceptance,
    now,
  });
  const communication = evaluateDeliveryCommunication({
    current: snapshot,
    previous: readCommunicationSnapshot(latestDetails.snapshot),
    lastEmittedFingerprint: asString(latestDetails.fingerprint, "") || null,
    lastEmittedAt: latest?.createdAt ?? null,
    now,
  });
  if (!communication.emit || !communication.eventKey || !communication.payload || !communication.reason) return false;
  const eventKey = communication.eventKey;
  const payload = communication.payload;
  const reason = communication.reason;

  const issuesApi = issueService(db);
  const lockKey = `delivery_control_communication:${issue.companyId}:${eventKey}`;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    const duplicate = await tx
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, issue.companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, issue.id),
        eq(activityLog.action, DELIVERY_CONTROL_COMMUNICATION_ACTION),
        sql`${activityLog.details}->>'eventKey' = ${eventKey}`,
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (duplicate) return false;
    const comment = await issuesApi.addComment(
      issue.id,
      [
        `Delivery Control update (${reason})`,
        "",
        `- Completed: ${payload.completed}`,
        `- Current action: ${payload.currentAction}`,
        `- Remaining: ${payload.remaining}`,
        `- Owner: ${payload.owner}`,
        `- Next automatic check: ${payload.nextCheckAt}`,
      ].join("\n"),
      {},
      { authorType: "system" },
      tx,
    );
    await logActivity(tx as unknown as Db, {
      companyId: issue.companyId,
      actorType: "system",
      actorId: "delivery_control",
      action: DELIVERY_CONTROL_COMMUNICATION_ACTION,
      entityType: "issue",
      entityId: issue.id,
      details: {
        eventKey,
        fingerprint: communication.fingerprint,
        reason,
        payload,
        snapshot,
        commentId: comment.id,
      },
    });
    return true;
  });
}

function isDeliveryControlRecoveryCause(cause: string | null | undefined) {
  return cause === DELIVERY_CONTROL_RECOVERY_CAUSE || cause === DELIVERY_CONTROL_EXHAUSTED_CAUSE;
}

async function enqueueBoundedDeliveryRecovery(
  db: Db,
  deps: DeliveryControlEnforcementDependencies,
  issue: CandidateIssue,
  state: Awaited<ReturnType<typeof evaluateIssue>>,
  now: Date,
) {
  if (!issue.assigneeAgentId) return { enqueued: false, missingOwner: true, conflictingAction: false };
  const assigneeAgentId = issue.assigneeAgentId;
  if (!await isInvokableAgent(db, issue.companyId, assigneeAgentId)) {
    return { enqueued: false, missingOwner: true, conflictingAction: false };
  }
  const policy = deliveryControlPolicyForPriority(state.evaluation.priority)!;
  const recoveryActions = issueRecoveryActionService(db);
  const lockKey = `delivery_control_recovery:${issue.companyId}:${issue.id}`;
  const reservation = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    const current = await recoveryActions.getActiveForIssue(issue.companyId, issue.id, tx);
    if (current && !isDeliveryControlRecoveryCause(current.cause)) {
      return { kind: "conflicting_action" as const };
    }
    if (
      current &&
      (
        current.attemptCount >= state.evaluation.recovery.maximumAttempts ||
        Boolean(current.timeoutAt && new Date(current.timeoutAt).getTime() > now.getTime())
      )
    ) {
      return { kind: "not_due" as const };
    }
    const attempt = (current?.attemptCount ?? 0) + 1;
    if (attempt > state.evaluation.recovery.maximumAttempts) {
      return { kind: "not_due" as const };
    }
    const timeoutAt = new Date(now.getTime() + policy.recoveryAfterMs);
    const action = await recoveryActions.upsertSourceScoped({
      companyId: issue.companyId,
      sourceIssueId: issue.id,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: assigneeAgentId,
      previousOwnerAgentId: assigneeAgentId,
      returnOwnerAgentId: assigneeAgentId,
      cause: DELIVERY_CONTROL_RECOVERY_CAUSE,
      fingerprint: `${state.evaluation.triggerAt}:${state.evaluation.priority}`,
      evidence: {
        contractId: state.evaluation.contractId,
        contractVersion: state.evaluation.contractVersion,
        livenessState: state.evaluation.livenessState,
        startSla: state.evaluation.startSla,
        recovery: state.evaluation.recovery,
        escalation: state.evaluation.escalation,
        latestRunId: state.latestRunId,
      },
      nextAction: "Restore useful progress or persist an executable review, dependency, monitor, or owner path.",
      wakePolicy: {
        type: "bounded_delivery_control_recovery",
        maximumAttempts: state.evaluation.recovery.maximumAttempts,
      },
      monitorPolicy: { nextCheckAt: timeoutAt.toISOString() },
      maxAttempts: state.evaluation.recovery.maximumAttempts,
      timeoutAt,
      lastAttemptAt: now,
    }, tx);
    return {
      kind: "reserved" as const,
      actionId: action.id,
      attempt,
      timeoutAt,
      idempotencyKey: buildDeliveryControlRecoveryWakeIdempotencyKey({
        issueId: issue.id,
        reason: DELIVERY_CONTROL_RECOVERY_CAUSE,
        sourceRunId: state.latestRunId,
        attempt,
      }),
    };
  });
  if (reservation.kind === "conflicting_action") {
    return { enqueued: false, missingOwner: false, conflictingAction: true };
  }
  if (reservation.kind === "not_due") {
    return { enqueued: false, missingOwner: false, conflictingAction: false };
  }
  const queued = await deps.enqueueWakeup(assigneeAgentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "issue_assignment_recovery",
    idempotencyKey: reservation.idempotencyKey,
    payload: {
      issueId: issue.id,
      recoveryActionId: reservation.actionId,
      deliveryControlRecoveryAttempt: reservation.attempt,
      retryOfRunId: state.latestRunId,
    },
    requestedByActorType: "system",
    requestedByActorId: null,
    contextSnapshot: {
      issueId: issue.id,
      taskId: issue.id,
      wakeReason: "issue_assignment_recovery",
      retryReason: DELIVERY_CONTROL_RECOVERY_CAUSE,
      source: "delivery_control.reconcile",
      recoveryActionId: reservation.actionId,
      deliveryControlRecoveryAttempt: reservation.attempt,
      retryOfRunId: state.latestRunId,
    },
  });
  if (!queued) throw new Error(`Delivery-control recovery wake was suppressed for issue ${issue.id}`);
  await recordDeliveryControlEventOnce(db, {
    companyId: issue.companyId,
    issueId: issue.id,
    action: "issue.delivery_control_recovery_wake_enqueued",
    eventKey: reservation.idempotencyKey,
    agentId: assigneeAgentId,
    runId: queued.id,
    details: {
      recoveryActionId: reservation.actionId,
      attempt: reservation.attempt,
      maximumAttempts: state.evaluation.recovery.maximumAttempts,
      nextCheckAt: reservation.timeoutAt.toISOString(),
      sourceRunId: state.latestRunId,
    },
  });
  return { enqueued: true, missingOwner: false, conflictingAction: false };
}

async function isInvokableAgent(db: Db, companyId: string, agentId: string) {
  const candidate = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      reportsTo: agents.reportsTo,
      status: agents.status,
    })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return (await evaluateAgentInvokabilityFromDb(db, candidate)).invokable;
}

async function findCeoAgent(db: Db, companyId: string) {
  const candidates = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      reportsTo: agents.reportsTo,
      status: agents.status,
    })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")))
    .orderBy(agents.createdAt, agents.id);
  for (const candidate of candidates) {
    if ((await evaluateAgentInvokabilityFromDb(db, candidate)).invokable) return candidate;
  }
  return null;
}

async function ensureCeoEscalation(
  db: Db,
  deps: DeliveryControlEnforcementDependencies,
  issue: CandidateIssue,
  state: Awaited<ReturnType<typeof evaluateIssue>>,
) {
  const eventKey = `delivery_control_escalation:${issue.id}:${state.evaluation.triggerAt}`;
  const lockKey = `delivery_control_escalation:${issue.companyId}:${issue.id}`;
  const recoveryActions = issueRecoveryActionService(db);
  const ceo = await findCeoAgent(db, issue.companyId);
  const reservation = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    const current = await recoveryActions.getActiveForIssue(issue.companyId, issue.id, tx);
    if (current && isDeliveryControlRecoveryCause(current.cause)) {
      await tx
        .update(issueRecoveryActions)
        .set({
          status: "escalated",
          ownerType: ceo ? "agent" : "board",
          ownerAgentId: ceo?.id ?? null,
          ownerUserId: null,
          nextAction: "CEO or board must restore an executable delivery path and confirm the next automatic check.",
          updatedAt: new Date(),
        })
        .where(eq(issueRecoveryActions.id, current.id));
    }
    const existing = await tx
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, issue.companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, issue.id),
        eq(activityLog.action, DELIVERY_CONTROL_ESCALATION_ACTION),
        sql`${activityLog.details}->>'eventKey' = ${eventKey}`,
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return existing
      ? { needed: false as const, recoveryActionId: current?.id ?? null }
      : { needed: true as const, recoveryActionId: current?.id ?? null };
  });
  if (!reservation.needed) return false;
  let escalationRunId: string | null = null;
  const coalescedWithAssigneeRecovery = Boolean(ceo && ceo.id === issue.assigneeAgentId);
  if (ceo && !coalescedWithAssigneeRecovery) {
    const queued = await deps.enqueueWakeup(ceo.id, {
      source: "automation",
      triggerDetail: "system",
      reason: "source_scoped_recovery_action",
      idempotencyKey: eventKey,
      payload: {
        issueId: issue.id,
        sourceIssueId: issue.id,
        recoveryActionId: reservation.recoveryActionId,
        recoveryCause: DELIVERY_CONTROL_RECOVERY_CAUSE,
      },
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: {
        issueId: issue.id,
        taskId: issue.id,
        wakeReason: "source_scoped_recovery_action",
        skipIssueComment: true,
        source: "delivery_control.escalation",
        recoveryActionId: reservation.recoveryActionId,
        sourceIssueId: issue.id,
        recoveryCause: DELIVERY_CONTROL_RECOVERY_CAUSE,
      },
    });
    if (!queued) throw new Error(`Delivery-control CEO escalation wake was suppressed for issue ${issue.id}`);
    escalationRunId = queued.id;
  }
  return recordDeliveryControlEventOnce(db, {
    companyId: issue.companyId,
    issueId: issue.id,
    action: DELIVERY_CONTROL_ESCALATION_ACTION,
    eventKey,
    agentId: ceo?.id ?? null,
    runId: escalationRunId,
    details: {
      ownerType: ceo ? "agent" : "board",
      ownerAgentId: ceo?.id ?? null,
      recoveryActionId: reservation.recoveryActionId,
      escalationDueAt: state.evaluation.escalation.dueAt,
      coalescedWithAssigneeRecovery,
    },
  });
}

async function ensureFirstClassDeliveryBlocker(
  db: Db,
  issue: CandidateIssue,
  state: Awaited<ReturnType<typeof evaluateIssue>>,
  reason: "attempts_exhausted" | "missing_recovery_owner" | "conflicting_recovery_action",
) {
  const eventKey = `delivery_control_blocker:${issue.id}:${state.evaluation.triggerAt}:${reason}`;
  const lockKey = `delivery_control_blocker:${issue.companyId}:${issue.id}`;
  const issuesApi = issueService(db);
  const recoveryActions = issueRecoveryActionService(db);
  const ceo = await findCeoAgent(db, issue.companyId);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    const existing = await tx
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, issue.companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, issue.id),
        eq(activityLog.action, DELIVERY_CONTROL_BLOCKER_ACTION),
        sql`${activityLog.details}->>'eventKey' = ${eventKey}`,
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existing) return false;
    let action = await recoveryActions.getActiveForIssue(issue.companyId, issue.id, tx);
    if (!action) {
      action = await recoveryActions.upsertSourceScoped({
        companyId: issue.companyId,
        sourceIssueId: issue.id,
        kind: "issue_graph_liveness",
        ownerType: ceo ? "agent" : "board",
        ownerAgentId: ceo?.id ?? null,
        previousOwnerAgentId: issue.assigneeAgentId,
        returnOwnerAgentId: issue.assigneeAgentId,
        cause: DELIVERY_CONTROL_EXHAUSTED_CAUSE,
        fingerprint: `${state.evaluation.triggerAt}:${reason}`,
        evidence: { reason, evaluation: state.evaluation },
        nextAction: "Restore an executable owner or dependency path, then explicitly resume the issue.",
        maxAttempts: state.evaluation.recovery.maximumAttempts,
        lastAttemptAt: new Date(),
      }, tx);
    }
    if (isDeliveryControlRecoveryCause(action.cause)) {
      await tx
        .update(issueRecoveryActions)
        .set({
          status: "escalated",
          ownerType: ceo ? "agent" : "board",
          ownerAgentId: ceo?.id ?? null,
          ownerUserId: null,
          cause: DELIVERY_CONTROL_EXHAUSTED_CAUSE,
          nextAction: "Restore an executable owner or dependency path, then explicitly resume the issue.",
          timeoutAt: null,
          monitorPolicy: null,
          outcome: "blocked",
          updatedAt: new Date(),
        })
        .where(eq(issueRecoveryActions.id, action.id));
    }
    if (issue.status !== "blocked") {
      await issuesApi.update(issue.id, { status: "blocked" }, tx);
    }
    await logActivity(tx as unknown as Db, {
      companyId: issue.companyId,
      actorType: "system",
      actorId: "delivery_control",
      agentId: ceo?.id ?? null,
      runId: null,
      action: DELIVERY_CONTROL_BLOCKER_ACTION,
      entityType: "issue",
      entityId: issue.id,
      details: {
        eventKey,
        reason,
        recoveryActionId: action.id,
        ownerType: ceo ? "agent" : "board",
        ownerAgentId: ceo?.id ?? null,
        nextAction: "Restore an executable owner or dependency path, then explicitly resume the issue.",
        attempts: state.evaluation.recovery.attemptCount,
        maximumAttempts: state.evaluation.recovery.maximumAttempts,
      },
    });
    return true;
  });
}

async function resolveHealthyDeliveryRecovery(
  db: Db,
  issue: CandidateIssue,
  state: Awaited<ReturnType<typeof evaluateIssue>>,
) {
  if (!state.recoveryAction || !isDeliveryControlRecoveryCause(state.recoveryAction.cause)) return false;
  if (state.evaluation.livenessState !== "active" && !state.hasLiveDependencyPath) return false;
  return Boolean(await issueRecoveryActionService(db).resolveActiveForIssue({
    companyId: issue.companyId,
    sourceIssueId: issue.id,
    actionId: state.recoveryAction.id,
    status: "resolved",
    outcome: "restored",
    resolutionNote: "Delivery Control observed a live run or explicit healthy dependency path.",
  }));
}

async function resolveTerminalDeliveryRecoveries(
  db: Db,
  companyId?: string | null,
  issueCreatedAtGte?: Date | null,
) {
  const terminalRows = await db
    .select({ actionId: issueRecoveryActions.id })
    .from(issueRecoveryActions)
    .innerJoin(issues, eq(issueRecoveryActions.sourceIssueId, issues.id))
    .where(and(
      inArray(issueRecoveryActions.status, ["active", "escalated"]),
      inArray(issueRecoveryActions.cause, [DELIVERY_CONTROL_RECOVERY_CAUSE, DELIVERY_CONTROL_EXHAUSTED_CAUSE]),
      inArray(issues.status, ["done", "cancelled"]),
      companyId ? eq(issueRecoveryActions.companyId, companyId) : undefined,
      issueCreatedAtGte ? gte(issues.createdAt, issueCreatedAtGte) : undefined,
    ));
  if (terminalRows.length === 0) return 0;
  await db
    .update(issueRecoveryActions)
    .set({
      status: "resolved",
      outcome: "restored",
      resolutionNote: "Source issue reached a terminal state.",
      resolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(inArray(issueRecoveryActions.id, terminalRows.map((row) => row.actionId)));
  return terminalRows.length;
}

async function emitRecentTerminalAcceptances(
  db: Db,
  input: { companyId?: string | null; now: Date; limit: number; issueCreatedAtGte?: Date | null },
) {
  const broadCutoff = new Date(input.now.getTime() - 2 * 60 * 60 * 1000);
  const terminalRoots = await db
    .select()
    .from(issues)
    .where(and(
      visibleIssueCondition(),
      isNull(issues.hiddenAt),
      isNull(issues.parentId),
      eq(issues.status, "done"),
      inArray(issues.priority, ["critical", "high"]),
      isNotNull(issues.completedAt),
      gte(issues.completedAt, broadCutoff),
      input.companyId ? eq(issues.companyId, input.companyId) : undefined,
      input.issueCreatedAtGte ? gte(issues.createdAt, input.issueCreatedAtGte) : undefined,
    ))
    .orderBy(desc(issues.completedAt), desc(issues.id))
    .limit(input.limit);
  let emitted = 0;
  for (const issue of terminalRoots) {
    if (readDeliveryControlConfig(issue.companyId, { issueId: issue.id }).effectiveMode !== "enforce") continue;
    const policy = deliveryControlPolicyForPriority(issue.priority)!;
    if (!issue.completedAt || issue.completedAt.getTime() < input.now.getTime() - policy.communicationMaxGapMs) continue;
    const terminalIssue: CandidateIssue = {
      ...issue,
      effectivePriority: issue.priority as IssuePriority,
    };
    const state = await evaluateIssue(db, terminalIssue, terminalIssue.effectivePriority, input.now, false);
    if (await emitDeliveryCommunication(db, terminalIssue, state, input.now, true)) emitted += 1;
  }
  return emitted;
}

export async function reconcileDeliveryControlShadow(
  db: Db,
  opts: { companyId?: string | null; now?: Date; limit?: number; issueCreatedAtGte?: Date | null } = {},
  deps?: DeliveryControlEnforcementDependencies,
) {
  const now = opts.now ?? new Date();
  const limit = Math.max(1, Math.min(DELIVERY_CONTROL_SCAN_LIMIT, Math.floor(opts.limit ?? DELIVERY_CONTROL_SCAN_LIMIT)));
  const candidatePool = await buildFairCandidatePool(db, {
    companyId: opts.companyId,
    limit,
    issueCreatedAtGte: opts.issueCreatedAtGte,
  });
  const candidates = candidatePool.candidates;
  let graphControls = { priorityPropagated: 0, incidentLaneFindings: 0 };
  try {
    graphControls = await recordGraphControls(db, candidatePool);
  } catch (error) {
    logger.warn({ err: error, companyId: opts.companyId }, "delivery-control graph enforcement failed open");
  }

  const result = {
    checked: candidates.length,
    observed: 0,
    deduplicated: 0,
    offSkipped: 0,
    failed: 0,
    issueIds: [] as string[],
    recoveriesEnqueued: 0,
    escalationsCreated: 0,
    blockersCreated: 0,
    communicationsEmitted: 0,
    terminalAcceptancesEmitted: 0,
    recoveriesResolved: 0,
    terminalRecoveriesResolved: 0,
    priorityPropagated: graphControls.priorityPropagated,
    incidentLaneFindings: graphControls.incidentLaneFindings,
  };
  try {
    result.terminalRecoveriesResolved = await resolveTerminalDeliveryRecoveries(
      db,
      opts.companyId,
      opts.issueCreatedAtGte,
    );
    result.terminalAcceptancesEmitted = await emitRecentTerminalAcceptances(db, {
      companyId: opts.companyId,
      now,
      limit,
      issueCreatedAtGte: opts.issueCreatedAtGte,
    });
  } catch (error) {
    result.failed += 1;
    logger.warn({ err: error, companyId: opts.companyId }, "delivery-control terminal recovery cleanup failed open");
  }
  const blockerAttentionByIssueId = new Map<string, { state: string }>();
  const blockerAttentionFailedCompanyIds = new Set<string>();
  const blockedCandidatesByCompanyId = new Map<string, typeof candidates>();
  for (const issue of candidates) {
    if (
      issue.status !== "blocked" ||
      readDeliveryControlConfig(issue.companyId, { issueId: issue.id }).effectiveMode === "off"
    ) continue;
    const companyIssues = blockedCandidatesByCompanyId.get(issue.companyId) ?? [];
    companyIssues.push(issue);
    blockedCandidatesByCompanyId.set(issue.companyId, companyIssues);
  }
  const issuesApi = issueService(db);
  for (const [companyId, companyIssues] of blockedCandidatesByCompanyId) {
    try {
      const attention = await issuesApi.listBlockerAttention(companyId, companyIssues);
      for (const [issueId, value] of attention) blockerAttentionByIssueId.set(issueId, value);
    } catch (error) {
      blockerAttentionFailedCompanyIds.add(companyId);
      logger.warn({ err: error, companyId }, "delivery-control dependency evaluation failed open");
    }
  }
  for (const issue of candidates) {
    const config = readDeliveryControlConfig(issue.companyId, { issueId: issue.id });
    if (config.effectiveMode === "off") {
      result.offSkipped += 1;
      continue;
    }
    if (blockerAttentionFailedCompanyIds.has(issue.companyId)) {
      result.failed += 1;
      continue;
    }
    try {
      const state = await evaluateIssue(
        db,
        issue,
        issue.effectivePriority,
        now,
        blockerAttentionByIssueId.get(issue.id)?.state === "covered",
      );
      const recorded = await recordObservation(db, state.evaluation, config.effectiveMode);
      if (recorded) {
        result.observed += 1;
        result.issueIds.push(issue.id);
      } else {
        result.deduplicated += 1;
      }
      if (config.effectiveMode !== "enforce") continue;

      if (await resolveHealthyDeliveryRecovery(db, issue, state)) {
        result.recoveriesResolved += 1;
      }
      if (state.evaluation.recovery.status === "due") {
        if (!deps) throw new Error("Delivery-control enforce mode requires an enqueueWakeup dependency");
        const recovery = await enqueueBoundedDeliveryRecovery(db, deps, issue, state, now);
        if (recovery.enqueued) result.recoveriesEnqueued += 1;
        if (recovery.missingOwner || recovery.conflictingAction) {
          const created = await ensureFirstClassDeliveryBlocker(
            db,
            issue,
            state,
            recovery.missingOwner ? "missing_recovery_owner" : "conflicting_recovery_action",
          );
          if (created) result.blockersCreated += 1;
        }
      }
      if (state.evaluation.escalation.status === "due") {
        if (!deps) throw new Error("Delivery-control enforce mode requires an enqueueWakeup dependency");
        if (await ensureCeoEscalation(db, deps, issue, state)) result.escalationsCreated += 1;
      }
      if (state.evaluation.recovery.status === "exhausted") {
        if (await ensureFirstClassDeliveryBlocker(db, issue, state, "attempts_exhausted")) {
          result.blockersCreated += 1;
        }
      }
      if (await emitDeliveryCommunication(db, issue, state, now)) {
        result.communicationsEmitted += 1;
      }
    } catch (error) {
      result.failed += 1;
      logger.warn({ err: error, issueId: issue.id }, "delivery-control shadow evaluation failed open");
    }
  }
  return result;
}
