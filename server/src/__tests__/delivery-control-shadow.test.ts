import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { reconcileDeliveryControlShadow } from "../services/delivery-control-shadow.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres delivery-control shadow tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("delivery-control shadow reconciliation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousMode = process.env.PAPERCLIP_DELIVERY_CONTROL_MODE;
  const previousCompanyIds = process.env.PAPERCLIP_DELIVERY_CONTROL_COMPANY_IDS;
  const previousIssueIds = process.env.PAPERCLIP_DELIVERY_CONTROL_ISSUE_IDS;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-delivery-control-shadow-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRecoveryActions);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    if (previousMode === undefined) delete process.env.PAPERCLIP_DELIVERY_CONTROL_MODE;
    else process.env.PAPERCLIP_DELIVERY_CONTROL_MODE = previousMode;
    if (previousCompanyIds === undefined) delete process.env.PAPERCLIP_DELIVERY_CONTROL_COMPANY_IDS;
    else process.env.PAPERCLIP_DELIVERY_CONTROL_COMPANY_IDS = previousCompanyIds;
    if (previousIssueIds === undefined) delete process.env.PAPERCLIP_DELIVERY_CONTROL_ISSUE_IDS;
    else process.env.PAPERCLIP_DELIVERY_CONTROL_ISSUE_IDS = previousIssueIds;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCriticalIssue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Delivery Control Test",
      issuePrefix: "DCT",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CTO",
      role: "cto",
      status: "idle",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "DCT-1",
      title: "Critical queued work",
      status: "todo",
      priority: "critical",
      assigneeAgentId: agentId,
      createdAt: new Date("2026-07-15T00:00:00.000Z"),
      updatedAt: new Date("2026-07-15T00:00:00.000Z"),
    });
    return { companyId, agentId, issueId };
  }

  it("records one machine-readable SLA finding and suppresses an identical second tick", async () => {
    process.env.PAPERCLIP_DELIVERY_CONTROL_MODE = "shadow";
    const { companyId, issueId } = await seedCriticalIssue();
    const now = new Date("2026-07-15T00:06:00.000Z");

    const first = await reconcileDeliveryControlShadow(db, { companyId, now });
    const second = await reconcileDeliveryControlShadow(db, {
      companyId,
      now: new Date("2026-07-15T00:07:00.000Z"),
    });

    expect(first).toMatchObject({ checked: 1, observed: 1, deduplicated: 0, failed: 0, issueIds: [issueId] });
    expect(second).toMatchObject({ checked: 1, observed: 0, deduplicated: 1, failed: 0 });
    const observations = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.delivery_control_shadow_finding"));
    expect(observations).toHaveLength(1);
    expect(observations[0]?.details).toMatchObject({
      effectiveMode: "shadow",
      contractId: "paperclip.delivery-control",
      contractVersion: { major: 1, minor: 0, patch: 0 },
      priority: "critical",
      livenessState: "stalled",
      startSla: { status: "breached", deadlineAt: "2026-07-15T00:05:00.000Z" },
      recovery: { status: "waiting", dueAt: "2026-07-15T00:15:00.000Z", maximumAttempts: 2 },
      audit: {
        measurementStartAt: "2026-07-15T00:00:00.000Z",
        queueEntryAt: null,
        runStartAt: null,
        resultAt: null,
      },
    });

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("todo");
    expect(await db.select().from(issueComments)).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });

  it("does not scan or write when delivery control is off", async () => {
    process.env.PAPERCLIP_DELIVERY_CONTROL_MODE = "off";
    const { companyId } = await seedCriticalIssue();

    const result = await reconcileDeliveryControlShadow(db, {
      companyId,
      now: new Date("2026-07-15T00:06:00.000Z"),
    });

    expect(result).toMatchObject({ checked: 1, observed: 0, offSkipped: 1, failed: 0 });
    expect(await db.select().from(activityLog)).toHaveLength(0);
  });

  it("treats a persisted queued run as a covered queue path before the start deadline", async () => {
    process.env.PAPERCLIP_DELIVERY_CONTROL_MODE = "shadow";
    const { companyId, agentId, issueId } = await seedCriticalIssue();
    const queuedAt = new Date("2026-07-15T00:01:00.000Z");
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      createdAt: queuedAt,
      updatedAt: queuedAt,
    });

    const result = await reconcileDeliveryControlShadow(db, {
      companyId,
      now: new Date("2026-07-15T00:03:00.000Z"),
    });

    expect(result).toMatchObject({ checked: 1, observed: 1, failed: 0 });
    const observation = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.delivery_control_shadow_finding"))
      .then((rows) => rows[0]);
    expect(observation?.details).toMatchObject({
      livenessState: "covered",
      startSla: { status: "pending" },
      audit: { queueEntryAt: queuedAt.toISOString(), runStartAt: null },
    });
  });

  it("starts a fresh SLA phase on unblock and does not reuse an older completed run", async () => {
    process.env.PAPERCLIP_DELIVERY_CONTROL_MODE = "shadow";
    const { companyId, agentId, issueId } = await seedCriticalIssue();
    const oldRunAt = new Date("2026-07-15T00:01:00.000Z");
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "succeeded",
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      startedAt: oldRunAt,
      finishedAt: new Date("2026-07-15T00:02:00.000Z"),
      createdAt: oldRunAt,
      updatedAt: new Date("2026-07-15T00:02:00.000Z"),
    });
    const unblockAt = new Date("2026-07-15T00:10:00.000Z");
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId, taskId: issueId },
      status: "failed",
      requestedAt: unblockAt,
      finishedAt: unblockAt,
      error: "simulated delivery failure",
    });

    const result = await reconcileDeliveryControlShadow(db, {
      companyId,
      now: new Date("2026-07-15T00:12:00.000Z"),
    });

    expect(result).toMatchObject({ checked: 1, observed: 1, failed: 0 });
    const observation = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.delivery_control_shadow_finding"))
      .then((rows) => rows[0]);
    expect(observation?.details).toMatchObject({
      livenessState: "stalled",
      startSla: { status: "pending", observedStartAt: null },
      audit: {
        measurementStartAt: unblockAt.toISOString(),
        runStartAt: null,
        resultAt: null,
      },
    });
  });

  it("starts a fresh SLA phase from a user comment even when no wake was persisted", async () => {
    process.env.PAPERCLIP_DELIVERY_CONTROL_MODE = "shadow";
    const { companyId, issueId } = await seedCriticalIssue();
    const commentAt = new Date("2026-07-15T00:10:00.000Z");
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorUserId: "operator-1",
      authorType: "user",
      body: "Please continue through live acceptance.",
      createdAt: commentAt,
      updatedAt: commentAt,
    });

    await reconcileDeliveryControlShadow(db, {
      companyId,
      now: new Date("2026-07-15T00:12:00.000Z"),
    });

    const observation = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.delivery_control_shadow_finding"))
      .then((rows) => rows[0]);
    expect(observation?.details).toMatchObject({
      startSla: { status: "pending", deadlineAt: "2026-07-15T00:15:00.000Z" },
      audit: { measurementStartAt: commentAt.toISOString() },
    });
  });

  it("treats only an explicit healthy blocks edge as a covered dependency path", async () => {
    process.env.PAPERCLIP_DELIVERY_CONTROL_MODE = "shadow";
    const { companyId, issueId } = await seedCriticalIssue();
    const blockerIssueId = randomUUID();
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issueId));
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId,
      identifier: "DCT-2",
      title: "Human-owned dependency",
      status: "backlog",
      priority: "medium",
      assigneeUserId: "operator-1",
      createdAt: new Date("2026-07-15T00:00:00.000Z"),
      updatedAt: new Date("2026-07-15T00:00:00.000Z"),
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: issueId,
      type: "blocks",
    });

    const result = await reconcileDeliveryControlShadow(db, {
      companyId,
      now: new Date("2026-07-15T00:06:00.000Z"),
    });

    expect(result).toMatchObject({ checked: 1, observed: 1, failed: 0 });
    const observation = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.delivery_control_shadow_finding"))
      .then((rows) => rows[0]);
    expect(observation?.details).toMatchObject({
      livenessState: "covered",
      startSla: { status: "not_applicable", deadlineAt: null },
    });
  });

  it("rotates a bounded scan fairly instead of rescanning the oldest issue forever", async () => {
    process.env.PAPERCLIP_DELIVERY_CONTROL_MODE = "shadow";
    const { companyId, agentId, issueId } = await seedCriticalIssue();
    const secondIssueId = randomUUID();
    await db.insert(issues).values({
      id: secondIssueId,
      companyId,
      identifier: "DCT-2",
      title: "Second critical queued work",
      status: "todo",
      priority: "critical",
      assigneeAgentId: agentId,
      createdAt: new Date("2026-07-15T00:01:00.000Z"),
      updatedAt: new Date("2026-07-15T00:01:00.000Z"),
    });

    const first = await reconcileDeliveryControlShadow(db, {
      companyId,
      now: new Date("2026-07-15T00:06:00.000Z"),
      limit: 1,
    });
    const second = await reconcileDeliveryControlShadow(db, {
      companyId,
      now: new Date("2026-07-15T00:07:00.000Z"),
      limit: 1,
    });

    expect(first.issueIds).toEqual([issueId]);
    expect(second.issueIds).toEqual([secondIssueId]);
  });

  it("propagates Critical priority only along an explicit active blocks path in enforce mode", async () => {
    const { companyId, agentId, issueId } = await seedCriticalIssue();
    process.env.PAPERCLIP_DELIVERY_CONTROL_MODE = "enforce";
    process.env.PAPERCLIP_DELIVERY_CONTROL_COMPANY_IDS = companyId;
    const blockerIssueId = randomUUID();
    const unrelatedIssueId = randomUUID();
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issueId));
    await db.insert(issues).values([
      {
        id: blockerIssueId,
        companyId,
        identifier: "DCT-2",
        title: "Executable blocker",
        status: "todo",
        priority: "low",
        assigneeAgentId: agentId,
        createdAt: new Date("2026-07-15T00:00:00.000Z"),
        updatedAt: new Date("2026-07-15T00:00:00.000Z"),
      },
      {
        id: unrelatedIssueId,
        companyId,
        identifier: "DCT-3",
        title: "Unrelated low priority work",
        status: "todo",
        priority: "low",
        assigneeAgentId: agentId,
        createdAt: new Date("2026-07-15T00:00:00.000Z"),
        updatedAt: new Date("2026-07-15T00:00:00.000Z"),
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: issueId,
      type: "blocks",
    });

    const result = await reconcileDeliveryControlShadow(db, {
      companyId,
      now: new Date("2026-07-15T00:06:00.000Z"),
    });

    expect(result.priorityPropagated).toBe(1);
    const priorities = await db
      .select({ id: issues.id, priority: issues.priority })
      .from(issues)
      .where(inArray(issues.id, [blockerIssueId, unrelatedIssueId]));
    expect(priorities.find((row) => row.id === blockerIssueId)?.priority).toBe("critical");
    expect(priorities.find((row) => row.id === unrelatedIssueId)?.priority).toBe("low");
  });

  it("emits one delta-rich communication and suppresses a no-op tick", async () => {
    const { companyId } = await seedCriticalIssue();
    process.env.PAPERCLIP_DELIVERY_CONTROL_MODE = "enforce";
    process.env.PAPERCLIP_DELIVERY_CONTROL_COMPANY_IDS = companyId;

    const first = await reconcileDeliveryControlShadow(db, {
      companyId,
      now: new Date("2026-07-15T00:02:00.000Z"),
    });
    const noOp = await reconcileDeliveryControlShadow(db, {
      companyId,
      now: new Date("2026-07-15T00:03:00.000Z"),
    });

    expect(first.communicationsEmitted).toBe(1);
    expect(noOp.communicationsEmitted).toBe(0);
    expect(await db.select().from(issueComments)).toHaveLength(1);
    expect(await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.delivery_control_communication"))).toHaveLength(1);
  });

  it("enforces only selected issue canaries while observing the rest of the company in shadow", async () => {
    const { companyId, agentId, issueId } = await seedCriticalIssue();
    const shadowIssueId = randomUUID();
    await db.insert(issues).values({
      id: shadowIssueId,
      companyId,
      identifier: "DCT-2",
      title: "Company-wide shadow issue",
      status: "todo",
      priority: "critical",
      assigneeAgentId: agentId,
      createdAt: new Date("2026-07-15T00:00:00.000Z"),
      updatedAt: new Date("2026-07-15T00:00:00.000Z"),
    });
    process.env.PAPERCLIP_DELIVERY_CONTROL_MODE = "enforce";
    process.env.PAPERCLIP_DELIVERY_CONTROL_COMPANY_IDS = companyId;
    process.env.PAPERCLIP_DELIVERY_CONTROL_ISSUE_IDS = issueId;

    const result = await reconcileDeliveryControlShadow(db, {
      companyId,
      now: new Date("2026-07-15T00:02:00.000Z"),
    });

    expect(result).toMatchObject({ checked: 2, communicationsEmitted: 1, failed: 0 });
    expect(await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.delivery_control_enforcement_observation")))
      .toMatchObject([{ entityId: issueId }]);
    expect(await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.delivery_control_shadow_finding")))
      .toMatchObject([{ entityId: shadowIssueId }]);
  });

  it("emits recent root live acceptance exactly once and leaves the watchdog terminal", async () => {
    const { companyId, issueId } = await seedCriticalIssue();
    process.env.PAPERCLIP_DELIVERY_CONTROL_MODE = "enforce";
    process.env.PAPERCLIP_DELIVERY_CONTROL_COMPANY_IDS = companyId;
    const completedAt = new Date("2026-07-15T00:10:00.000Z");
    await db
      .update(issues)
      .set({ status: "done", completedAt, updatedAt: completedAt })
      .where(eq(issues.id, issueId));

    const first = await reconcileDeliveryControlShadow(db, {
      companyId,
      now: new Date("2026-07-15T00:11:00.000Z"),
    });
    const duplicate = await reconcileDeliveryControlShadow(db, {
      companyId,
      now: new Date("2026-07-15T00:12:00.000Z"),
    });

    expect(first.terminalAcceptancesEmitted).toBe(1);
    expect(duplicate.terminalAcceptancesEmitted).toBe(0);
    const [communication] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.delivery_control_communication"));
    expect(communication?.details).toMatchObject({ reason: "live_acceptance" });
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
  });

  it("enqueues at most two recovery wakes, escalates the CEO once, then creates a blocker", async () => {
    const { companyId, agentId, issueId } = await seedCriticalIssue();
    const ceoId = randomUUID();
    await db.insert(agents).values({
      id: ceoId,
      companyId,
      name: "CEO",
      role: "ceo",
      status: "idle",
    });
    process.env.PAPERCLIP_DELIVERY_CONTROL_MODE = "enforce";
    process.env.PAPERCLIP_DELIVERY_CONTROL_COMPANY_IDS = companyId;
    let wakeNow = new Date("2026-07-15T00:16:00.000Z");
    const wakes: Array<{ agentId: string; reason: string; idempotencyKey: string }> = [];
    const enqueueWakeup = async (
      wakeAgentId: string,
      options: { reason: string; idempotencyKey: string; contextSnapshot: Record<string, unknown> },
    ) => {
      const runId = randomUUID();
      wakes.push({ agentId: wakeAgentId, reason: options.reason, idempotencyKey: options.idempotencyKey });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId: wakeAgentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "failed",
        contextSnapshot: options.contextSnapshot,
        error: "simulated failed recovery",
        finishedAt: wakeNow,
        createdAt: wakeNow,
        updatedAt: wakeNow,
      });
      return { id: runId };
    };

    const [first, simultaneous] = await Promise.all([
      reconcileDeliveryControlShadow(db, { companyId, now: wakeNow }, { enqueueWakeup }),
      reconcileDeliveryControlShadow(db, { companyId, now: wakeNow }, { enqueueWakeup }),
    ]);
    const duplicate = await reconcileDeliveryControlShadow(
      db,
      { companyId, now: new Date("2026-07-15T00:17:00.000Z") },
      { enqueueWakeup },
    );
    wakeNow = new Date("2026-07-15T00:31:00.000Z");
    const second = await reconcileDeliveryControlShadow(db, { companyId, now: wakeNow }, { enqueueWakeup });
    wakeNow = new Date("2026-07-15T00:46:00.000Z");
    const exhausted = await reconcileDeliveryControlShadow(db, { companyId, now: wakeNow }, { enqueueWakeup });
    await reconcileDeliveryControlShadow(
      db,
      { companyId, now: new Date("2026-07-15T00:47:00.000Z") },
      { enqueueWakeup },
    );

    expect(first.recoveriesEnqueued + simultaneous.recoveriesEnqueued).toBe(1);
    expect(duplicate.recoveriesEnqueued).toBe(0);
    expect(second).toMatchObject({ recoveriesEnqueued: 1, escalationsCreated: 1 });
    expect(exhausted.blockersCreated).toBe(1);
    expect(wakes.filter((wake) => wake.reason === "issue_assignment_recovery")).toHaveLength(2);
    expect(wakes.filter((wake) => wake.reason === "source_scoped_recovery_action")).toHaveLength(1);
    expect(new Set(wakes.map((wake) => wake.idempotencyKey)).size).toBe(wakes.length);
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(action).toMatchObject({
      status: "escalated",
      cause: "delivery_control_liveness_exhausted",
      attemptCount: 2,
      maxAttempts: 2,
      ownerAgentId: ceoId,
    });
    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(sourceIssue?.status).toBe("blocked");
    expect(await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.delivery_control_ceo_escalated"))).toHaveLength(1);
  });
});
