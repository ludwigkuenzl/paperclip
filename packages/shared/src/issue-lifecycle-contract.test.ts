import { describe, expect, it } from "vitest";
import {
  ISSUE_LIFECYCLE_EXECUTION_CONTRACT_V1,
  isIssueLifecycleContractTransitionAllowed,
} from "./issue-lifecycle-contract.js";

describe("issue lifecycle execution contract v1", () => {
  it("publishes the required canonical fields in a stable order", () => {
    expect(ISSUE_LIFECYCLE_EXECUTION_CONTRACT_V1.canonicalFields.map((field) => field.name)).toEqual([
      "current_owner",
      "current_state",
      "next_action",
      "next_owner",
      "active_run_id",
      "blocking_resource",
      "blocker_reason",
      "last_progress_at",
      "next_wake_at",
      "retry_count",
    ]);
  });

  it("guards terminal reopen and exposes handoff failure as recoverable", () => {
    expect(isIssueLifecycleContractTransitionAllowed("done", "in_progress")).toBe(false);
    expect(isIssueLifecycleContractTransitionAllowed("cancelled", "todo")).toBe(true);
    expect(ISSUE_LIFECYCLE_EXECUTION_CONTRACT_V1.transitionGuards).toEqual({
      "done->todo": "explicit_resume",
      "cancelled->todo": "explicit_resume",
      "blocked->in_review": "active_recovery_resolution",
      "blocked->done": "active_recovery_resolution",
    });
    expect(isIssueLifecycleContractTransitionAllowed("blocked", "done")).toBe(true);
    expect(isIssueLifecycleContractTransitionAllowed("in_progress", "handoff_failed")).toBe(true);
    expect(isIssueLifecycleContractTransitionAllowed("handoff_failed", "blocked")).toBe(true);
    expect(ISSUE_LIFECYCLE_EXECUTION_CONTRACT_V1.states.handoff_failed.persistedAs).toMatchObject({
      issueStatus: "blocked",
      recoveryKind: "missing_disposition",
    });
  });

  it("makes review, handoff, and dependency invariants machine-readable", () => {
    expect(ISSUE_LIFECYCLE_EXECUTION_CONTRACT_V1.invariants.inProgressRequiresAny).toContain("active_run");
    expect(ISSUE_LIFECYCLE_EXECUTION_CONTRACT_V1.invariants.inReviewRequiresAny).toContain(
      "typed_participant_with_reviewer_wake",
    );
    expect(ISSUE_LIFECYCLE_EXECUTION_CONTRACT_V1.handoff.requiredOrder).toEqual([
      "persist_result",
      "set_next_action",
      "set_next_owner",
      "enqueue_idempotent_wake",
      "confirm_wake",
      "commit_status",
    ]);
    expect(ISSUE_LIFECYCLE_EXECUTION_CONTRACT_V1.dependencies).toMatchObject({
      parentChildIsDependency: false,
      resolvedBlockerStates: ["done"],
      cancelledBlockerResolvesDependency: false,
      delivery: "exactly_once_per_idempotency_key",
    });
  });

  it("ships a backward-compatible shadow-first rollout contract", () => {
    expect(ISSUE_LIFECYCLE_EXECUTION_CONTRACT_V1.compatibility.storageMigrationRequired).toBe(false);
    expect(ISSUE_LIFECYCLE_EXECUTION_CONTRACT_V1.rollout).toEqual({
      modes: ["off", "shadow", "enforce"],
      defaultMode: "shadow",
      enforcementRequiresCanary: true,
      canaryScope: "explicit_company_id_allowlist",
      liveReadback: "evaluate_environment_on_each_company_scoped_mutation",
      rollback: "set_mode_off_and_keep_legacy_storage_readable",
    });
  });
});
