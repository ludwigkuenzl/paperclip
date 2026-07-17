import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  createChild: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  triggerIssueMonitor: vi.fn(async () => ({ outcome: "triggered" as const })),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  getIssueExecutionPath: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => false),
  decide: vi.fn(),
  hasPermission: vi.fn(async () => false),
}));
const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({
  then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve([{
      companyId: "company-1",
      agentId: "33333333-3333-4333-8333-333333333333",
      contextSnapshot: null,
      permissions: null,
    }]).then(onFulfilled, onRejected),
})));
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({ where: mockDbSelectWhere })));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
  transaction: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  listForIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
}));
const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(async () => []),
}));
const mockIssueRecoveryActionService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
  listActiveForIssues: vi.fn(async () => new Map()),
  upsertSourceScoped: vi.fn(async () => ({ id: "recovery-action-1" })),
}));
const originalLifecycleEnforcementMode = process.env.PAPERCLIP_ISSUE_LIFECYCLE_ENFORCEMENT;
const originalLifecycleEnforcementCompanies = process.env.PAPERCLIP_ISSUE_LIFECYCLE_ENFORCEMENT_COMPANY_IDS;

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => mockAccessService,
    agentService: () => ({
      getById: vi.fn(async (agentId: string) => ({
        id: agentId,
        companyId: "company-1",
        permissions: null,
      })),
      resolveByReference: vi.fn(async (_companyId: string, reference: string) => ({
        ambiguous: false,
        agent: {
          id: reference,
          companyId: "company-1",
          status: "idle",
          orgChainHealth: { status: "healthy" },
        },
      })),
    }),
    companySkillService: () => ({
      completeTestRunForIssue: vi.fn(async () => null),
    }),
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    environmentService: () => ({
      getById: vi.fn(async () => null),
    }),
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    issueApprovalService: () => mockIssueApprovalService,
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueRecoveryActionService: () => mockIssueRecoveryActionService,
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

type TestActor =
  | {
      type: "board";
      userId: string;
      companyIds: string[];
      source: "local_implicit";
      isInstanceAdmin: boolean;
    }
  | {
      type: "agent";
      agentId: string;
      companyId: string;
      runId: string | null;
    };

