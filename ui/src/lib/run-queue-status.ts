import type { DeliveryControlResourceQueueTelemetry } from "@paperclipai/shared";

/**
 * Shared run-liveness / queue-wait helpers.
 *
 * The delivery-control contract distinguishes a truly *live* run (`running`)
 * from a *queued* run that is waiting — either for agent capacity or for an
 * exclusive resource lease. Historically several surfaces treated
 * `queued || running` as "live", which mislabelled a waiting run as "Live now"
 * with a running animation. These predicates keep the two concepts separate so
 * every surface renders them consistently:
 *
 * - {@link isRunLive}    — truly live (blue, animated, "Live now"). ONLY `running`.
 * - {@link isRunQueued}  — waiting (amber, static). ONLY `queued`.
 * - {@link isRunWatched} — not terminal; drives polling / cancellation
 *   affordances. `running || queued`. NEVER drives a live animation on its own.
 */

/** Optional per-run resource-queue telemetry as served by the run read-models. */
export type RunQueueTelemetry = DeliveryControlResourceQueueTelemetry;

export function isRunLive(status: string | null | undefined): boolean {
  return status === "running";
}

export function isRunQueued(status: string | null | undefined): boolean {
  return status === "queued";
}

export function isRunWatched(status: string | null | undefined): boolean {
  return status === "running" || status === "queued";
}

/**
 * True when a queued run is waiting on a specific resource lease (as opposed to
 * plain agent-capacity queueing). Resource waits carry the full telemetry;
 * capacity waits carry `null` telemetry and only render the generic wait badge.
 */
export function isResourceWait(
  status: string | null | undefined,
  telemetry: RunQueueTelemetry | null | undefined,
): boolean {
  return isRunQueued(status) && !!telemetry;
}

const ACTION_CLASS_LABELS: Record<string, string> = {
  read_only: "Read-only",
  review: "Review",
  vault_write: "Vault write",
  isolated_write: "Isolated write",
  shared_write: "Shared write",
  deploy: "Deploy",
  external_action: "External action",
};

/** Human-readable label for a delivery-control action class. */
export function resourceActionClassLabel(actionClass: string): string {
  return ACTION_CLASS_LABELS[actionClass] ?? deSnake(actionClass);
}

const WAIT_REASON_LABELS: Record<string, string> = {
  resource_lease_held_by_another_run: "Resource locked by another run",
  resource_recovery_must_complete_before_new_change: "Waiting for resource recovery",
  idempotent_retry_requires_target_readback: "Awaiting idempotent-retry readback",
  expired_lease_requires_owner_and_target_readback: "Expired lease needs recovery",
  blocked_until_action_class_canary: "Blocked until action-class canary opens",
};

/**
 * Human-readable label for a queue `waitReason`. Falls back to a de-snake-cased
 * form for reasons this map does not yet cover, so a new backend reason never
 * renders as an error or a raw token dump.
 */
export function resourceWaitReasonLabel(waitReason: string): string {
  return WAIT_REASON_LABELS[waitReason] ?? deSnake(waitReason);
}

/** Format a future queue check without sending future timestamps through the past-only `relativeTime`. */
export function futureQueueTime(
  date: Date | string,
  nowMs = Date.now(),
): string {
  const thenMs = new Date(date).getTime();
  if (!Number.isFinite(thenMs)) return "Unknown";

  const remainingSeconds = Math.max(0, Math.ceil((thenMs - nowMs) / 1000));
  if (remainingSeconds === 0) return "now";
  if (remainingSeconds < 60) return `in ${remainingSeconds}s`;

  const remainingMinutes = Math.ceil(remainingSeconds / 60);
  if (remainingMinutes < 60) return `in ${remainingMinutes}m`;

  const remainingHours = Math.ceil(remainingMinutes / 60);
  if (remainingHours < 24) return `in ${remainingHours}h`;

  const remainingDays = Math.ceil(remainingHours / 24);
  return `in ${remainingDays}d`;
}

function deSnake(value: string): string {
  const cleaned = value.replace(/_/g, " ").trim();
  if (!cleaned) return value;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
