import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  heartbeatRuns,
  issues,
  resourceControlLeases,
  type Db,
} from "@paperclipai/db";
import {
  buildDeliveryControlResourceQueueTelemetry,
  type DeliveryControlActionClass,
  type DeliveryControlResourceQueueTelemetry,
} from "@paperclipai/shared";
import { resolveIssueResourceControl } from "./resource-control.js";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

const DEFAULT_RESOURCE_LEASE_TTL_MS = 5 * 60 * 1_000;

export type ResourceControlLeaseAcquireOutcome =
  | "acquired"
  | "owned"
  | "wait"
  | "recovery_required"
  | "replay_confirmed"
  | "denied";

export interface ResourceControlLeaseDecision {
  outcome: ResourceControlLeaseAcquireOutcome;
  lease: typeof resourceControlLeases.$inferSelect | null;
  blockingRunId: string | null;
  reason: string;
  nextCheckAt: Date | null;
}

function nextLeaseExpiry(now: Date, ttlMs: number) {
  return new Date(now.getTime() + ttlMs);
}

function decision(
  outcome: ResourceControlLeaseAcquireOutcome,
  lease: typeof resourceControlLeases.$inferSelect | null,
  reason: string,
): ResourceControlLeaseDecision {
  return {
    outcome,
    lease,
    blockingRunId: lease?.ownerRunId ?? null,
    reason,
    nextCheckAt: lease?.expiresAt ?? null,
  };
}

