/**
 * Versioned machine-readable contract for issue lifecycle and execution liveness.
 *
 * This is intentionally a logical contract rather than a storage schema. Existing
 * installations derive the canonical fields from the persistence sources listed
 * below, so consumers can adopt the contract without a destructive migration.
 */
export const ISSUE_LIFECYCLE_EXECUTION_CONTRACT_V1 = {
  id: "paperclip.issue-lifecycle-execution",
  version: "1.0.0",
  compatibility: {
    minimumPaperclipContractVersion: "1",
    storageMigrationRequired: false,
    unknownFields: "ignore",
    unknownStates: "reject_for_enforcement_report_in_shadow",
    legacyAliases: {
      taskId: "issueId",
      checkoutRunId: "active_run_id",
      executionRunId: "active_run_id",
      successful_run_missing_state: "handoff_failed",
    },
  },
  canonicalFields: [
    {
      name: "current_owner",
      required: true,
      sources: ["issues.assignee_agent_id", "issues.assignee_user_id"],
    },
    {
      name: "current_state",
      required: true,
      sources: ["issues.status", "issues.execution_state.status", "issue_recovery_actions.cause"],
    },
    {
      name: "next_action",
      required: true,
      sources: ["issues.execution_state", "issue_recovery_actions.next_action", "agent_wakeup_requests.payload"],
    },
    {
      name: "next_owner",
      required: true,
      sources: [
        "issues.execution_state.currentParticipant",
        "issue_recovery_actions.owner_agent_id",
        "issues.assignee_agent_id",
        "issues.assignee_user_id",
      ],
    },
    {
      name: "active_run_id",
      required: false,
      sources: ["issues.execution_run_id", "issues.checkout_run_id", "heartbeat_runs.id"],
    },
    {
      name: "blocking_resource",
      required: false,
      sources: ["issue_relations", "issue_recovery_actions.id", "issues.execution_state.monitor"],
    },
    {
      name: "blocker_reason",
      required: false,
      sources: ["issue_recovery_actions.cause", "issue_comments.metadata", "heartbeat_runs.error_code"],
    },
    {
      name: "last_progress_at",
      required: false,
      sources: ["heartbeat_runs.last_useful_action_at", "heartbeat_runs.updated_at", "issues.updated_at"],
    },
    {
      name: "next_wake_at",
      required: false,
      sources: ["issues.monitor_next_check_at", "heartbeat_runs.scheduled_retry_at", "agent_wakeup_requests.requested_at"],
    },
    {
      name: "retry_count",
      required: true,
      sources: ["issues.monitor_attempt_count", "issue_recovery_actions.attempt_count", "heartbeat_runs.continuation_attempt"],
    },
  ],
  states: {
    backlog: { terminal: false, executionClass: "parked" },
    todo: { terminal: false, executionClass: "ready" },
    in_progress: { terminal: false, executionClass: "active" },
    in_review: { terminal: false, executionClass: "waiting" },
    blocked: { terminal: false, executionClass: "waiting" },
    done: { terminal: true, executionClass: "terminal" },
    cancelled: { terminal: true, executionClass: "terminal" },
    handoff_failed: {
      terminal: false,
      executionClass: "recovery",
      persistedAs: {
        issueStatus: "blocked",
        recoveryKind: "missing_disposition",
        legacyCause: "successful_run_missing_state",
      },
    },
  },
  transitions: {
    backlog: ["todo", "cancelled"],
    todo: ["in_progress", "blocked", "cancelled"],
    in_progress: ["in_review", "blocked", "done", "cancelled", "handoff_failed"],
    in_review: ["in_progress", "blocked", "done", "cancelled", "handoff_failed"],
    blocked: ["todo", "in_progress", "in_review", "done", "cancelled"],
    handoff_failed: ["todo", "in_progress", "in_review", "blocked", "done", "cancelled"],
    done: ["todo"],
    cancelled: ["todo"],
  },
  transitionGuards: {
    "done->todo": "explicit_resume",
    "cancelled->todo": "explicit_resume",
    "blocked->in_review": "active_recovery_resolution",
    "blocked->done": "active_recovery_resolution",
  },
  invariants: {
    ownership: [
      "an issue has at most one current owner",
      "handoff failure retains the previous current owner",
      "owner and target resources remain company scoped",
    ],
    inProgressRequiresAny: [
      "active_run",
      "queued_wake",
      "scheduled_retry",
      "scheduled_monitor",
      "explicit_recovery_action",
      "human_owner",
    ],
    inReviewRequiresAny: [
      "typed_participant_with_reviewer_wake",
      "pending_issue_thread_interaction",
      "linked_pending_approval",
      "human_owner",
      "scheduled_monitor",
      "executable_review_issue",
      "explicit_recovery_action",
    ],
    commentsAndMentions: "evidence_or_interaction_only_never_dependency_completion",
    parentChild: "structure_only_never_dependency_completion",
    blockerResolution: "done_only_cancelled_is_unresolved",
    terminalReopen: "explicit_resume_only",
  },
  handoff: {
    deliveryModel: "transactional_or_compensating",
    requiredOrderAppliesTo: "transactional_variant",
    requiredOrder: [
      "persist_result",
      "set_next_action",
      "set_next_owner",
      "enqueue_idempotent_wake",
      "confirm_wake",
      "commit_status",
    ],
    compensatingOrder: [
      "persist_result_and_provisional_owner_state",
      "enqueue_idempotent_wake",
      "confirm_wake",
      "on_delivery_failure_block_source",
      "retain_previous_owner",
      "create_bounded_recovery_action",
      "return_handoff_failed",
    ],
    failureState: "handoff_failed",
    compensation: "retain_previous_owner_block_source_create_recovery_action_and_enqueue_one_bounded_recovery_wake",
    retainPreviousOwner: true,
    maximumAutomaticRecoveryAttempts: 1,
    commentsAreEvidenceOnly: true,
  },
  dependencies: {
    edgeType: "blocks",
    reverseEdgeType: "blockedBy",
    parentChildIsDependency: false,
    resolvedBlockerStates: ["done"],
    cancelledBlockerResolvesDependency: false,
    wakeReason: "issue_blockers_resolved",
    delivery: "exactly_once_per_idempotency_key",
    idempotencyScope: ["company_id", "dependent_issue_id", "resolved_blocker_issue_id"],
  },
  rollout: {
    modes: ["off", "shadow", "enforce"],
    defaultMode: "shadow",
    enforcementRequiresCanary: true,
    canaryScope: "explicit_company_id_allowlist",
    liveReadback: "evaluate_environment_on_each_company_scoped_mutation",
    rollback: "set_mode_off_and_keep_legacy_storage_readable",
  },
} as const;

export type IssueLifecycleExecutionContractV1 = typeof ISSUE_LIFECYCLE_EXECUTION_CONTRACT_V1;
export type IssueLifecycleContractState = keyof IssueLifecycleExecutionContractV1["states"];
export type IssueLifecycleContractField = IssueLifecycleExecutionContractV1["canonicalFields"][number]["name"];

export function isIssueLifecycleContractTransitionAllowed(
  from: IssueLifecycleContractState,
  to: IssueLifecycleContractState,
) {
  const allowed = ISSUE_LIFECYCLE_EXECUTION_CONTRACT_V1.transitions[from] as readonly IssueLifecycleContractState[];
  return allowed.includes(to);
}
