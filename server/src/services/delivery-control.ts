import {
  DELIVERY_CONTROL_CONTRACT_V1,
  deliveryControlPolicyForPriority,
  type DeliveryControlCommunicationReason,
  type DeliveryControlLivenessState,
  type DeliveryControlMode,
  type IssuePriority,
} from "@paperclipai/shared";

export const DELIVERY_CONTROL_MODE_ENV = "PAPERCLIP_DELIVERY_CONTROL_MODE";
export const DELIVERY_CONTROL_COMPANY_IDS_ENV = "PAPERCLIP_DELIVERY_CONTROL_COMPANY_IDS";
export const DELIVERY_CONTROL_ISSUE_IDS_ENV = "PAPERCLIP_DELIVERY_CONTROL_ISSUE_IDS";

export type DeliveryControlPhase = "queued" | "active" | "review" | "waiting" | "terminal";
export type DeliveryControlStartSlaStatus = "not_applicable" | "pending" | "risk" | "met" | "breached";
export type DeliveryControlRecoveryStatus = "not_applicable" | "waiting" | "due" | "exhausted";
export type DeliveryControlEscalationStatus = "not_applicable" | "waiting" | "due";

export interface DeliveryControlEvaluationInput {
  issueId: string;
  companyId: string;
  priority: IssuePriority;
  status: string;
  triggerAt: Date | string;
  queuedAt?: Date | string | null;
  runStartedAt?: Date | string | null;
  resultAt?: Date | string | null;
  lastProgressAt?: Date | string | null;
  recoveryAttemptCount?: number | null;
  hasActiveRun?: boolean;
  hasQueuedWake?: boolean;
  queueCapacityAvailable?: boolean;
  executionLockCoherent?: boolean;
  hasOrphanedResourceLock?: boolean;
  hasScheduledRetry?: boolean;
  hasScheduledMonitor?: boolean;
  hasTypedReviewOrApproval?: boolean;
  hasLiveDependencyPath?: boolean;
  hasExplicitRecoveryAction?: boolean;
  hasUnscheduledRecoveryAction?: boolean;
  hasHumanOwner?: boolean;
  now?: Date | string;
}

export interface DeliveryControlEvaluation {
  contractId: typeof DELIVERY_CONTROL_CONTRACT_V1.id;
  contractVersion: typeof DELIVERY_CONTROL_CONTRACT_V1.version;
  issueId: string;
  companyId: string;
  priority: IssuePriority;
  enabled: boolean;
  phase: DeliveryControlPhase;
  livenessState: DeliveryControlLivenessState;
  triggerAt: string;
  queuedAt: string | null;
  runStartedAt: string | null;
  resultAt: string | null;
  lastProgressAt: string | null;
  startSla: {
    status: DeliveryControlStartSlaStatus;
    deadlineAt: string | null;
    observedStartAt: string | null;
    elapsedMs: number;
  };
  recovery: {
    status: DeliveryControlRecoveryStatus;
    dueAt: string | null;
    attemptCount: number;
    maximumAttempts: number;
    blockerRequired: boolean;
  };
  escalation: {
    status: DeliveryControlEscalationStatus;
    dueAt: string | null;
  };
  nextCheckAt: string | null;
  audit: {
    measurementStartAt: string;
    queueEntryAt: string | null;
    runStartAt: string | null;
    resultAt: string | null;
  };
}

