import { Clock, Lock } from "lucide-react";
import { cn, formatDateTime, relativeTime } from "../lib/utils";
import {
  futureQueueTime,
  isRunQueued,
  resourceActionClassLabel,
  resourceWaitReasonLabel,
  type RunQueueTelemetry,
} from "../lib/run-queue-status";

/**
 * Amber, wait-related run indicators. A queued run is never "live":
 * it renders a static amber badge (no ping / pulse) and, when it is blocked on a
 * specific resource lease, the full seven-field {@link QueueTelemetryDetails}
 * panel. Both degrade to nothing / a generic wait when telemetry is absent so
 * legacy runs without `resourceQueueTelemetry` render without error.
 */

// Amber wait tone — matches the recovery/attention amber used elsewhere so the
// palette stays canonical (no bespoke queue colours).
const WAIT_TONE = "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200";
const WAIT_BADGE_TONE = "border-amber-500/50 bg-amber-500/15 text-amber-700 dark:text-amber-300";

export function RunQueueWaitBadge({
  status,
  telemetry,
  className,
}: {
  status: string | null | undefined;
  telemetry?: RunQueueTelemetry | null;
  className?: string;
}) {
  if (!isRunQueued(status)) return null;
  const label = telemetry
    ? `Waiting for resource · #${telemetry.queuePosition}`
    : "Queued";
  const Icon = telemetry ? Lock : Clock;
  return (
    <span
      role="status"
      data-testid="run-queue-wait-badge"
      data-wait-kind={telemetry ? "resource" : "capacity"}
      aria-label={
        telemetry
          ? `Queued, waiting for resource, position ${telemetry.queuePosition}`
          : "Queued, waiting to start"
      }
      title={
        telemetry
          ? `Waiting for ${telemetry.resourceKey} — ${resourceWaitReasonLabel(telemetry.waitReason)}`
          : "Waiting for agent capacity to start"
      }
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-(length:--text-micro) font-medium whitespace-nowrap",
        WAIT_BADGE_TONE,
        className,
      )}
    >
      <Icon className="h-2.5 w-2.5 shrink-0" aria-hidden />
      {label}
    </span>
  );
}

function TelemetryField({
  label,
  children,
  testId,
}: {
  label: string;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-(length:--text-nano) uppercase tracking-(--tracking-caps) text-amber-700/80 dark:text-amber-300/80">
        {label}
      </dt>
      <dd data-testid={testId} className="mt-0.5 min-w-0 break-words text-xs text-foreground">
        {children}
      </dd>
    </div>
  );
}

function TimeValue({ iso, future = false }: { iso: string; future?: boolean }) {
  return (
    <time dateTime={iso} title={formatDateTime(iso)}>
      {future ? futureQueueTime(iso) : relativeTime(iso)}
    </time>
  );
}

/**
 * Renders the seven contract telemetry fields for a resource-blocked run:
 * `actionClass`, `resourceKey`, `waitReason`, `blockingRunId`, `waitingSinceAt`,
 * `queuePosition`, `nextCheckAt`. Returns `null` for empty / nullable telemetry
 * (backward compatible with legacy runs).
 */
export function QueueTelemetryDetails({
  telemetry,
  className,
}: {
  telemetry: RunQueueTelemetry | null | undefined;
  className?: string;
}) {
  if (!telemetry) return null;
  return (
    <section
      role="group"
      aria-label="Resource wait details"
      data-testid="queue-telemetry-details"
      className={cn("rounded-md border px-2.5 py-2", WAIT_TONE, className)}
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-amber-800 dark:text-amber-200">
        <Lock className="h-3 w-3 shrink-0" aria-hidden />
        Waiting for resource
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-3">
        <TelemetryField label="Action" testId="queue-telemetry-action-class">
          {resourceActionClassLabel(telemetry.actionClass)}
        </TelemetryField>
        <TelemetryField label="Resource" testId="queue-telemetry-resource-key">
          <span className="font-mono">{telemetry.resourceKey}</span>
        </TelemetryField>
        <TelemetryField label="Reason" testId="queue-telemetry-wait-reason">
          <span title={telemetry.waitReason}>{resourceWaitReasonLabel(telemetry.waitReason)}</span>
        </TelemetryField>
        <TelemetryField label="Blocked by run" testId="queue-telemetry-blocking-run">
          {telemetry.blockingRunId ? (
            <span className="font-mono">{telemetry.blockingRunId.slice(0, 8)}</span>
          ) : (
            <span className="text-muted-foreground" aria-label="No blocking run">
              —
            </span>
          )}
        </TelemetryField>
        <TelemetryField label="Waiting since" testId="queue-telemetry-waiting-since">
          <TimeValue iso={telemetry.waitingSinceAt} />
        </TelemetryField>
        <TelemetryField label="Queue position" testId="queue-telemetry-position">
          #{telemetry.queuePosition}
        </TelemetryField>
        <TelemetryField label="Next check" testId="queue-telemetry-next-check">
          <TimeValue iso={telemetry.nextCheckAt} future />
        </TelemetryField>
      </dl>
    </section>
  );
}
