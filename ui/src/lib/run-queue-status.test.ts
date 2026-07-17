import { describe, expect, it } from "vitest";
import type { RunQueueTelemetry } from "./run-queue-status";
import {
  futureQueueTime,
  isResourceWait,
  isRunLive,
  isRunQueued,
  isRunWatched,
  resourceActionClassLabel,
  resourceWaitReasonLabel,
} from "./run-queue-status";

const TELEMETRY: RunQueueTelemetry = {
  actionClass: "shared_write",
  resourceKey: "workspace:main",
  waitReason: "resource_lease_held_by_another_run",
  blockingRunId: "run-blocker",
  waitingSinceAt: "2026-07-15T10:00:00.000Z",
  queuePosition: 2,
  nextCheckAt: "2026-07-15T10:05:00.000Z",
};

describe("run liveness predicates", () => {
  it("treats only running as live", () => {
    expect(isRunLive("running")).toBe(true);
    expect(isRunLive("queued")).toBe(false);
    expect(isRunLive("succeeded")).toBe(false);
    expect(isRunLive(null)).toBe(false);
    expect(isRunLive(undefined)).toBe(false);
  });

  it("treats only queued as queued/waiting", () => {
    expect(isRunQueued("queued")).toBe(true);
    expect(isRunQueued("running")).toBe(false);
    expect(isRunQueued(null)).toBe(false);
  });

  it("treats running and queued as watched (non-terminal), nothing else", () => {
    expect(isRunWatched("running")).toBe(true);
    expect(isRunWatched("queued")).toBe(true);
    expect(isRunWatched("succeeded")).toBe(false);
    expect(isRunWatched("failed")).toBe(false);
    expect(isRunWatched(undefined)).toBe(false);
  });

  it("live and queued are mutually exclusive", () => {
    for (const status of ["running", "queued", "succeeded", "failed", "cancelled"]) {
      expect(isRunLive(status) && isRunQueued(status)).toBe(false);
    }
  });

  it("only classifies a queued run with telemetry as a resource wait", () => {
    expect(isResourceWait("queued", TELEMETRY)).toBe(true);
    expect(isResourceWait("queued", null)).toBe(false);
    expect(isResourceWait("queued", undefined)).toBe(false);
    // A running run is live, never a resource wait, even with telemetry present.
    expect(isResourceWait("running", TELEMETRY)).toBe(false);
  });
});

describe("label helpers", () => {
  it("maps every contract action class to a human label", () => {
    expect(resourceActionClassLabel("read_only")).toBe("Read-only");
    expect(resourceActionClassLabel("shared_write")).toBe("Shared write");
    expect(resourceActionClassLabel("deploy")).toBe("Deploy");
    expect(resourceActionClassLabel("external_action")).toBe("External action");
  });

  it("falls back to a de-snake-cased label for unknown action classes", () => {
    expect(resourceActionClassLabel("brand_new_class")).toBe("Brand new class");
  });

  it("maps known wait reasons to readable copy", () => {
    expect(resourceWaitReasonLabel("resource_lease_held_by_another_run")).toBe(
      "Resource locked by another run",
    );
    expect(resourceWaitReasonLabel("expired_lease_requires_owner_and_target_readback")).toBe(
      "Expired lease needs recovery",
    );
  });

  it("never returns a raw token dump for an unknown wait reason", () => {
    const label = resourceWaitReasonLabel("some_future_reason_code");
    expect(label).toBe("Some future reason code");
    expect(label).not.toContain("_");
  });
});

describe("futureQueueTime", () => {
  const now = new Date("2026-07-15T10:00:00.000Z").getTime();

  it("formats future checks as a forward-looking duration", () => {
    expect(futureQueueTime("2026-07-15T10:05:00.000Z", now)).toBe("in 5m");
    expect(futureQueueTime("2026-07-15T10:00:25.000Z", now)).toBe("in 25s");
  });

  it("handles due and invalid checks without past-tense output", () => {
    expect(futureQueueTime("2026-07-15T10:00:00.000Z", now)).toBe("now");
    expect(futureQueueTime("not-a-date", now)).toBe("Unknown");
  });
});
