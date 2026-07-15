import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  resourceControlLeases,
} from "@paperclipai/db";
import {
  acquireResourceControlLease,
  confirmResourceControlTargetReadback,
  listResourceQueueTelemetry,
  releaseResourceControlLeaseForRun,
  renewResourceControlLeaseForRun,
} from "./resource-control-leases.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("resource-control leases", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();
  const runIds = [randomUUID(), randomUUID(), randomUUID()];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-resource-control-leases-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({
      id: companyId,
      name: "Resource Lease Test",
      issuePrefix: "RCL",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "LeaseWorker",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Lease-controlled deploy",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values(runIds.map((id) => ({
      id,
      companyId,
      agentId,
      status: "queued",
      invocationSource: "assignment",
      contextSnapshot: { issueId },
    })));
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("serializes one resource while allowing a different resource", async () => {
    const first = await db.transaction((tx) => acquireResourceControlLease(tx, {
      companyId,
      issueId,
      runId: runIds[0]!,
      actionClass: "deploy",
      resourceKey: "deploy:production",
      changeId: "sha-1",
      idempotencyKey: "deploy-production-sha-1",
      now: new Date("2026-07-15T00:00:00.000Z"),
    }));
    const sameResource = await db.transaction((tx) => acquireResourceControlLease(tx, {
      companyId,
      issueId,
      runId: runIds[1]!,
      actionClass: "deploy",
      resourceKey: "deploy:production",
      changeId: "sha-2",
      idempotencyKey: "deploy-production-sha-2",
      now: new Date("2026-07-15T00:01:00.000Z"),
    }));
    const otherResource = await db.transaction((tx) => acquireResourceControlLease(tx, {
      companyId,
      issueId,
      runId: runIds[2]!,
      actionClass: "deploy",
      resourceKey: "deploy:staging",
      changeId: "sha-2",
      idempotencyKey: "deploy-staging-sha-2",
      now: new Date("2026-07-15T00:01:00.000Z"),
    }));

    expect(first.outcome).toBe("acquired");
    expect(first.lease?.fencingToken).toBe(1);
    expect(sameResource).toMatchObject({
      outcome: "wait",
      blockingRunId: runIds[0],
      reason: "resource_lease_held_by_another_run",
    });
    expect(otherResource.outcome).toBe("acquired");
  });

  it("exposes deterministic queue telemetry for the waiting run", async () => {
    await db
      .update(heartbeatRuns)
      .set({ status: "running", startedAt: new Date("2026-07-15T00:00:00.000Z") })
      .where(eq(heartbeatRuns.id, runIds[0]!));
    await db
      .update(heartbeatRuns)
      .set({ status: "running", startedAt: new Date("2026-07-15T00:01:00.000Z") })
      .where(eq(heartbeatRuns.id, runIds[2]!));
    await db
      .update(issues)
      .set({
        executionWorkspaceSettings: {
          resourceControl: {
            actionClass: "deploy",
            resourceKey: "deploy:production",
            changeId: "sha-2",
            idempotencyKey: "deploy-production-sha-2",
          },
        },
      })
      .where(eq(issues.id, issueId));

    const telemetry = await listResourceQueueTelemetry(db, companyId, [runIds[1]!], {
      now: new Date("2026-07-15T00:02:00.000Z"),
    });
    expect(telemetry.get(runIds[1]!)).toMatchObject({
      actionClass: "deploy",
      resourceKey: "deploy:production",
      waitReason: "resource_lease_held_by_another_run",
      blockingRunId: runIds[0],
      queuePosition: 1,
    });
  });

  it("does not steal an expired lease and requires explicit recovery", async () => {
    const expired = await db.transaction((tx) => acquireResourceControlLease(tx, {
      companyId,
      issueId,
      runId: runIds[1]!,
      actionClass: "deploy",
      resourceKey: "deploy:production",
      changeId: "sha-2",
      idempotencyKey: "deploy-production-sha-2",
      now: new Date("2026-07-15T00:06:00.000Z"),
    }));
    expect(expired).toMatchObject({
      outcome: "recovery_required",
      blockingRunId: runIds[0],
      reason: "expired_lease_requires_owner_and_target_readback",
    });
    const [lease] = await db
      .select()
      .from(resourceControlLeases)
      .where(eq(resourceControlLeases.resourceKey, "deploy:production"));
    expect(lease?.status).toBe("recovery_required");
  });

  it("renews only before expiry and releases without claiming target readback", async () => {
    const renewed = await renewResourceControlLeaseForRun(db, runIds[2]!, {
      now: new Date("2026-07-15T00:02:00.000Z"),
    });
    expect(renewed?.status).toBe("active");
    expect(renewed?.expiresAt.toISOString()).toBe("2026-07-15T00:07:00.000Z");

    const released = await releaseResourceControlLeaseForRun(db, {
      runId: runIds[2]!,
      terminalStatus: "succeeded",
      now: new Date("2026-07-15T00:03:00.000Z"),
    });
    expect(released).toHaveLength(1);
    expect(released[0]).toMatchObject({
      status: "released",
      targetReadbackVerifiedAt: null,
      releaseReason: "run_succeeded_target_readback_not_recorded",
    });
  });

  it("confirms completion only after a succeeded run and explicit target readback", async () => {
    const [lease] = await db
      .select()
      .from(resourceControlLeases)
      .where(eq(resourceControlLeases.ownerRunId, runIds[2]!));
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date("2026-07-15T00:03:00.000Z") })
      .where(eq(heartbeatRuns.id, runIds[2]!));

    const completed = await confirmResourceControlTargetReadback(db, {
      companyId,
      leaseId: lease!.id,
      runId: runIds[2]!,
      now: new Date("2026-07-15T00:04:00.000Z"),
      metadata: { readback: "sha-2" },
    });
    expect(completed).toMatchObject({
      status: "completed",
      releaseReason: "target_readback_verified",
      metadata: { readback: "sha-2" },
    });

    const replay = await db.transaction((tx) => acquireResourceControlLease(tx, {
      companyId,
      issueId,
      runId: runIds[1]!,
      actionClass: "deploy",
      resourceKey: "deploy:staging",
      changeId: "sha-2",
      idempotencyKey: "deploy-staging-sha-2",
      now: new Date("2026-07-15T00:05:00.000Z"),
    }));
    expect(replay.outcome).toBe("replay_confirmed");
  });
});
