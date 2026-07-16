import { afterEach, describe, expect, it } from "vitest";

import {
  classifyOpenCodeTerminalResult,
  ensureRemoteOpenCodeModelConfiguredAndAvailable,
} from "./execute.js";

describe("classifyOpenCodeTerminalResult", () => {
  it("turns a clean exit with pending background children into a non-success result", () => {
    expect(classifyOpenCodeTerminalResult({
      rawExitCode: 0,
      parsedError: "",
      stderr: "",
      pendingBackgroundTasks: ["job-1", "job-2"],
    })).toEqual({
      exitCode: 1,
      errorCode: "pending_children",
      errorMessage: expect.stringContaining("job-1, job-2"),
    });
  });

  it("keeps a clean exit successful when no background children are pending", () => {
    expect(classifyOpenCodeTerminalResult({
      rawExitCode: 0,
      parsedError: "",
      stderr: "",
      pendingBackgroundTasks: [],
    })).toEqual({
      exitCode: 0,
      errorCode: null,
      errorMessage: null,
    });
  });
});

describe("ensureRemoteOpenCodeModelConfiguredAndAvailable", () => {
  afterEach(() => {
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
  });

  // The remote/sandbox execution path must honour OPENCODE_ALLOW_ALL_MODELS just
  // like the local path: gateway-routed models (e.g. anthropic/<gateway>/<model>
  // via Bifrost) never appear in `opencode models`, so the availability probe
  // must be skipped. The early return happens before the executionTarget is ever
  // touched, so a bogus target proves the probe was not run.
  const bogusTarget = {} as never;

  it("skips the remote availability probe when OPENCODE_ALLOW_ALL_MODELS is set in the run env", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-1",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("honours OPENCODE_ALLOW_ALL_MODELS from the process env", async () => {
    process.env.OPENCODE_ALLOW_ALL_MODELS = "1";
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-2",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: {},
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("still enforces provider/model format even when the bypass flag is set", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-3",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).rejects.toThrow();
  });
});