async function createApp(actor?: TestActor) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue execution policy routes", () => {
  beforeEach(() => {
    process.env.PAPERCLIP_ISSUE_LIFECYCLE_ENFORCEMENT = "shadow";
    process.env.PAPERCLIP_ISSUE_LIFECYCLE_ENFORCEMENT_COMPANY_IDS = "company-1";
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockResolvedValue([]);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(null);
    mockIssueRecoveryActionService.listActiveForIssues.mockResolvedValue(new Map());
    mockIssueRecoveryActionService.upsertSourceScoped.mockResolvedValue({ id: "recovery-action-1" });
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "queued-run-1" });
    mockHeartbeatService.getIssueExecutionPath.mockResolvedValue(null);
    mockDbSelect.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockDb.transaction.mockImplementation(async (callback: (tx: typeof mockDb) => unknown) => callback(mockDb));
    mockDbSelectFrom.mockImplementation(() => ({ where: mockDbSelectWhere }));
    mockDbSelectWhere.mockImplementation(() => ({
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([{
          companyId: "company-1",
          agentId: "33333333-3333-4333-8333-333333333333",
          contextSnapshot: null,
          permissions: null,
        }]).then(onFulfilled, onRejected),
    }));
    mockIssueService.createChild.mockResolvedValue({
      issue: {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        companyId: "company-1",
        identifier: "PAP-1002",
        title: "Child issue",
      },
      parentBlockerAdded: false,
    });
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.decide.mockImplementation(async (input: { actor?: { type?: string; source?: string }; action?: string }) => {
      const allowed = input.actor?.type === "board" && input.actor.source === "local_implicit"
        ? true
        : input.actor?.type === "agent" && [
            "company_scope:read",
            "issue:read",
            "issue:mutate",
            "runtime:manage",
          ].includes(input.action ?? "")
          ? true
          : Boolean(await mockAccessService.canUser() || await mockAccessService.hasPermission());
      return {
        allowed,
        action: input.action,
        reason: allowed ? "allow_explicit_grant" : "deny_missing_grant",
        explanation: allowed ? "Allowed by test grant." : `Missing permission: ${input.action ?? "action"}`,
      };
    });
    mockAccessService.hasPermission.mockResolvedValue(false);
  });

  afterEach(() => {
    if (originalLifecycleEnforcementMode === undefined) {
      delete process.env.PAPERCLIP_ISSUE_LIFECYCLE_ENFORCEMENT;
    } else {
      process.env.PAPERCLIP_ISSUE_LIFECYCLE_ENFORCEMENT = originalLifecycleEnforcementMode;
    }
    if (originalLifecycleEnforcementCompanies === undefined) {
      delete process.env.PAPERCLIP_ISSUE_LIFECYCLE_ENFORCEMENT_COMPANY_IDS;
    } else {
      process.env.PAPERCLIP_ISSUE_LIFECYCLE_ENFORCEMENT_COMPANY_IDS = originalLifecycleEnforcementCompanies;
    }
  });

  it("rejects an agent-authored in_review transition without a review path", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1003",
      title: "Missing review path",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("invalid_issue_disposition");
    expect(res.body.error).toContain("request_confirmation");
    expect(res.body.details).toMatchObject({
      code: "invalid_issue_disposition",
      missing: "review_path",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("wakes the delegator exactly once when delegated work moves to in_review", async () => {
    const issueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const parentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const executorId = "33333333-3333-4333-8333-333333333333";
    const delegatorId = "44444444-4444-4444-8444-444444444444";
    const issue = {
      id: issueId,
      companyId: "company-1",
      parentId,
      status: "in_progress",
      assigneeAgentId: executorId,
      assigneeUserId: null,
      createdByAgentId: delegatorId,
      createdByUserId: null,
      identifier: "PAP-1003",
      title: "Delegated implementation",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockImplementation(async (id: string) => id === parentId
      ? {
          id: parentId,
          companyId: "company-1",
          status: "in_progress",
          assigneeAgentId: delegatorId,
        }
      : issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date("2026-07-16T12:00:00.000Z"),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: executorId,
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      delegatorId,
      expect.objectContaining({
        reason: "execution_review_requested",
        payload: expect.objectContaining({ issueId, parentIssueId: parentId }),
      }),
    );
  });

  it("allows an agent-authored in_review transition with a pending confirmation interaction", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1004",
      title: "Pending confirmation",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([
      { id: "interaction-1", kind: "request_confirmation", status: "pending" },
    ]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({ status: "in_review" }),
    );
  });

  it("allows an agent-authored in_review transition with a typed execution participant", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1005",
      title: "Execution participant",
      executionPolicy: null,
      executionState: null,
    };
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "44444444-4444-4444-8444-444444444444" }],
        },
      ],
    })!;
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review", executionPolicy: policy });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        executionState: expect.objectContaining({
          status: "pending",
          currentParticipant: expect.objectContaining({
            type: "agent",
            agentId: "44444444-4444-4444-8444-444444444444",
          }),
        }),
      }),
    );
  });

  it("allows an agent-authored in_review transition with a scheduled monitor", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1006",
      title: "External review monitor",
      executionPolicy: null,
      executionState: null,
      monitorAttemptCount: 0,
      monitorNextCheckAt: null,
      monitorLastTriggeredAt: null,
      monitorNotes: null,
      monitorScheduledBy: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        status: "in_review",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-12-01T12:00:00.000Z",
            scheduledBy: "assignee",
            notes: "Wait for external QA report.",
          },
        },
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        monitorNextCheckAt: new Date("2026-12-01T12:00:00.000Z"),
      }),
    );
  });

  it("observes board-authored in_review transitions without a review path in shadow mode", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1007",
      title: "Board repair",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockIssueThreadInteractionService.listForIssue).toHaveBeenCalledWith(issue.id);
    expect(mockIssueApprovalService.listApprovalsForIssue).toHaveBeenCalledWith(issue.id);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.lifecycle_shadow_finding",
        entityId: issue.id,
        details: expect.objectContaining({
          contractId: "paperclip.issue-lifecycle-execution",
          contractVersion: "1.0.0",
          violation: "in_review_without_action_path",
          disposition: "mutation_observed",
        }),
      }),
    );
  });

  it("keeps shadow mode fail-open when lifecycle instrumentation cannot be persisted", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1013",
      title: "Shadow telemetry outage",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));
    mockLogActivity.mockRejectedValueOnce(new Error("activity store unavailable"));

    const res = await request(await createApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      issue.id,
      expect.objectContaining({ status: "in_review" }),
    );
  });

  it("rejects board-authored in_review transitions without a review path in enforce mode", async () => {
    process.env.PAPERCLIP_ISSUE_LIFECYCLE_ENFORCEMENT = "enforce";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1008",
      title: "Board repair without owner",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({
      code: "invalid_issue_disposition",
      missing: "review_path",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects a stale typed agent participant that will not receive a reviewer wake", async () => {
    process.env.PAPERCLIP_ISSUE_LIFECYCLE_ENFORCEMENT = "enforce";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1012",
      title: "Stale participant metadata",
      executionPolicy: null,
      executionState: {
        status: "pending",
        currentStageId: "11111111-1111-4111-8111-111111111111",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: {
          type: "agent",
          agentId: "44444444-4444-4444-8444-444444444444",
        },
        returnAssignee: {
          type: "agent",
          agentId: "33333333-3333-4333-8333-333333333333",
        },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({ missing: "review_path" });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("observes board-authored in_progress transitions without an execution path in shadow mode", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1009",
      title: "Board active work without wake",
      executionPolicy: null,
      executionState: null,
      monitorNextCheckAt: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_progress" });

    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.lifecycle_shadow_finding",
        details: expect.objectContaining({
          violation: "in_progress_without_execution_path",
          disposition: "mutation_observed",
        }),
      }),
    );
  });

  it("rejects board-authored in_progress transitions without an execution path in enforce mode", async () => {
    process.env.PAPERCLIP_ISSUE_LIFECYCLE_ENFORCEMENT = "enforce";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1010",
      title: "Board active work blocked by enforcement",
      executionPolicy: null,
      executionState: null,
      monitorNextCheckAt: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_progress" });

    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({
      code: "invalid_issue_disposition",
      missing: "execution_path",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects an agent in_progress transition when its supplied run id has no live issue path", async () => {
    process.env.PAPERCLIP_ISSUE_LIFECYCLE_ENFORCEMENT = "enforce";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1013",
      title: "Stale actor run",
      executionPolicy: null,
      executionState: null,
      monitorNextCheckAt: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp({
      type: "agent",
      agentId: issue.assigneeAgentId,
      companyId: issue.companyId,
      runId: "stale-or-unrelated-run",
    }))
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_progress" });

    expect(res.status).toBe(422);
    expect(mockHeartbeatService.getIssueExecutionPath).toHaveBeenCalledWith(
      issue.companyId,
      issue.id,
      issue.assigneeAgentId,
    );
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it.each([
    ["queued wake", { kind: "wake", id: "wake-1", agentId: "33333333-3333-4333-8333-333333333333", status: "queued" }],
    ["scheduled retry", { kind: "run", id: "retry-1", agentId: "33333333-3333-4333-8333-333333333333", status: "scheduled_retry" }],
  ])("allows an in_progress transition with an existing %s", async (_label, executionPath) => {
    process.env.PAPERCLIP_ISSUE_LIFECYCLE_ENFORCEMENT = "enforce";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1014",
      title: "Durable execution path",
      executionPolicy: null,
      executionState: null,
      monitorNextCheckAt: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockHeartbeatService.getIssueExecutionPath.mockResolvedValue(executionPath);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_progress" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  it("allows a human-owned in_progress transition in enforce mode", async () => {
    process.env.PAPERCLIP_ISSUE_LIFECYCLE_ENFORCEMENT = "enforce";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      createdByUserId: "local-board",
      identifier: "PAP-1011",
      title: "Human active work",
      executionPolicy: null,
      executionState: null,
      monitorNextCheckAt: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_progress" });

    expect(res.status).toBe(200);
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.lifecycle_shadow_finding" }),
    );
  });

  it("rejects a terminal-to-todo transition without explicit resume intent in enforce mode", async () => {
    process.env.PAPERCLIP_ISSUE_LIFECYCLE_ENFORCEMENT = "enforce";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "done",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      createdByUserId: "local-board",
      identifier: "PAP-1015",
      title: "Closed work",
      executionPolicy: null,
      executionState: null,
      monitorNextCheckAt: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "todo" });

    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({
      code: "invalid_issue_transition",
      guard: "explicit_resume",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("compensates a failed enforced assignment handoff and retains the previous owner", async () => {
    process.env.PAPERCLIP_ISSUE_LIFECYCLE_ENFORCEMENT = "enforce";
    const previousOwnerAgentId = "33333333-3333-4333-8333-333333333333";
    const nextOwnerAgentId = "44444444-4444-4444-8444-444444444444";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: previousOwnerAgentId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1016",
      title: "Atomic assignment handoff",
      executionPolicy: null,
      executionState: null,
      monitorNextCheckAt: null,
      updatedAt: new Date("2026-07-14T00:00:00.000Z"),
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update
      .mockImplementationOnce(async (_id: string, patch: Record<string, unknown>) => ({
        ...issue,
        ...patch,
        updatedAt: new Date("2026-07-14T00:01:00.000Z"),
      }))
      .mockImplementationOnce(async (_id: string, patch: Record<string, unknown>) => ({
        ...issue,
        ...patch,
        updatedAt: new Date("2026-07-14T00:02:00.000Z"),
      }));
    mockHeartbeatService.wakeup.mockRejectedValueOnce(new Error("queue unavailable"));

    const res = await request(await createApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_progress", assigneeAgentId: nextOwnerAgentId });

    expect(res.status).toBe(503);
    expect(res.body.details).toMatchObject({
      code: "issue_handoff_failed",
      lifecycleState: "handoff_failed",
      recoveryActionId: "recovery-action-1",
    });
    expect(mockIssueService.update).toHaveBeenLastCalledWith(
      issue.id,
      expect.objectContaining({
        status: "blocked",
        assigneeAgentId: previousOwnerAgentId,
        assigneeUserId: null,
      }),
      expect.anything(),
    );
    expect(mockIssueRecoveryActionService.upsertSourceScoped).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: issue.companyId,
        sourceIssueId: issue.id,
        cause: "handoff_wake_delivery_failed",
        previousOwnerAgentId,
        returnOwnerAgentId: nextOwnerAgentId,
        maxAttempts: 1,
      }),
      expect.anything(),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.handoff_failed",
        details: expect.objectContaining({ previousOwnerRetained: true }),
      }),
    );
  });

  it("rolls back the handoff when atomic recovery-action persistence fails", async () => {
    process.env.PAPERCLIP_ISSUE_LIFECYCLE_ENFORCEMENT = "enforce";
    const previousOwnerAgentId = "33333333-3333-4333-8333-333333333333";
    const nextOwnerAgentId = "44444444-4444-4444-8444-444444444444";
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: previousOwnerAgentId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1017",
      title: "Rollback failed recovery persistence",
      executionPolicy: null,
      executionState: null,
      monitorNextCheckAt: null,
      updatedAt: new Date("2026-07-14T00:00:00.000Z"),
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date("2026-07-14T00:01:00.000Z"),
    }));
    mockHeartbeatService.wakeup.mockRejectedValueOnce(new Error("queue unavailable"));
    mockIssueRecoveryActionService.upsertSourceScoped.mockRejectedValueOnce(new Error("recovery store unavailable"));

    const res = await request(await createApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_progress", assigneeAgentId: nextOwnerAgentId });

    expect(res.status).toBe(503);
    expect(res.body.details).toMatchObject({
      code: "issue_handoff_rolled_back",
      issueId: issue.id,
    });
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(mockIssueService.update).toHaveBeenLastCalledWith(issue.id, expect.objectContaining({
      status: "todo",
      assigneeAgentId: previousOwnerAgentId,
      assigneeUserId: null,
      executionState: null,
      lifecycleTransitionContext: {
        handoffRollback: {
          committedStatus: "in_progress",
          previousStatus: "todo",
        },
      },
    }));
  });

  it("does not auto-start execution review when reviewers are added to an already in_review issue", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      createdByUserId: "local-board",
      identifier: "PAP-999",
      title: "Execution policy edit",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ executionPolicy: policy });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        executionPolicy: policy,
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updatePatch.status).toBeUndefined();
    expect(updatePatch.assigneeAgentId).toBeUndefined();
    expect(updatePatch.assigneeUserId).toBeUndefined();
    expect(updatePatch.executionState).toBeUndefined();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("triggers a scheduled monitor immediately from the dedicated route", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Manual monitor trigger",
      executionPolicy: normalizeIssueExecutionPolicy({
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
          scheduledBy: "board",
        },
      }),
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp())
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/monitor/check-now")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockHeartbeatService.triggerIssueMonitor).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        actorType: "user",
        actorId: "local-board",
        agentId: null,
      }),
    );
  });

  it("lets a board user create a child issue with a scheduled monitor", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "11111111-1111-4111-8111-111111111111",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Parent issue",
      executionPolicy: null,
      executionState: null,
    });

    const res = await request(await createApp())
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/children")
      .send({
        title: "Child monitor",
        status: "in_review",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            scheduledBy: "assignee",
          },
        },
      });

    expect(res.status).toBe(201);
    const createPayload = mockIssueService.createChild.mock.calls[0]?.[1] as {
      executionPolicy: { monitor: { scheduledBy: string } };
    };
    expect(createPayload.executionPolicy.monitor.scheduledBy).toBe("board");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.monitor_scheduled",
        details: expect.objectContaining({
          scheduledBy: "board",
        }),
      }),
    );
  });

  it("rejects creating an unowned in_progress issue in enforce mode", async () => {
    process.env.PAPERCLIP_ISSUE_LIFECYCLE_ENFORCEMENT = "enforce";

    const res = await request(await createApp())
      .post("/api/companies/company-1/issues")
      .send({
        title: "Unowned active work",
        status: "in_progress",
      });

    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({
      code: "invalid_issue_disposition",
      missing: "execution_path",
    });
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("rejects creating an unowned in_review child in enforce mode", async () => {
    process.env.PAPERCLIP_ISSUE_LIFECYCLE_ENFORCEMENT = "enforce";
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      projectId: null,
      parentId: null,
      status: "in_progress",
      assigneeAgentId: "11111111-1111-4111-8111-111111111111",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Parent issue",
      executionPolicy: null,
      executionState: null,
    });

    const res = await request(await createApp())
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/children")
      .send({
        title: "Unowned review",
        status: "in_review",
      });

    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({
      code: "invalid_issue_disposition",
      missing: "review_path",
    });
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
  });

  it("rejects child monitor scheduling by a non-assignee agent even with task assignment permission", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "11111111-1111-4111-8111-111111111111",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Parent issue",
      executionPolicy: null,
      executionState: null,
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "22222222-2222-4222-8222-222222222222",
      companyId: "company-1",
      runId: "run-1",
    }))
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/children")
      .send({
        title: "Child monitor",
        status: "in_review",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            scheduledBy: "board",
          },
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Only the assignee agent or a board user can manage issue monitors");
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
  });

  it("normalizes spoofed child monitor scheduledBy to the assignee actor", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Parent issue",
      executionPolicy: null,
      executionState: null,
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/children")
      .send({
        title: "Child monitor",
        status: "in_review",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            scheduledBy: "board",
            externalRef: "https://example.test/deploy?token=secret",
          },
        },
      });

    expect(res.status).toBe(201);
    const createPayload = mockIssueService.createChild.mock.calls[0]?.[1] as {
      executionPolicy: { monitor: { scheduledBy: string; externalRef: string | null } };
    };
    expect(createPayload.executionPolicy.monitor.scheduledBy).toBe("assignee");
    expect(createPayload.executionPolicy.monitor.externalRef).toBe("[redacted]");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.monitor_scheduled",
        entityId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        details: expect.not.objectContaining({ externalRef: expect.anything() }),
      }),
    );
  });
});
