// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QueueTelemetryDetails, RunQueueWaitBadge } from "./RunQueueWait";
import type { RunQueueTelemetry } from "../lib/run-queue-status";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// `import { act } from "react"` is undefined in this React build, so the
// maintained suites drive renders through a flushSync-backed local `act`.
function act<T>(cb: () => T): T {
  let result: T | undefined;
  flushSync(() => {
    result = cb();
  });
  return result as T;
}

const TELEMETRY: RunQueueTelemetry = {
  actionClass: "shared_write",
  resourceKey: "workspace:paperclip/main",
  waitReason: "resource_lease_held_by_another_run",
  blockingRunId: "run-99887766",
  waitingSinceAt: "2026-07-15T10:00:00.000Z",
  queuePosition: 3,
  nextCheckAt: "2026-07-15T10:05:00.000Z",
};

describe("RunQueueWaitBadge", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders nothing for a non-queued run", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<RunQueueWaitBadge status="running" />);
    });
    expect(container.querySelector('[data-testid="run-queue-wait-badge"]')).toBeNull();
    act(() => root.unmount());
  });

  it("renders a generic amber capacity-wait badge with no live wording", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<RunQueueWaitBadge status="queued" telemetry={null} />);
    });
    const badge = container.querySelector('[data-testid="run-queue-wait-badge"]');
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute("data-wait-kind")).toBe("capacity");
    expect(badge?.getAttribute("role")).toBe("status");
    expect(badge?.textContent).toContain("Queued");
    expect(badge?.textContent?.toLowerCase()).not.toContain("live");
    // Amber tone, never the live/running blue.
    expect(badge?.className).toContain("amber");
    expect(badge?.className).not.toContain("blue");
    act(() => root.unmount());
  });

  it("shows the queue position for a resource wait", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<RunQueueWaitBadge status="queued" telemetry={TELEMETRY} />);
    });
    const badge = container.querySelector('[data-testid="run-queue-wait-badge"]');
    expect(badge?.getAttribute("data-wait-kind")).toBe("resource");
    expect(badge?.textContent).toContain("#3");
    expect(badge?.getAttribute("aria-label")).toContain("position 3");
    act(() => root.unmount());
  });
});

describe("QueueTelemetryDetails", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders nothing when telemetry is null (legacy runs)", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<QueueTelemetryDetails telemetry={null} />);
    });
    expect(container.querySelector('[data-testid="queue-telemetry-details"]')).toBeNull();
    act(() => root.unmount());
  });

  it("renders nothing when telemetry is undefined", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<QueueTelemetryDetails telemetry={undefined} />);
    });
    expect(container.querySelector('[data-testid="queue-telemetry-details"]')).toBeNull();
    act(() => root.unmount());
  });

  it("renders all seven contract telemetry fields with accessible grouping", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<QueueTelemetryDetails telemetry={TELEMETRY} />);
    });
    const panel = container.querySelector('[data-testid="queue-telemetry-details"]');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute("role")).toBe("group");
    expect(panel?.getAttribute("aria-label")).toBe("Resource wait details");

    const fieldValue = (testId: string) =>
      container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";

    // 1..7 — every contract field is surfaced.
    expect(fieldValue("queue-telemetry-action-class")).toContain("Shared write");
    expect(fieldValue("queue-telemetry-resource-key")).toContain("workspace:paperclip/main");
    expect(fieldValue("queue-telemetry-wait-reason")).toContain("Resource locked by another run");
    expect(fieldValue("queue-telemetry-blocking-run")).toContain("run-9988"); // short id
    expect(container.querySelector('[data-testid="queue-telemetry-waiting-since"] time')).not.toBeNull();
    expect(fieldValue("queue-telemetry-position")).toContain("#3");
    expect(container.querySelector('[data-testid="queue-telemetry-next-check"] time')).not.toBeNull();

    // Never advertises a live/running state.
    expect(panel?.textContent?.toLowerCase()).not.toContain("live now");
    act(() => root.unmount());
  });

  it("formats the next check as a future duration", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <QueueTelemetryDetails
          telemetry={{
            ...TELEMETRY,
            nextCheckAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          }}
        />,
      );
    });
    expect(container.querySelector('[data-testid="queue-telemetry-next-check"]')?.textContent).toBe("in 5m");
    act(() => root.unmount());
  });

  it("degrades gracefully when blockingRunId is null (capacity-style entry)", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<QueueTelemetryDetails telemetry={{ ...TELEMETRY, blockingRunId: null }} />);
    });
    const blocking = container.querySelector('[data-testid="queue-telemetry-blocking-run"]');
    expect(blocking?.textContent).toContain("—");
    // Still renders the panel and the remaining fields.
    expect(container.querySelector('[data-testid="queue-telemetry-position"]')?.textContent).toContain("#3");
    act(() => root.unmount());
  });
});
