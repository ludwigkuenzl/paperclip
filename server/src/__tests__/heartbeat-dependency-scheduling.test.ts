import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companySkills,
  companies,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRecoveryActions,
  issueRelations,
  issueTreeHolds,
  issues,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Dependency-aware heartbeat test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat dependency scheduling tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

describeEmbeddedPostgres("heartbeat dependency-aware queued run selection", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-dependency-scheduling-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Dependency-aware heartbeat test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(issueRecoveryActions);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(issueTreeHolds);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(environments);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(environmentLeases);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await db.transaction(async (tx) => {
          await tx.delete(companySkills);
          await tx.delete(companies);
        });
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("reads only company-, issue-, and agent-scoped live execution paths", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const retryIssueId = randomUUID();
    const wakeIssueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Execution Path Co",
      issuePrefix: `E${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "ExecutionOwner",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "OtherAgent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      contextSnapshot: { issueId: retryIssueId },
      scheduledRetryAt: new Date(Date.now() + 60_000),
    });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId: wakeIssueId },
      status: "deferred_issue_execution",
    });

    await expect(heartbeat.getIssueExecutionPath(companyId, retryIssueId, agentId)).resolves.toMatchObject({
      kind: "run",
      status: "scheduled_retry",
      agentId,
    });
    await expect(heartbeat.getIssueExecutionPath(companyId, wakeIssueId, agentId)).resolves.toMatchObject({
      kind: "wake",
      status: "deferred_issue_execution",
      agentId,
    });
    await expect(heartbeat.getIssueExecutionPath(companyId, retryIssueId, otherAgentId)).resolves.toBeNull();
    await expect(heartbeat.getIssueExecutionPath(randomUUID(), retryIssueId, agentId)).resolves.toBeNull();
  });

  it("enqueues one company-scoped dependency execution for concurrent same- and cross-agent callers", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const competingAgentId = randomUUID();
    const blockerId = randomUUID();
    const dependentIssueId = randomUUID();
    const idempotencyKey = `issue_blockers_resolved:${dependentIssueId}:${blockerId}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "DependencyWorker",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            wakeOnDemand: true,
            maxConcurrentRuns: 1,
          },
        },
        permissions: {},
      },
      {
        id: competingAgentId,
        companyId,
        name: "ReassignedDependencyWorker",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            wakeOnDemand: true,
            maxConcurrentRuns: 1,
          },
        },
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: dependentIssueId,
      companyId,
      title: "Resume after final blocker",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    let finishRun!: () => void;
    const runCanFinish = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    mockAdapterExecute.mockImplementation(async () => {
      await runCanFinish;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Concurrent dependency wake completed.",
        provider: "test",
        model: "test-model",
      };
    });

    const wakeOptions = {
      source: "automation" as const,
      triggerDetail: "system" as const,
      reason: "issue_blockers_resolved",
      payload: {
        issueId: dependentIssueId,
        resolvedBlockerIssueId: blockerId,
      },
      contextSnapshot: {
        issueId: dependentIssueId,
        wakeReason: "issue_blockers_resolved",
        resolvedBlockerIssueId: blockerId,
      },
      idempotencyKey,
    };

    const [firstRun, secondRun, crossAgentRun] = await Promise.all([
      heartbeat.wakeup(agentId, wakeOptions),
      heartbeat.wakeup(agentId, wakeOptions),
      heartbeat.wakeup(competingAgentId, wakeOptions),
    ]);

    expect(firstRun).not.toBeNull();
    expect(secondRun?.id).toBe(firstRun?.id);
    expect(crossAgentRun?.id).toBe(firstRun?.id);
    const wakeRequests = await db
      .select({ id: agentWakeupRequests.id, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
        ),
      );
    expect(wakeRequests).toHaveLength(1);
    expect(wakeRequests[0]?.runId).toBe(firstRun?.id);

    await db.insert(issueComments).values({
      companyId,
      issueId: dependentIssueId,
      authorAgentId: firstRun!.agentId,
      authorType: "agent",
      createdByRunId: firstRun!.id,
      body: "Concurrent dependency wake completed.",
    });
    await db
      .update(issues)
      .set({ status: "done", updatedAt: new Date() })
      .where(eq(issues.id, dependentIssueId));
    finishRun();

    expect(await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, firstRun!.id))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    })).toBe(true);
  });

  it("keeps blocked descendants idle until their blockers resolve", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockerId = randomUUID();
    const blockedIssueId = randomUUID();
    const readyIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Mission 0",
        status: "todo",
        priority: "high",
        responsibleUserId: "responsible-user",
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Mission 2",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
      {
        id: readyIssueId,
        companyId,
        title: "Mission 1",
        status: "todo",
        priority: "critical",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const blockedWake = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: blockedIssueId },
      contextSnapshot: { issueId: blockedIssueId, wakeReason: "issue_assigned" },
    });
    expect(blockedWake).toBeNull();

    const blockedWakeRequest = await waitForCondition(async () => {
      const wakeup = await db
        .select({
          status: agentWakeupRequests.status,
          reason: agentWakeupRequests.reason,
        })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.agentId, agentId),
            sql`${agentWakeupRequests.payload} ->> 'issueId' = ${blockedIssueId}`,
          ),
        )
        .orderBy(agentWakeupRequests.requestedAt)
        .then((rows) => rows[0] ?? null);
      return Boolean(
        wakeup &&
        wakeup.status === "skipped" &&
        wakeup.reason === "issue_dependencies_blocked",
      );
    });
    expect(blockedWakeRequest).toBe(true);

    const blockedRunsBeforeResolution = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${blockedIssueId}`)
      .then((rows) => rows[0]?.count ?? 0);
    expect(blockedRunsBeforeResolution).toBe(0);

    const recoveryActionId = randomUUID();
    await db.insert(issueRecoveryActions).values({
      id: recoveryActionId,
      companyId,
      sourceIssueId: blockedIssueId,
      kind: "issue_graph_liveness",
      status: "active",
      ownerType: "agent",
      ownerAgentId: agentId,
      previousOwnerAgentId: agentId,
      returnOwnerAgentId: agentId,
      cause: "delivery_control_liveness",
      fingerprint: "delivery-control-dependency-recovery",
      evidence: {},
      nextAction: "Restore an executable dependency or monitor path.",
      attemptCount: 1,
      maxAttempts: 2,
      timeoutAt: new Date(Date.now() + 60_000),
      lastAttemptAt: new Date(),
    });

    const forgedRecoveryWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assignment_recovery",
      payload: { issueId: blockedIssueId },
      contextSnapshot: {
        issueId: blockedIssueId,
        wakeReason: "issue_assignment_recovery",
        retryReason: "delivery_control_liveness",
        source: "delivery_control.reconcile",
        recoveryActionId: randomUUID(),
      },
    });
    expect(forgedRecoveryWake).toBeNull();

    const recoveryWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assignment_recovery",
      payload: { issueId: blockedIssueId, recoveryActionId },
      contextSnapshot: {
        issueId: blockedIssueId,
        wakeReason: "issue_assignment_recovery",
        retryReason: "delivery_control_liveness",
        source: "delivery_control.reconcile",
        recoveryActionId,
      },
    });
    expect(recoveryWake).not.toBeNull();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, recoveryWake!.id))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const recoveryRun = await db
      .select({
        status: heartbeatRuns.status,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, recoveryWake!.id))
      .then((rows) => rows[0] ?? null);
    expect(recoveryRun?.status).toBe("succeeded");
    expect(recoveryRun?.contextSnapshot).toMatchObject({
      dependencyBlockedInteraction: true,
      dependencyBlockedRecovery: true,
      unresolvedBlockerIssueIds: [blockerId],
    });

    const interactionWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: blockedIssueId, commentId: randomUUID() },
      contextSnapshot: {
        issueId: blockedIssueId,
        wakeReason: "issue_commented",
      },
    });
    expect(interactionWake).not.toBeNull();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, interactionWake!.id))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const interactionRun = await db
      .select({
        status: heartbeatRuns.status,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, interactionWake!.id))
      .then((rows) => rows[0] ?? null);

    expect(interactionRun?.status).toBe("succeeded");
    expect(interactionRun?.contextSnapshot).toMatchObject({
      dependencyBlockedInteraction: true,
      unresolvedBlockerIssueIds: [blockerId],
    });

    let finishReadyRun!: () => void;
    const readyRunCanFinish = new Promise<void>((resolve) => {
      finishReadyRun = resolve;
    });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await readyRunCanFinish;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Ready dependency scheduling run complete.",
        provider: "test",
        model: "test-model",
      };
    });

    const readyWake = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: readyIssueId },
      contextSnapshot: { issueId: readyIssueId, wakeReason: "issue_assigned" },
    });
    expect(readyWake).not.toBeNull();
    await db.insert(issueComments).values({
      companyId,
      issueId: readyIssueId,
      authorAgentId: agentId,
      authorType: "agent",
      createdByRunId: readyWake!.id,
      body: "Ready dependency scheduling run complete.",
    });
    finishReadyRun();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, readyWake!.id))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const readyRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, readyWake!.id))
      .then((rows) => rows[0] ?? null);

    expect(readyRun?.status).toBe("succeeded");

    await db
      .update(issues)
      .set({ status: "done", updatedAt: new Date() })
      .where(eq(issues.id, blockerId));

    const promotedWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId: blockedIssueId, resolvedBlockerIssueId: blockerId },
      contextSnapshot: {
        issueId: blockedIssueId,
        wakeReason: "issue_blockers_resolved",
        resolvedBlockerIssueId: blockerId,
      },
    });
    expect(promotedWake).not.toBeNull();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, promotedWake!.id))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const promotedBlockedRun = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, promotedWake!.id))
      .then((rows) => rows[0] ?? null);
    const blockedWakeRequestCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${blockedIssueId}`,
        ),
      )
      .then((rows) => rows[0]?.count ?? 0);

    expect(promotedBlockedRun?.status).toBe("succeeded");
    expect(blockedWakeRequestCount).toBeGreaterThanOrEqual(2);

    const noActiveRuns = await waitForCondition(async () => {
      const rows = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      return rows.every((run) => run.status !== "queued" && run.status !== "running");
    }, 10_000);
    expect(noActiveRuns).toBe(true);
  });

  it("defers issue_blockers_resolved as a follow-up when the same issue is already running", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockerId = randomUUID();
    const blockedIssueId = randomUUID();
    const activeRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: activeRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "on_demand",
      contextSnapshot: {
        issueId: blockedIssueId,
        wakeReason: "manual_test_active_run",
      },
    });
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Completed prerequisite",
        status: "done",
        priority: "medium",
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked dependent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
        executionRunId: activeRunId,
        executionLockedAt: new Date(),
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });
    runningProcesses.set(activeRunId, {
      child: {} as import("node:child_process").ChildProcess,
      graceSec: 1,
      processGroupId: null,
    });

    const idempotencyKey = `issue_blockers_resolved:${blockedIssueId}:${blockerId}`;
    const wakeOptions = {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerId,
      },
      idempotencyKey,
      contextSnapshot: {
        issueId: blockedIssueId,
        wakeReason: "issue_blockers_resolved",
        resolvedBlockerIssueId: blockerId,
      },
    } as const;
    const [firstWake, concurrentWake] = await Promise.all([
      heartbeat.wakeup(agentId, wakeOptions),
      heartbeat.wakeup(agentId, wakeOptions),
    ]);

    expect(firstWake).toBeNull();
    expect(concurrentWake).toBeNull();

    const wakeRequests = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
        runId: agentWakeupRequests.runId,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey));

    expect(wakeRequests).toEqual([
      expect.objectContaining({
        status: "deferred_issue_execution",
        reason: "issue_execution_deferred",
        idempotencyKey,
        runId: null,
      }),
    ]);

    runningProcesses.delete(activeRunId);
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, activeRunId));
  });

  it("honors maxConcurrentRuns 1 by leaving a second assignment wake queued", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const firstIssueId = randomUUID();
    const secondIssueId = randomUUID();
    let finishFirstRun!: () => void;
    const firstRunFinished = new Promise<void>((resolve) => {
      finishFirstRun = resolve;
    });

    mockAdapterExecute.mockImplementationOnce(async () => {
      await firstRunFinished;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "First assignment run completed.",
        provider: "test",
        model: "test-model",
      };
    });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: firstIssueId,
        companyId,
        title: "First assignment",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
      {
        id: secondIssueId,
        companyId,
        title: "Second assignment",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
    ]);

    try {
      const firstWake = await heartbeat.wakeup(agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: firstIssueId },
        contextSnapshot: { issueId: firstIssueId, wakeReason: "issue_assigned" },
      });
      expect(firstWake).not.toBeNull();
      await db.insert(issueComments).values({
        companyId,
        issueId: firstIssueId,
        authorAgentId: agentId,
        authorType: "agent",
        createdByRunId: firstWake!.id,
        body: "First assignment run completed.",
      });

      const firstRunStarted = await waitForCondition(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, firstWake!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "running";
      });
      expect(firstRunStarted).toBe(true);
      const firstAdapterStarted = await waitForCondition(async () => mockAdapterExecute.mock.calls.length === 1, 30_000);
      expect(firstAdapterStarted).toBe(true);

      const secondWake = await heartbeat.wakeup(agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: secondIssueId },
        contextSnapshot: { issueId: secondIssueId, wakeReason: "issue_assigned" },
      });
      expect(secondWake).not.toBeNull();
      await db.insert(issueComments).values({
        companyId,
        issueId: secondIssueId,
        authorAgentId: agentId,
        authorType: "agent",
        createdByRunId: secondWake!.id,
        body: "Second assignment run completed.",
      });

      const secondRunWhileFirstRunning = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, secondWake!.id))
        .then((rows) => rows[0] ?? null);
      expect(secondRunWhileFirstRunning?.status).toBe("queued");
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);

      finishFirstRun();

      const firstRunSucceeded = await waitForCondition(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, firstWake!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "succeeded";
      });
      expect(firstRunSucceeded).toBe(true);

      const secondRunSucceeded = await waitForCondition(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, secondWake!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "succeeded";
      }, 10_000);
      expect(secondRunSucceeded).toBe(true);
      expect(mockAdapterExecute.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      finishFirstRun();
    }
  }, 40_000);

  it("atomically starts only one assigned run for the same issue", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const firstRunId = randomUUID();
    const secondRunId = randomUUID();
    let finishFirstRun!: () => void;
    const firstRunFinished = new Promise<void>((resolve) => {
      finishFirstRun = resolve;
    });

    mockAdapterExecute.mockImplementationOnce(async () => {
      await firstRunFinished;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "First same-issue run completed.",
        provider: "test",
        model: "test-model",
      };
    });

    await db.insert(companies).values({
      id: companyId,
      name: "Atomic Issue Claim",
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "AtomicWorker",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "One issue, one executing owner",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    await db.insert(heartbeatRuns).values([
      {
        id: firstRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
        createdAt: new Date("2026-07-15T00:00:00.000Z"),
        updatedAt: new Date("2026-07-15T00:00:00.000Z"),
      },
      {
        id: secondRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
        createdAt: new Date("2026-07-15T00:00:01.000Z"),
        updatedAt: new Date("2026-07-15T00:00:01.000Z"),
      },
    ]);
    await db.insert(issueComments).values([
      {
        companyId,
        issueId,
        authorAgentId: agentId,
        authorType: "agent",
        createdByRunId: firstRunId,
        body: "First same-issue run completed.",
      },
      {
        companyId,
        issueId,
        authorAgentId: agentId,
        authorType: "agent",
        createdByRunId: secondRunId,
        body: "Second same-issue run completed.",
      },
    ]);

    try {
      await heartbeat.resumeQueuedRuns();
      const firstStarted = await waitForCondition(async () => {
        const [run] = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, firstRunId));
        return run?.status === "running";
      });
      expect(firstStarted).toBe(true);

      const [secondWhileFirstRuns] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, secondRunId));
      const [issueWhileFirstRuns] = await db
        .select({ executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, issueId));
      expect(secondWhileFirstRuns?.status).toBe("queued");
      expect(issueWhileFirstRuns?.executionRunId).toBe(firstRunId);
      const callsForRun = (runId: string) => mockAdapterExecute.mock.calls.filter(
        (call) => (call[0] as { runId?: string } | undefined)?.runId === runId,
      );
      const firstAdapterStarted = await waitForCondition(async () => callsForRun(firstRunId).length === 1);
      expect(firstAdapterStarted).toBe(true);

      finishFirstRun();
      const secondSucceeded = await waitForCondition(async () => {
        const [run] = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, secondRunId));
        return run?.status === "succeeded";
      }, 10_000);
      expect(secondSucceeded).toBe(true);
      expect(callsForRun(firstRunId)).toHaveLength(1);
      expect(callsForRun(secondRunId)).toHaveLength(1);
    } finally {
      finishFirstRun();
    }
  }, 40_000);

  it("serializes the same explicit resource while allowing different issues to queue", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const firstIssueId = randomUUID();
    const secondIssueId = randomUUID();
    const firstRunId = randomUUID();
    const secondRunId = randomUUID();
    let finishFirstRun!: () => void;
    const firstRunFinished = new Promise<void>((resolve) => {
      finishFirstRun = resolve;
    });

    mockAdapterExecute.mockImplementation(async (input: { runId: string }) => {
      if (input.runId === firstRunId) await firstRunFinished;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: `Resource-controlled run ${input.runId} completed.`,
        provider: "test",
        model: "test-model",
      };
    });

    await db.insert(companies).values({
      id: companyId,
      name: "Resource Claim",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ResourceWorker",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 } },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: firstIssueId,
        companyId,
        title: "Deploy first change",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
        executionWorkspaceSettings: {
          resourceControl: {
            actionClass: "deploy",
            resourceKey: "deploy:production",
            changeId: "sha-first",
            idempotencyKey: "deploy-production-sha-first",
          },
        },
      },
      {
        id: secondIssueId,
        companyId,
        title: "Deploy second change",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
        executionWorkspaceSettings: {
          resourceControl: {
            actionClass: "deploy",
            resourceKey: "deploy:production",
            changeId: "sha-second",
            idempotencyKey: "deploy-production-sha-second",
          },
        },
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: firstRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: { issueId: firstIssueId, wakeReason: "issue_assigned" },
        createdAt: new Date("2026-07-15T00:00:00.000Z"),
        updatedAt: new Date("2026-07-15T00:00:00.000Z"),
      },
      {
        id: secondRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: { issueId: secondIssueId, wakeReason: "issue_assigned" },
        createdAt: new Date("2026-07-15T00:00:01.000Z"),
        updatedAt: new Date("2026-07-15T00:00:01.000Z"),
      },
    ]);
    await db.insert(issueComments).values([
      {
        companyId,
        issueId: firstIssueId,
        authorAgentId: agentId,
        authorType: "agent",
        createdByRunId: firstRunId,
        body: "First resource-controlled run completed.",
      },
      {
        companyId,
        issueId: secondIssueId,
        authorAgentId: agentId,
        authorType: "agent",
        createdByRunId: secondRunId,
        body: "Second resource-controlled run completed.",
      },
    ]);

    try {
      await heartbeat.resumeQueuedRuns();
      const firstStarted = await waitForCondition(async () => {
        const [run] = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, firstRunId));
        return run?.status === "running";
      });
      expect(firstStarted).toBe(true);
      const firstAdapterStarted = await waitForCondition(async () => mockAdapterExecute.mock.calls.some(
        (call) => (call[0] as { runId?: string } | undefined)?.runId === firstRunId,
      ));
      expect(firstAdapterStarted).toBe(true);
      const firstAdapterContext = mockAdapterExecute.mock.calls.find(
        (call) => (call[0] as { runId?: string } | undefined)?.runId === firstRunId,
      )?.[0] as {
        context?: { paperclipResourceControl?: Record<string, unknown> };
        config?: { env?: Record<string, string> };
      } | undefined;
      expect(firstAdapterContext?.context?.paperclipResourceControl).toMatchObject({
        actionClass: "deploy",
        resourceKey: "deploy:production",
        changeId: "sha-first",
        fencingToken: 1,
      });
      expect(firstAdapterContext?.config?.env).toMatchObject({
        PAPERCLIP_RESOURCE_KEY: "deploy:production",
        PAPERCLIP_RESOURCE_CHANGE_ID: "sha-first",
        PAPERCLIP_RESOURCE_FENCING_TOKEN: "1",
      });
      const [waiting] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, secondRunId));
      expect(waiting?.status).toBe("queued");
      expect(mockAdapterExecute.mock.calls.filter(
        (call) => (call[0] as { runId?: string } | undefined)?.runId === secondRunId,
      )).toHaveLength(0);

      finishFirstRun();
      const secondSucceeded = await waitForCondition(async () => {
        const [run] = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, secondRunId));
        return run?.status === "succeeded";
      }, 10_000);
      expect(secondSucceeded).toBe(true);
      expect(mockAdapterExecute.mock.calls.filter(
        (call) => (call[0] as { runId?: string } | undefined)?.runId === secondRunId,
      )).toHaveLength(1);
    } finally {
      finishFirstRun();
    }
  }, 40_000);

  it("denies an exclusive resource action for a non-assignee mention run", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const mentionedAgentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Resource Ownership",
      issuePrefix: `O${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "DeployOwner",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: mentionedAgentId,
        companyId,
        name: "MentionedReviewer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Owner-only deployment",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: ownerAgentId,
      responsibleUserId: "responsible-user",
      executionWorkspaceSettings: {
        resourceControl: {
          actionClass: "deploy",
          resourceKey: "deploy:production",
          changeId: "sha-owner-only",
          idempotencyKey: "deploy-production-sha-owner-only",
        },
      },
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: mentionedAgentId,
      invocationSource: "mention",
      triggerDetail: "agent_mention",
      status: "queued",
      contextSnapshot: { issueId, commentId: randomUUID(), wakeReason: "issue_comment_mentioned" },
    });

    await heartbeat.resumeQueuedRuns();
    const denied = await waitForCondition(async () => {
      const [run] = await db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));
      return run?.status === "cancelled" && run.errorCode === "resource_control_denied";
    });
    expect(denied).toBe(true);
    expect(mockAdapterExecute.mock.calls.filter(
      (call) => (call[0] as { runId?: string } | undefined)?.runId === runId,
    )).toHaveLength(0);
  });

  it("fails closed for inferred shared writes only inside the resource-control company canary", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const previousMode = process.env.PAPERCLIP_RESOURCE_CONTROL_MODE;
    const previousCompanies = process.env.PAPERCLIP_RESOURCE_CONTROL_COMPANY_IDS;
    process.env.PAPERCLIP_RESOURCE_CONTROL_MODE = "enforce";
    process.env.PAPERCLIP_RESOURCE_CONTROL_COMPANY_IDS = companyId;

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "Shared Write Canary",
        issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "SharedWriter",
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
        title: "Unscoped shared mutation",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      });

      await heartbeat.resumeQueuedRuns();
      const denied = await waitForCondition(async () => {
        const [run] = await db
          .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, runId));
        return run?.status === "cancelled" && run.errorCode === "resource_control_denied";
      });
      expect(denied).toBe(true);
      expect(mockAdapterExecute.mock.calls.filter(
        (call) => (call[0] as { runId?: string } | undefined)?.runId === runId,
      )).toHaveLength(0);
    } finally {
      if (previousMode === undefined) delete process.env.PAPERCLIP_RESOURCE_CONTROL_MODE;
      else process.env.PAPERCLIP_RESOURCE_CONTROL_MODE = previousMode;
      if (previousCompanies === undefined) delete process.env.PAPERCLIP_RESOURCE_CONTROL_COMPANY_IDS;
      else process.env.PAPERCLIP_RESOURCE_CONTROL_COMPANY_IDS = previousCompanies;
    }
  });

  it("does not let delivery-control enforcement activate inferred resource-control denial", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const previousDeliveryMode = process.env.PAPERCLIP_DELIVERY_CONTROL_MODE;
    const previousDeliveryCompanies = process.env.PAPERCLIP_DELIVERY_CONTROL_COMPANY_IDS;
    const previousResourceMode = process.env.PAPERCLIP_RESOURCE_CONTROL_MODE;
    const previousResourceCompanies = process.env.PAPERCLIP_RESOURCE_CONTROL_COMPANY_IDS;
    process.env.PAPERCLIP_DELIVERY_CONTROL_MODE = "enforce";
    process.env.PAPERCLIP_DELIVERY_CONTROL_COMPANY_IDS = companyId;
    process.env.PAPERCLIP_RESOURCE_CONTROL_MODE = "shadow";
    process.env.PAPERCLIP_RESOURCE_CONTROL_COMPANY_IDS = companyId;

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "Independent Delivery Canary",
        issuePrefix: `I${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "IndependentWriter",
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
        title: "Existing inferred shared work",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      });
      await db.insert(issueComments).values({
        companyId,
        issueId,
        authorAgentId: agentId,
        authorType: "agent",
        createdByRunId: runId,
        body: "Existing shared work completed without resource-control opt-in.",
      });

      await heartbeat.resumeQueuedRuns();
      const succeeded = await waitForCondition(async () => {
        const [run] = await db
          .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, runId));
        return run?.status === "succeeded" && run.errorCode == null;
      }, 10_000);
      expect(succeeded).toBe(true);
      expect(mockAdapterExecute.mock.calls.some(
        (call) => (call[0] as { runId?: string } | undefined)?.runId === runId,
      )).toBe(true);
    } finally {
      if (previousDeliveryMode === undefined) delete process.env.PAPERCLIP_DELIVERY_CONTROL_MODE;
      else process.env.PAPERCLIP_DELIVERY_CONTROL_MODE = previousDeliveryMode;
      if (previousDeliveryCompanies === undefined) delete process.env.PAPERCLIP_DELIVERY_CONTROL_COMPANY_IDS;
      else process.env.PAPERCLIP_DELIVERY_CONTROL_COMPANY_IDS = previousDeliveryCompanies;
      if (previousResourceMode === undefined) delete process.env.PAPERCLIP_RESOURCE_CONTROL_MODE;
      else process.env.PAPERCLIP_RESOURCE_CONTROL_MODE = previousResourceMode;
      if (previousResourceCompanies === undefined) delete process.env.PAPERCLIP_RESOURCE_CONTROL_COMPANY_IDS;
      else process.env.PAPERCLIP_RESOURCE_CONTROL_COMPANY_IDS = previousResourceCompanies;
    }
  }, 20_000);

  it("cancels stale queued runs when issue blockers are still unresolved", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockerId = randomUUID();
    const blockedIssueId = randomUUID();
    const readyIssueId = randomUUID();
    const blockedWakeupRequestId = randomUUID();
    const readyWakeupRequestId = randomUUID();
    const blockedRunId = randomUUID();
    const readyRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "QAChecker",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 2,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Security review",
        status: "blocked",
        priority: "high",
        responsibleUserId: "responsible-user",
      },
      {
        id: blockedIssueId,
        companyId,
        title: "QA validation",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
      {
        id: readyIssueId,
        companyId,
        title: "Ready QA task",
        status: "todo",
        priority: "low",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });
    await db.insert(agentWakeupRequests).values([
      {
        id: blockedWakeupRequestId,
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "transient_failure_retry",
        payload: { issueId: blockedIssueId },
        status: "queued",
      },
      {
        id: readyWakeupRequestId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: readyIssueId },
        status: "queued",
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: blockedRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: blockedWakeupRequestId,
        contextSnapshot: {
          issueId: blockedIssueId,
          wakeReason: "transient_failure_retry",
        },
      },
      {
        id: readyRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: readyWakeupRequestId,
        contextSnapshot: {
          issueId: readyIssueId,
          wakeReason: "issue_assigned",
        },
      },
    ]);
    await db
      .update(agentWakeupRequests)
      .set({ runId: blockedRunId })
      .where(eq(agentWakeupRequests.id, blockedWakeupRequestId));
    await db
      .update(agentWakeupRequests)
      .set({ runId: readyRunId })
      .where(eq(agentWakeupRequests.id, readyWakeupRequestId));
    await db.insert(issueComments).values({
      companyId,
      issueId: readyIssueId,
      authorAgentId: agentId,
      authorType: "agent",
      createdByRunId: readyRunId,
      body: "Ready queued run completed.",
    });
    await db
      .update(issues)
      .set({
        executionRunId: blockedRunId,
        executionAgentNameKey: "qa-checker",
        executionLockedAt: new Date(),
      })
      .where(eq(issues.id, blockedIssueId));

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, readyRunId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const [blockedRun, blockedWakeup, blockedIssue, readyRun] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          finishedAt: heartbeatRuns.finishedAt,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, blockedRunId))
        .then((rows) => rows[0] ?? null),
      db
        .select({
          status: agentWakeupRequests.status,
          error: agentWakeupRequests.error,
        })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, blockedWakeupRequestId))
        .then((rows) => rows[0] ?? null),
      db
        .select({
          executionRunId: issues.executionRunId,
          executionAgentNameKey: issues.executionAgentNameKey,
          executionLockedAt: issues.executionLockedAt,
        })
        .from(issues)
        .where(eq(issues.id, blockedIssueId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, readyRunId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(blockedRun?.status).toBe("cancelled");
    expect(blockedRun?.errorCode).toBe("issue_dependencies_blocked");
    expect(blockedRun?.finishedAt).toBeTruthy();
    expect(blockedRun?.resultJson).toMatchObject({ stopReason: "issue_dependencies_blocked" });
    expect(blockedWakeup?.status).toBe("skipped");
    expect(blockedWakeup?.error).toContain("dependencies are still blocked");
    expect(blockedIssue).toMatchObject({
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });
    expect(readyRun?.status).toBe("succeeded");
    expect(mockAdapterExecute.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("suppresses normal wakeups while allowing comment interaction wakes under a pause hold", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const rootIssueId = randomUUID();
    const issueChain = Array.from({ length: 17 }, () => randomUUID());
    const deepDescendantIssueId = issueChain.at(-1)!;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SecurityEngineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        title: "Paused root",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
      ...issueChain.map((issueId, index) => ({
        id: issueId,
        companyId,
        parentId: index === 0 ? rootIssueId : issueChain[index - 1],
        title: `Paused desc ${index + 1}`,
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      })),
    ]);
    const [hold] = await db
      .insert(issueTreeHolds)
      .values({
        companyId,
        rootIssueId,
        mode: "pause",
        status: "active",
        reason: "security test hold",
        releasePolicy: { strategy: "manual" },
      })
      .returning();

    const blockedWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId: deepDescendantIssueId },
      contextSnapshot: { issueId: deepDescendantIssueId, wakeReason: "issue_blockers_resolved" },
    });

    expect(blockedWake).toBeNull();
    const skippedWake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
      })
      .from(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.payload} ->> 'issueId' = ${deepDescendantIssueId}`)
      .then((rows) => rows[0] ?? null);
    expect(skippedWake).toMatchObject({ status: "skipped", reason: "issue_tree_hold_active" });

    const childCommentId = randomUUID();
    await db.insert(issueComments).values({
      id: childCommentId,
      companyId,
      issueId: deepDescendantIssueId,
      authorUserId: "board-user",
      body: "Please respond while this hold is active.",
    });

    const forgedChildCommentWake = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_commented",
      payload: { issueId: deepDescendantIssueId, commentId: childCommentId },
      requestedByActorType: "agent",
      requestedByActorId: agentId,
    });
    expect(forgedChildCommentWake).toBeNull();

    const childCommentWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: deepDescendantIssueId, commentId: childCommentId },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      contextSnapshot: {
        issueId: deepDescendantIssueId,
        commentId: childCommentId,
        wakeCommentId: childCommentId,
        wakeReason: "issue_commented",
        source: "issue.comment",
      },
    });

    expect(childCommentWake).not.toBeNull();
    const childRun = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, childCommentWake!.id))
      .then((rows) => rows[0] ?? null);
    expect(childRun?.contextSnapshot).toMatchObject({
      treeHoldInteraction: true,
      activeTreeHold: {
        holdId: hold.id,
        rootIssueId,
        mode: "pause",
        interaction: true,
      },
    });
  });

  it("allows comment interaction wakes when a legacy hold has a full_pause note", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const rootIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SecurityEngineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: rootIssueId,
      companyId,
      title: "Paused root",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId,
      mode: "pause",
      status: "active",
      reason: "full pause",
      releasePolicy: { strategy: "manual", note: "full_pause" },
    });

    const rootCommentId = randomUUID();
    await db.insert(issueComments).values({
      id: rootCommentId,
      companyId,
      issueId: rootIssueId,
      authorUserId: "board-user",
      body: "Please respond while this hold is active.",
    });

    const rootCommentWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: rootIssueId, commentId: rootCommentId },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      contextSnapshot: {
        issueId: rootIssueId,
        commentId: rootCommentId,
        wakeCommentId: rootCommentId,
        wakeReason: "issue_commented",
        source: "issue.comment",
      },
    });

    expect(rootCommentWake).not.toBeNull();
    const rootRun = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, rootCommentWake!.id))
      .then((rows) => rows[0] ?? null);
    expect(rootRun?.contextSnapshot).toMatchObject({
      treeHoldInteraction: true,
      activeTreeHold: {
        rootIssueId,
        mode: "pause",
        interaction: true,
      },
    });
  });
});
