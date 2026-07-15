import {
  buildDeliveryControlResourceIdempotencyKey,
  deliveryControlActionClassRequiresLease,
  evaluateDeliveryControlResourceLease,
  normalizeDeliveryControlResourceKey,
  type DeliveryControlActionClass,
  type DeliveryControlResourceLeaseSnapshot,
} from "@paperclipai/shared";
import { parseIssueExecutionWorkspaceSettings } from "./execution-workspace-policy.js";

export interface ResourceControlledIssueInput {
  id: string;
  companyId: string;
  status: string;
  workMode: string;
  projectId?: string | null;
  projectWorkspaceId?: string | null;
  executionWorkspaceId?: string | null;
  executionWorkspaceSettings?: unknown;
}

export interface ResolvedIssueResourceControl {
  source: "explicit" | "inferred";
  actionClass: DeliveryControlActionClass;
  resourceKey: string;
  changeId: string | null;
  idempotencyKey: string | null;
  leaseRequired: boolean;
  productiveParallelismAllowed: boolean;
  blockedReason: string | null;
}

function inferredActionClass(input: ResourceControlledIssueInput): DeliveryControlActionClass {
  if (input.workMode === "ask") return "read_only";
  if (input.workMode === "planning" || input.status === "in_review") return "review";
  const settings = parseIssueExecutionWorkspaceSettings(input.executionWorkspaceSettings);
  if (settings?.mode === "isolated_workspace" || settings?.mode === "operator_branch") {
    return "isolated_write";
  }
  return "shared_write";
}

function inferredResourceKey(input: ResourceControlledIssueInput, actionClass: DeliveryControlActionClass) {
  if (input.executionWorkspaceId) return `execution_workspace:${input.executionWorkspaceId}`;
  if (input.projectWorkspaceId) return `project_workspace:${input.projectWorkspaceId}`;
  if (input.projectId) return `project:${input.projectId}`;
  if (actionClass === "read_only" || actionClass === "review") return `issue:${input.id}`;
  return `unscoped_issue:${input.id}`;
}

export function resolveIssueResourceControl(
  input: ResourceControlledIssueInput,
): ResolvedIssueResourceControl {
  const settings = parseIssueExecutionWorkspaceSettings(input.executionWorkspaceSettings);
  const explicit = settings?.resourceControl ?? null;
  const actionClass = explicit?.actionClass ?? inferredActionClass(input);
  const resourceKey = normalizeDeliveryControlResourceKey(
    explicit?.resourceKey ?? inferredResourceKey(input, actionClass),
  );
  if (!resourceKey) throw new Error("Resolved resource-control keys must not be empty");
  const changeId = explicit?.changeId?.trim() || null;
  const idempotencyKey = explicit?.idempotencyKey?.trim() || (
    changeId
      ? buildDeliveryControlResourceIdempotencyKey({
          companyId: input.companyId,
          actionClass,
          resourceKey,
          changeId,
        })
      : null
  );
  const leaseRequired = deliveryControlActionClassRequiresLease(actionClass);
  const blockedReason = leaseRequired && (!explicit || !changeId || !idempotencyKey)
    ? "exclusive_action_requires_explicit_resource_change_and_idempotency_context"
    : null;
  return {
    source: explicit ? "explicit" : "inferred",
    actionClass,
    resourceKey,
    changeId,
    idempotencyKey,
    leaseRequired,
    productiveParallelismAllowed: !leaseRequired,
    blockedReason,
  };
}

export function evaluateIssueResourceLease(input: {
  issue: ResourceControlledIssueInput;
  runId: string;
  currentLease?: DeliveryControlResourceLeaseSnapshot | null;
  now?: Date | string;
}) {
  const resolved = resolveIssueResourceControl(input.issue);
  const decision = evaluateDeliveryControlResourceLease({
    actionClass: resolved.actionClass,
    resourceKey: resolved.resourceKey,
    runId: input.runId,
    changeId: resolved.changeId,
    idempotencyKey: resolved.idempotencyKey,
    currentLease: input.currentLease,
    now: input.now,
  });
  return {
    ...resolved,
    decision,
  };
}
