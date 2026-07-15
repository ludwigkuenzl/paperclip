import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentWakeupRequests,
  approvals,
  heartbeatRuns,
  issueApprovals,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import type { IssuePriority } from "@paperclipai/shared";
import { parseObject, asNumber } from "../adapters/utils.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import {
  evaluateDeliveryControl,
  readDeliveryControlConfig,
  type DeliveryControlEvaluation,
} from "./delivery-control.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import { issueService } from "./issues.js";

const DELIVERY_CONTROL_SCAN_LIMIT = 200;
const ACTIVE_RUN_STATUSES = ["running"] as const;
const ACTIVE_WAKE_STATUSES = ["queued", "deferred_issue_execution"] as const;
const PENDING_APPROVAL_STATUSES = ["pending", "revision_requested"] as const;
const DELIVERY_TRIGGER_WAKE_REASONS = ["issue_assigned", "issue_blockers_resolved", "approval_approved"] as const;

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
  now: Date,
  hasLiveDependencyPath: boolean,
) {
  const [
    latestRun,
    latestWake,
    latestTriggerWake,
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
      .select({ id: issueThreadInteractions.id })
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
      .select({ id: approvals.id })
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
        attemptCount: issueRecoveryActions.attemptCount,
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
    acceptedInteraction?.resolvedAt,
    approvedApproval?.decidedAt,
  ]) ?? issue.createdAt;
  const phaseRun = latestRun && latestRun.createdAt.getTime() >= triggerAt.getTime() ? latestRun : null;
  const phaseWake = latestWake && latestWake.requestedAt.getTime() >= triggerAt.getTime() ? latestWake : null;
  const runContext = parseObject(phaseRun?.contextSnapshot);
  const recoveryAttemptCount = Math.max(
    recoveryAction?.attemptCount ?? 0,
    Math.max(0, Math.floor(asNumber(runContext.deliveryControlRecoveryAttempt, 0))),
  );
  const hasActiveRun = Boolean(
    phaseRun && ACTIVE_RUN_STATUSES.includes(phaseRun.status as (typeof ACTIVE_RUN_STATUSES)[number]),
  );
  const executionLockCoherent = !hasActiveRun || Boolean(
    phaseRun && (issue.executionRunId === phaseRun.id || issue.checkoutRunId === phaseRun.id),
  );
  const hasQueuedExecution = phaseRun?.status === "queued";

  return evaluateDeliveryControl({
    issueId: issue.id,
    companyId: issue.companyId,
    priority: issue.priority as IssuePriority,
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
    hasTypedReviewOrApproval: Boolean(pendingInteraction || pendingApproval),
    hasLiveDependencyPath,
    hasExplicitRecoveryAction: Boolean(recoveryAction),
    hasHumanOwner: Boolean(issue.assigneeUserId),
    now,
  });
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

export async function reconcileDeliveryControlShadow(
  db: Db,
  opts: { companyId?: string | null; now?: Date; limit?: number } = {},
) {
  const now = opts.now ?? new Date();
  const limit = Math.max(1, Math.min(DELIVERY_CONTROL_SCAN_LIMIT, Math.floor(opts.limit ?? DELIVERY_CONTROL_SCAN_LIMIT)));
  const candidates = await db
    .select()
    .from(issues)
    .where(and(
      visibleIssueCondition(),
      isNull(issues.hiddenAt),
      inArray(issues.priority, ["critical", "high"]),
      inArray(issues.status, ["todo", "in_progress", "in_review", "blocked"]),
      opts.companyId ? eq(issues.companyId, opts.companyId) : undefined,
    ))
    .orderBy(
      sql`CASE ${issues.priority} WHEN 'critical' THEN 0 ELSE 1 END`,
      issues.createdAt,
      issues.id,
    )
    .limit(limit);

  const result = {
    checked: candidates.length,
    observed: 0,
    deduplicated: 0,
    offSkipped: 0,
    failed: 0,
    issueIds: [] as string[],
  };
  const blockerAttentionByIssueId = new Map<string, { state: string }>();
  const blockerAttentionFailedCompanyIds = new Set<string>();
  const blockedCandidatesByCompanyId = new Map<string, typeof candidates>();
  for (const issue of candidates) {
    if (issue.status !== "blocked" || readDeliveryControlConfig(issue.companyId).effectiveMode === "off") continue;
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
    const config = readDeliveryControlConfig(issue.companyId);
    if (config.effectiveMode === "off") {
      result.offSkipped += 1;
      continue;
    }
    if (blockerAttentionFailedCompanyIds.has(issue.companyId)) {
      result.failed += 1;
      continue;
    }
    try {
      const evaluation = await evaluateIssue(
        db,
        issue,
        now,
        blockerAttentionByIssueId.get(issue.id)?.state === "covered",
      );
      const recorded = await recordObservation(db, evaluation, config.effectiveMode);
      if (recorded) {
        result.observed += 1;
        result.issueIds.push(issue.id);
      } else {
        result.deduplicated += 1;
      }
    } catch (error) {
      result.failed += 1;
      logger.warn({ err: error, issueId: issue.id }, "delivery-control shadow evaluation failed open");
    }
  }
  return result;
}
