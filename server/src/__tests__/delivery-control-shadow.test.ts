import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
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

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-delivery-control-shadow-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    if (previousMode === undefined) delete process.env.PAPERCLIP_DELIVERY_CONTROL_MODE;
    else process.env.PAPERCLIP_DELIVERY_CONTROL_MODE = previousMode;
    if (previousCompanyIds === undefined) delete process.env.PAPERCLIP_DELIVERY_CONTROL_COMPANY_IDS;
    else process.env.PAPERCLIP_DELIVERY_CONTROL_COMPANY_IDS = previousCompanyIds;
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
});
