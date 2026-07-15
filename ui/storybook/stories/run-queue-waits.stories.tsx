import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueueTelemetryDetails, RunQueueWaitBadge } from "@/components/RunQueueWait";
import type { RunQueueTelemetry } from "@/lib/run-queue-status";

// A queued run blocked on an exclusive resource lease — carries the full
// seven-field telemetry contract (actionClass, resourceKey, waitReason,
// blockingRunId, waitingSinceAt, queuePosition, nextCheckAt).
const RESOURCE_WAIT: RunQueueTelemetry = {
  actionClass: "shared_write",
  resourceKey: "workspace:paperclip/main",
  waitReason: "resource_lease_held_by_another_run",
  blockingRunId: "run-3d55e8a1",
  waitingSinceAt: new Date(Date.now() - 4 * 60_000).toISOString(),
  queuePosition: 2,
  nextCheckAt: new Date(Date.now() + 60_000).toISOString(),
};

function RunHeader({
  title,
  status,
  telemetry,
}: {
  title: string;
  status: string;
  telemetry?: RunQueueTelemetry | null;
}) {
  const live = status === "running";
  return (
    <div
      className={
        "flex flex-col gap-2 rounded-xl border p-3 " +
        (live
          ? "border-blue-500/25 bg-blue-500/[0.04]"
          : status === "queued"
            ? "border-amber-500/30 bg-amber-500/[0.04]"
            : "border-border bg-background/70")
      }
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        {live ? (
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-70" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-blue-500" />
          </span>
        ) : status === "queued" ? (
          <span className="inline-flex h-2.5 w-2.5 rounded-full bg-amber-500" />
        ) : (
          <span className="inline-flex h-2.5 w-2.5 rounded-full bg-muted-foreground/35" />
        )}
        {title}
        {live ? (
          <span className="text-xs font-normal text-blue-600 dark:text-blue-400">Live now</span>
        ) : (
          <RunQueueWaitBadge status={status} telemetry={telemetry} />
        )}
      </div>
      <QueueTelemetryDetails telemetry={telemetry} />
    </div>
  );
}

function StoryFrame({ children, note }: { children: React.ReactNode; note: string }) {
  return (
    <div className="max-w-[560px] space-y-3 p-6">
      {children}
      <p className="text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

const meta = {
  title: "Product/Run Queue Waits",
  parameters: {
    docs: {
      description: {
        component:
          "Queue and resource wait states. `running` reads as live (blue, animated, 'Live now'); `queued` reads as waiting (amber, static, never 'Live now'). A resource-blocked run surfaces all seven telemetry fields; a plain capacity-queued run and legacy runs without telemetry degrade cleanly.",
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

// Scenario 1 — a run waiting for an exclusive resource lease.
export const ResourceWait: Story = {
  render: () => (
    <StoryFrame note="Queued on a shared_write lease held by another run. Amber wait state with the full seven-field telemetry panel — no false live status.">
      <RunHeader title="Frontend Engineer" status="queued" telemetry={RESOURCE_WAIT} />
    </StoryFrame>
  ),
};

// Scenario 2 — a normal agent-capacity queue (no resource lease, null telemetry).
export const AgentCapacityQueue: Story = {
  render: () => (
    <StoryFrame note="Queued for agent capacity — no resource telemetry. Renders the generic amber 'Queued' badge and no resource panel; a legacy run with null telemetry renders identically without error.">
      <RunHeader title="CTO" status="queued" telemetry={null} />
    </StoryFrame>
  ),
};

// Contrast — running (live) vs the two queued variants side by side.
export const LiveVersusQueued: Story = {
  render: () => (
    <StoryFrame note="Left to right: a live running run, a resource-blocked queued run, and a capacity-queued run. Only 'running' animates and reads as live.">
      <div className="space-y-3">
        <RunHeader title="Running now" status="running" telemetry={null} />
        <RunHeader title="Waiting for resource" status="queued" telemetry={RESOURCE_WAIT} />
        <RunHeader title="Waiting for capacity" status="queued" telemetry={null} />
      </div>
    </StoryFrame>
  ),
};