function dateValue(value: Date | string | null | undefined, field: string): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid delivery-control date for ${field}`);
  return parsed;
}

function iso(value: Date | null) {
  return value ? value.toISOString() : null;
}

function addMs(value: Date, durationMs: number) {
  return new Date(value.getTime() + durationMs);
}

function earliestFuture(now: Date, values: Array<Date | null>) {
  return values
    .filter((value): value is Date => Boolean(value && value.getTime() > now.getTime()))
    .sort((left, right) => left.getTime() - right.getTime())[0] ?? null;
}

function normalizeAttempts(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function phaseForStatus(status: string, hasActiveRun: boolean): DeliveryControlPhase {
  if (status === "done" || status === "cancelled") return "terminal";
  if (status === "in_review") return "review";
  if (status === "blocked") return "waiting";
  return hasActiveRun || status === "in_progress" ? "active" : "queued";
}

export function resolveDeliveryControlMode(value: string | null | undefined): DeliveryControlMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "off" || normalized === "enforce") return normalized;
  return "shadow";
}

export function readDeliveryControlConfig(
  companyId: string,
  input: {
    mode?: string | null;
    canaryCompanyIds?: string | null;
    issueId?: string | null;
    canaryIssueIds?: string | null;
  } = {},
) {
  const configuredMode = resolveDeliveryControlMode(
    input.mode === undefined ? process.env[DELIVERY_CONTROL_MODE_ENV] : input.mode,
  );
  const canaryCompanyIds = (
    input.canaryCompanyIds === undefined
      ? process.env[DELIVERY_CONTROL_COMPANY_IDS_ENV]
      : input.canaryCompanyIds
  )
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) ?? [];
  const canaryIssueIds = (
    input.canaryIssueIds === undefined
      ? process.env[DELIVERY_CONTROL_ISSUE_IDS_ENV]
      : input.canaryIssueIds
  )
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) ?? [];
  const issueCanaryMatched = canaryIssueIds.length === 0 || Boolean(
    input.issueId && canaryIssueIds.includes(input.issueId),
  );
  const effectiveMode: DeliveryControlMode = configuredMode === "enforce"
    ? canaryCompanyIds.includes(companyId) && issueCanaryMatched ? "enforce" : "shadow"
    : configuredMode;
  return {
    companyId,
    issueId: input.issueId ?? null,
    configuredMode,
    effectiveMode,
    canaryCompanyIds,
    canaryIssueIds,
  } as const;
}

export function evaluateDeliveryControl(input: DeliveryControlEvaluationInput): DeliveryControlEvaluation {
  const now = dateValue(input.now ?? new Date(), "now")!;
  const triggerAt = dateValue(input.triggerAt, "triggerAt")!;
  const queuedAt = dateValue(input.queuedAt, "queuedAt");
  const runStartedAt = dateValue(input.runStartedAt, "runStartedAt");
  const resultAt = dateValue(input.resultAt, "resultAt");
  const lastProgressAt = dateValue(input.lastProgressAt, "lastProgressAt");
  const policy = deliveryControlPolicyForPriority(input.priority);
  const terminal = input.status === "done" || input.status === "cancelled";
  const hasActiveRun = input.hasActiveRun === true;
  const phase = phaseForStatus(input.status, hasActiveRun);
  const attemptCount = normalizeAttempts(input.recoveryAttemptCount);
  const maximumAttempts = DELIVERY_CONTROL_CONTRACT_V1.recovery.maximumAutomaticAttempts;

  if (!policy) {
    return {
      contractId: DELIVERY_CONTROL_CONTRACT_V1.id,
      contractVersion: DELIVERY_CONTROL_CONTRACT_V1.version,
      issueId: input.issueId,
      companyId: input.companyId,
      priority: input.priority,
      enabled: false,
      phase,
      livenessState: terminal ? "terminal" : hasActiveRun ? "active" : "covered",
      triggerAt: triggerAt.toISOString(),
      queuedAt: iso(queuedAt),
      runStartedAt: iso(runStartedAt),
      resultAt: iso(resultAt),
      lastProgressAt: iso(lastProgressAt),
      startSla: { status: "not_applicable", deadlineAt: null, observedStartAt: iso(runStartedAt), elapsedMs: 0 },
      recovery: {
        status: "not_applicable",
        dueAt: null,
        attemptCount,
        maximumAttempts,
        blockerRequired: false,
      },
      escalation: { status: "not_applicable", dueAt: null },
      nextCheckAt: null,
      audit: {
        measurementStartAt: triggerAt.toISOString(),
        queueEntryAt: iso(queuedAt),
        runStartAt: iso(runStartedAt),
        resultAt: iso(resultAt),
      },
    };
  }

  const startDeadline = addMs(triggerAt, policy.startSlaMs);
  const startRiskAt = addMs(triggerAt, Math.floor(policy.startSlaMs * 0.8));
  let startSlaStatus: DeliveryControlStartSlaStatus;
  if (runStartedAt) {
    startSlaStatus = runStartedAt.getTime() <= startDeadline.getTime() ? "met" : "breached";
  } else if (terminal) {
    startSlaStatus = "not_applicable";
  } else if (now.getTime() >= startDeadline.getTime()) {
    startSlaStatus = "breached";
  } else if (now.getTime() >= startRiskAt.getTime()) {
    startSlaStatus = "risk";
  } else {
    startSlaStatus = "pending";
  }

  const progressAnchor = lastProgressAt ?? runStartedAt ?? triggerAt;
  const recoveryDueAt = addMs(progressAnchor, policy.recoveryAfterMs);
  const escalationDueAt = addMs(progressAnchor, policy.escalationAfterMs);
  const activeRunIsFresh = hasActiveRun &&
    input.executionLockCoherent !== false &&
    input.hasOrphanedResourceLock !== true &&
    now.getTime() < recoveryDueAt.getTime();
  const hasDurableWaitingPath = Boolean(
    input.hasScheduledRetry ||
    input.hasScheduledMonitor ||
    input.hasTypedReviewOrApproval ||
    input.hasLiveDependencyPath ||
    input.hasExplicitRecoveryAction
  );
  if (!runStartedAt && (phase === "waiting" || phase === "review") && hasDurableWaitingPath) {
    startSlaStatus = "not_applicable";
  }
  const queuedWakeHasCapacity = input.hasQueuedWake === true &&
    input.queueCapacityAvailable === true &&
    startSlaStatus !== "breached";
  const hasCoveredPath = queuedWakeHasCapacity || hasDurableWaitingPath;

  let livenessState: DeliveryControlLivenessState;
  if (terminal) livenessState = "terminal";
  else if (input.hasOrphanedResourceLock === true) livenessState = "needs_attention";
  else if (input.hasUnscheduledRecoveryAction === true) livenessState = "needs_attention";
  else if (attemptCount >= maximumAttempts && !activeRunIsFresh) livenessState = "needs_attention";
  else if (activeRunIsFresh) livenessState = "active";
  else if (hasCoveredPath) livenessState = "covered";
  else livenessState = "stalled";

  let recoveryStatus: DeliveryControlRecoveryStatus;
  if (terminal) recoveryStatus = "not_applicable";
  else if (attemptCount >= maximumAttempts && livenessState !== "active" && livenessState !== "covered") {
    recoveryStatus = "exhausted";
  } else if (livenessState === "active" || livenessState === "covered") {
    recoveryStatus = "waiting";
  } else if (now.getTime() >= recoveryDueAt.getTime()) {
    recoveryStatus = "due";
  } else {
    recoveryStatus = "waiting";
  }

  const escalationStatus: DeliveryControlEscalationStatus = terminal
    ? "not_applicable"
    : now.getTime() >= escalationDueAt.getTime() && livenessState !== "active" && livenessState !== "covered"
      ? "due"
      : "waiting";
  const nextCheckAt = terminal
    ? null
    : earliestFuture(now, [
      runStartedAt || startSlaStatus === "not_applicable" ? null : startRiskAt,
      runStartedAt || startSlaStatus === "not_applicable" ? null : startDeadline,
      recoveryDueAt,
      escalationDueAt,
    ]);

  return {
    contractId: DELIVERY_CONTROL_CONTRACT_V1.id,
    contractVersion: DELIVERY_CONTROL_CONTRACT_V1.version,
    issueId: input.issueId,
    companyId: input.companyId,
    priority: input.priority,
    enabled: true,
    phase,
    livenessState,
    triggerAt: triggerAt.toISOString(),
    queuedAt: iso(queuedAt),
    runStartedAt: iso(runStartedAt),
    resultAt: iso(resultAt),
    lastProgressAt: iso(lastProgressAt),
    startSla: {
      status: startSlaStatus,
      deadlineAt: startSlaStatus === "not_applicable" ? null : startDeadline.toISOString(),
      observedStartAt: iso(runStartedAt),
      elapsedMs: startSlaStatus === "not_applicable"
        ? 0
        : Math.max(0, (runStartedAt ?? now).getTime() - triggerAt.getTime()),
    },
    recovery: {
      status: recoveryStatus,
      dueAt: recoveryDueAt.toISOString(),
      attemptCount,
      maximumAttempts,
      blockerRequired: recoveryStatus === "exhausted",
    },
    escalation: {
      status: escalationStatus,
      dueAt: escalationDueAt.toISOString(),
    },
    nextCheckAt: iso(nextCheckAt),
    audit: {
      measurementStartAt: triggerAt.toISOString(),
      queueEntryAt: iso(queuedAt),
      runStartAt: iso(runStartedAt),
      resultAt: iso(resultAt),
    },
  };
}

export interface DeliveryCommunicationSnapshot {
  issueId: string;
  priority: IssuePriority;
  phase: DeliveryControlPhase;
  livenessState: DeliveryControlLivenessState;
  startSlaStatus: DeliveryControlStartSlaStatus;
  recoveryStatus: DeliveryControlRecoveryStatus;
  escalationStatus: DeliveryControlEscalationStatus;
  blockerFingerprint?: string | null;
  userDecisionPending?: boolean;
  liveAcceptance?: boolean;
  lastProgressAt?: Date | string | null;
  completed: string;
  currentAction: string;
  remaining: string;
  owner: string;
  nextCheckAt: Date | string;
}

export interface DeliveryCommunicationEvaluationInput {
  current: DeliveryCommunicationSnapshot;
  previous?: DeliveryCommunicationSnapshot | null;
  lastEmittedFingerprint?: string | null;
  lastEmittedAt?: Date | string | null;
  now?: Date | string;
}

function compact(value: unknown) {
  return value === null || value === undefined ? "" : String(value).trim().replace(/\s+/g, " ");
}

function communicationFingerprint(snapshot: DeliveryCommunicationSnapshot) {
  return [
    snapshot.phase,
    snapshot.livenessState,
    snapshot.startSlaStatus,
    snapshot.recoveryStatus,
    snapshot.escalationStatus,
    compact(snapshot.blockerFingerprint),
    snapshot.userDecisionPending === true ? "decision" : "",
    snapshot.liveAcceptance === true ? "accepted" : "",
    iso(dateValue(snapshot.lastProgressAt, "lastProgressAt")),
    compact(snapshot.completed),
    compact(snapshot.currentAction),
    compact(snapshot.remaining),
    compact(snapshot.owner),
    iso(dateValue(snapshot.nextCheckAt, "nextCheckAt")),
  ].join("|");
}

function shortStableHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function requiredCommunicationFieldsPresent(snapshot: DeliveryCommunicationSnapshot) {
  return [
    snapshot.completed,
    snapshot.currentAction,
    snapshot.remaining,
    snapshot.owner,
    iso(dateValue(snapshot.nextCheckAt, "nextCheckAt")),
  ].every((value) => compact(value).length > 0);
}

export function evaluateDeliveryCommunication(input: DeliveryCommunicationEvaluationInput) {
  const now = dateValue(input.now ?? new Date(), "now")!;
  const current = input.current;
  const previous = input.previous ?? null;
  const fingerprint = communicationFingerprint(current);
  const deltaSinceLastEmission = fingerprint !== input.lastEmittedFingerprint;
  const policy = deliveryControlPolicyForPriority(current.priority);
  const lastEmittedAt = dateValue(input.lastEmittedAt, "lastEmittedAt");
  const cadenceDue = Boolean(
    policy &&
    lastEmittedAt &&
    now.getTime() - lastEmittedAt.getTime() >= policy.communicationMaxGapMs,
  );

  let reason: DeliveryControlCommunicationReason | null = null;
  if (current.liveAcceptance && previous?.liveAcceptance !== true) reason = "live_acceptance";
  else if (current.userDecisionPending && previous?.userDecisionPending !== true) reason = "user_decision";
  else if (current.blockerFingerprint && current.blockerFingerprint !== previous?.blockerFingerprint) reason = "real_blocker";
  else if (
    (current.startSlaStatus === "risk" || current.startSlaStatus === "breached") &&
    current.startSlaStatus !== previous?.startSlaStatus
  ) reason = "sla_risk";
  else if (!previous || current.phase !== previous.phase) reason = "phase_change";
  else if (
    current.livenessState !== previous.livenessState ||
    current.recoveryStatus !== previous.recoveryStatus ||
    current.escalationStatus !== previous.escalationStatus
  ) reason = current.livenessState === "stalled" || current.livenessState === "needs_attention"
    ? "real_blocker"
    : "phase_change";
  else if (cadenceDue && deltaSinceLastEmission) reason = "long_run_delta";

  const requiredFieldsPresent = requiredCommunicationFieldsPresent(current);
  const emit = Boolean(reason && deltaSinceLastEmission && requiredFieldsPresent);
  return {
    emit,
    reason: emit ? reason : null,
    suppressedReason: emit
      ? null
      : !requiredFieldsPresent
        ? "missing_required_fields"
        : !deltaSinceLastEmission
          ? "no_delta"
          : "no_trigger",
    fingerprint,
    eventKey: emit ? `delivery_control_update:${current.issueId}:${reason}:${shortStableHash(fingerprint)}` : null,
    payload: emit
      ? {
        completed: compact(current.completed),
        currentAction: compact(current.currentAction),
        remaining: compact(current.remaining),
        owner: compact(current.owner),
        nextCheckAt: iso(dateValue(current.nextCheckAt, "nextCheckAt"))!,
      }
      : null,
  } as const;
}