export async function acquireResourceControlLease(
  tx: DbTransaction,
  input: {
    companyId: string;
    issueId: string | null;
    runId: string;
    actionClass: DeliveryControlActionClass;
    resourceKey: string;
    changeId: string;
    idempotencyKey: string;
    now?: Date;
    ttlMs?: number;
  },
): Promise<ResourceControlLeaseDecision> {
  const now = input.now ?? new Date();
  const ttlMs = Math.max(30_000, input.ttlMs ?? DEFAULT_RESOURCE_LEASE_TTL_MS);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${input.companyId}:${input.resourceKey}`}, 0))`,
  );

  const sameChange = await tx
    .select()
    .from(resourceControlLeases)
    .where(and(
      eq(resourceControlLeases.companyId, input.companyId),
      eq(resourceControlLeases.actionClass, input.actionClass),
      eq(resourceControlLeases.resourceKey, input.resourceKey),
      eq(resourceControlLeases.idempotencyKey, input.idempotencyKey),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (sameChange) {
    if (
      sameChange.status === "active" &&
      sameChange.ownerRunId === input.runId &&
      sameChange.expiresAt > now
    ) {
      const renewed = await tx
        .update(resourceControlLeases)
        .set({
          renewedAt: now,
          expiresAt: nextLeaseExpiry(now, ttlMs),
          updatedAt: now,
        })
        .where(eq(resourceControlLeases.id, sameChange.id))
        .returning()
        .then((rows) => rows[0] ?? sameChange);
      return decision("owned", renewed, "lease_already_owned_by_run");
    }
    if (sameChange.status === "completed" && sameChange.targetReadbackVerifiedAt) {
      return decision("replay_confirmed", sameChange, "idempotent_change_already_completed_and_read_back");
    }
    if (sameChange.status === "active" && sameChange.expiresAt > now) {
      return decision("wait", sameChange, "resource_lease_held_by_another_run");
    }
    if (sameChange.status === "active") {
      const recoveryLease = await tx
        .update(resourceControlLeases)
        .set({
          status: "recovery_required",
          releaseReason: "lease_expired_before_verified_release",
          updatedAt: now,
        })
        .where(and(
          eq(resourceControlLeases.id, sameChange.id),
          eq(resourceControlLeases.status, "active"),
        ))
        .returning()
        .then((rows) => rows[0] ?? sameChange);
      return decision("recovery_required", recoveryLease, "expired_lease_requires_owner_and_target_readback");
    }
    return decision("recovery_required", sameChange, "idempotent_retry_requires_target_readback");
  }

  const latestForResource = await tx
    .select()
    .from(resourceControlLeases)
    .where(and(
      eq(resourceControlLeases.companyId, input.companyId),
      eq(resourceControlLeases.resourceKey, input.resourceKey),
    ))
    .orderBy(desc(resourceControlLeases.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (latestForResource?.status === "recovery_required") {
    return decision("recovery_required", latestForResource, "resource_recovery_must_complete_before_new_change");
  }
  if (latestForResource?.status === "active") {
    if (latestForResource.expiresAt > now) {
      return decision("wait", latestForResource, "resource_lease_held_by_another_run");
    }
    const recoveryLease = await tx
      .update(resourceControlLeases)
      .set({
        status: "recovery_required",
        releaseReason: "lease_expired_before_verified_release",
        updatedAt: now,
      })
      .where(and(
        eq(resourceControlLeases.id, latestForResource.id),
        eq(resourceControlLeases.status, "active"),
      ))
      .returning()
      .then((rows) => rows[0] ?? latestForResource);
    return decision("recovery_required", recoveryLease, "expired_lease_requires_owner_and_target_readback");
  }

  const [{ nextToken }] = await tx
    .select({
      nextToken: sql<number>`coalesce(max(${resourceControlLeases.fencingToken}), 0) + 1`,
    })
    .from(resourceControlLeases)
    .where(and(
      eq(resourceControlLeases.companyId, input.companyId),
      eq(resourceControlLeases.resourceKey, input.resourceKey),
    ));
  const lease = await tx
    .insert(resourceControlLeases)
    .values({
      companyId: input.companyId,
      resourceKey: input.resourceKey,
      actionClass: input.actionClass,
      ownerRunId: input.runId,
      issueId: input.issueId,
      changeId: input.changeId,
      idempotencyKey: input.idempotencyKey,
      fencingToken: Number(nextToken),
      status: "active",
      acquiredAt: now,
      renewedAt: now,
      expiresAt: nextLeaseExpiry(now, ttlMs),
      metadata: { leaseProtocol: "resource_control_v1" },
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .then((rows) => rows[0] ?? null);
  return decision("acquired", lease, "resource_lease_acquired");
}

export async function renewResourceControlLeaseForRun(
  db: Db,
  runId: string,
  opts?: { now?: Date; ttlMs?: number },
) {
  const now = opts?.now ?? new Date();
  const ttlMs = Math.max(30_000, opts?.ttlMs ?? DEFAULT_RESOURCE_LEASE_TTL_MS);
  return db.transaction(async (tx) => {
    const lease = await tx
      .select()
      .from(resourceControlLeases)
      .where(and(
        eq(resourceControlLeases.ownerRunId, runId),
        eq(resourceControlLeases.status, "active"),
      ))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!lease) return null;
    if (lease.expiresAt <= now) {
      return tx
        .update(resourceControlLeases)
        .set({
          status: "recovery_required",
          releaseReason: "lease_expired_before_renewal",
          updatedAt: now,
        })
        .where(eq(resourceControlLeases.id, lease.id))
        .returning()
        .then((rows) => rows[0] ?? null);
    }
    return tx
      .update(resourceControlLeases)
      .set({ renewedAt: now, expiresAt: nextLeaseExpiry(now, ttlMs), updatedAt: now })
      .where(eq(resourceControlLeases.id, lease.id))
      .returning()
      .then((rows) => rows[0] ?? null);
  });
}

export async function releaseResourceControlLeaseForRun(
  db: Db,
  input: {
    runId: string;
    terminalStatus: string;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  return db
    .update(resourceControlLeases)
    .set({
      status: "released",
      releasedAt: now,
      releaseReason: input.terminalStatus === "succeeded"
        ? "run_succeeded_target_readback_not_recorded"
        : `run_${input.terminalStatus}`,
      updatedAt: now,
    })
    .where(and(
      eq(resourceControlLeases.ownerRunId, input.runId),
      eq(resourceControlLeases.status, "active"),
    ))
    .returning();
}

export async function confirmResourceControlTargetReadback(
  db: Db,
  input: {
    companyId: string;
    leaseId: string;
    runId: string;
    now?: Date;
    metadata?: Record<string, unknown>;
  },
) {
  const now = input.now ?? new Date();
  const [run] = await db
    .select({ status: heartbeatRuns.status })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)))
    .limit(1);
  if (run?.status !== "succeeded") return null;
  return db
    .update(resourceControlLeases)
    .set({
      status: "completed",
      targetReadbackVerifiedAt: now,
      releasedAt: now,
      releaseReason: "target_readback_verified",
      metadata: input.metadata ?? { leaseProtocol: "resource_control_v1" },
      updatedAt: now,
    })
    .where(and(
      eq(resourceControlLeases.id, input.leaseId),
      eq(resourceControlLeases.companyId, input.companyId),
      eq(resourceControlLeases.ownerRunId, input.runId),
      eq(resourceControlLeases.status, "released"),
    ))
    .returning()
    .then((rows) => rows[0] ?? null);
}

function contextIssueId(contextSnapshot: Record<string, unknown> | null) {
  const value = contextSnapshot?.issueId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function listResourceQueueTelemetry(
  db: Db,
  companyId: string,
  targetRunIds?: string[],
  opts?: { now?: Date },
): Promise<Map<string, DeliveryControlResourceQueueTelemetry>> {
  const queuedRuns = await db
    .select({
      id: heartbeatRuns.id,
      contextSnapshot: heartbeatRuns.contextSnapshot,
      createdAt: heartbeatRuns.createdAt,
      updatedAt: heartbeatRuns.updatedAt,
    })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, companyId),
      eq(heartbeatRuns.status, "queued"),
    ))
    .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id));
  if (queuedRuns.length === 0) return new Map();

  const issueIds = [...new Set(queuedRuns.map((run) => contextIssueId(run.contextSnapshot)).filter(
    (issueId): issueId is string => Boolean(issueId),
  ))];
  if (issueIds.length === 0) return new Map();
  const issueRows = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      status: issues.status,
      workMode: issues.workMode,
      projectId: issues.projectId,
      projectWorkspaceId: issues.projectWorkspaceId,
      executionWorkspaceId: issues.executionWorkspaceId,
      executionWorkspaceSettings: issues.executionWorkspaceSettings,
    })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds)));
  const issueById = new Map(issueRows.map((issue) => [issue.id, issue]));
  const controlledRuns = queuedRuns.flatMap((run) => {
    const issueId = contextIssueId(run.contextSnapshot);
    const issue = issueId ? issueById.get(issueId) : null;
    if (!issue) return [];
    const resourceControl = resolveIssueResourceControl(issue);
    if (resourceControl.source !== "explicit" || !resourceControl.leaseRequired) return [];
    return [{ run, resourceControl }];
  });
  if (controlledRuns.length === 0) return new Map();

  const resourceKeys = [...new Set(controlledRuns.map(({ resourceControl }) => resourceControl.resourceKey))];
  const leaseRows = await db
    .select()
    .from(resourceControlLeases)
    .where(and(
      eq(resourceControlLeases.companyId, companyId),
      inArray(resourceControlLeases.resourceKey, resourceKeys),
    ))
    .orderBy(desc(resourceControlLeases.createdAt));
  const leasesByResource = new Map<string, typeof leaseRows>();
  for (const lease of leaseRows) {
    const rows = leasesByResource.get(lease.resourceKey) ?? [];
    rows.push(lease);
    leasesByResource.set(lease.resourceKey, rows);
  }

  const now = opts?.now ?? new Date();
  const entries = controlledRuns.flatMap(({ run, resourceControl }) => {
    const resourceLeases = leasesByResource.get(resourceControl.resourceKey) ?? [];
    const sameChange = resourceControl.idempotencyKey
      ? resourceLeases.find((lease) => lease.idempotencyKey === resourceControl.idempotencyKey)
      : null;
    const blockingLease = sameChange ?? resourceLeases.find(
      (lease) => lease.status === "active" || lease.status === "recovery_required",
    );
    if (!blockingLease && !resourceControl.blockedReason) return [];
    const activeExpired = blockingLease?.status === "active" && blockingLease.expiresAt <= now;
    const waitReason = resourceControl.blockedReason ?? (
      activeExpired
        ? "expired_lease_requires_owner_and_target_readback"
        : blockingLease?.status === "recovery_required"
          ? "resource_recovery_must_complete_before_new_change"
          : sameChange && sameChange.status !== "active"
            ? "idempotent_retry_requires_target_readback"
            : "resource_lease_held_by_another_run"
    );
    return [{
      runId: run.id,
      actionClass: resourceControl.actionClass,
      resourceKey: resourceControl.resourceKey,
      waitReason,
      blockingRunId: blockingLease?.ownerRunId ?? null,
      waitingSinceAt: run.createdAt,
      nextCheckAt: blockingLease?.expiresAt ?? run.updatedAt,
    }];
  });
  const targetSet = targetRunIds ? new Set(targetRunIds) : null;
  return new Map(
    buildDeliveryControlResourceQueueTelemetry(entries)
      .filter((telemetry) => !targetSet || targetSet.has(telemetry.runId))
      .map(({ runId, ...telemetry }) => [runId, telemetry]),
  );
}
