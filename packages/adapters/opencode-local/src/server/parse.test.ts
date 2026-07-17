import { describe, expect, it } from "vitest";
import { parseOpenCodeJsonl, isOpenCodeUnknownSessionError } from "./parse.js";

describe("parseOpenCodeJsonl", () => {
  it("parses assistant text, usage, cost, and errors", () => {
    const stdout = [
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Hello from OpenCode" },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "session_123",
        part: {
          reason: "done",
          cost: 0.0025,
          tokens: {
            input: 120,
            output: 40,
            reasoning: 10,
            cache: { read: 20, write: 0 },
          },
        },
      }),
      JSON.stringify({
        type: "error",
        sessionID: "session_123",
        error: { message: "model unavailable" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("session_123");
    expect(parsed.summary).toBe("Hello from OpenCode");
    expect(parsed.usage).toEqual({
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 50,
    });
    expect(parsed.costUsd).toBeCloseTo(0.0025, 6);
    expect(parsed.errorMessage).toContain("model unavailable");
    expect(parsed.toolErrors).toEqual([]);
  });

  it("keeps failed tool calls separate from fatal run errors", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_use",
        sessionID: "session_123",
        part: {
          state: {
            status: "error",
            error: "File not found: e2b-adapter-result.txt",
          },
        },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Recovered and completed the task" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("session_123");
    expect(parsed.summary).toBe("Recovered and completed the task");
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.toolErrors).toEqual(["File not found: e2b-adapter-result.txt"]);
  });

  it("reports a structured background task launch as pending", () => {
    const parsed = parseOpenCodeJsonl(JSON.stringify({
      type: "tool_use",
      sessionID: "session_123",
      part: {
        tool: "task",
        state: {
          status: "completed",
          metadata: { background: true, jobId: "job-1", sessionId: "child-1" },
          output: '<task id="job-1" state="running">explore</task>',
        },
      },
    }));

    expect(parsed.pendingBackgroundTasks).toEqual(["job-1"]);
  });

  it("clears a pending background task only on a structured terminal signal", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_use",
        sessionID: "session_123",
        part: {
          tool: "task",
          state: {
            status: "completed",
            metadata: { background: true, jobId: "job-1" },
            output: '<task id="job-1" state="running">explore</task>',
          },
        },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: '<task id="job-1" state="completed">done</task>' },
      }),
    ].join("\n");

    expect(parseOpenCodeJsonl(stdout).pendingBackgroundTasks).toEqual([]);
  });

  it("keeps the remaining task when only one of two background tasks completes", () => {
    const stdout = [
      ["job-1", "job-2"].map((jobId) => JSON.stringify({
        type: "tool_use",
        sessionID: "session_123",
        part: {
          tool: "task",
          state: {
            status: "completed",
            metadata: { background: true, jobId },
            output: `<task id="${jobId}" state="running">explore</task>`,
          },
        },
      })).join("\n"),
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: '<task id="job-1" state="completed">done</task>' },
      }),
    ].join("\n");

    expect(parseOpenCodeJsonl(stdout).pendingBackgroundTasks).toEqual(["job-2"]);
  });

  it("does not infer pending children from foreground tasks or natural language", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_use",
        sessionID: "session_123",
        part: {
          tool: "task",
          state: {
            status: "completed",
            metadata: { background: false, jobId: "job-1" },
            output: '<task id="job-1" state="running">foreground</task>',
          },
        },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "I am waiting for another agent." },
      }),
    ].join("\n");

    expect(parseOpenCodeJsonl(stdout).pendingBackgroundTasks).toEqual([]);
  });

  it("fails safe when a background launch has no structured task id", () => {
    const parsed = parseOpenCodeJsonl(JSON.stringify({
      type: "tool_use",
      sessionID: "session_123",
      part: {
        tool: "task",
        state: {
          status: "completed",
          metadata: { background: true },
          output: "Background task launched.",
        },
      },
    }));

    expect(parsed.pendingBackgroundTasks).toEqual(["unidentified:session_123"]);
  });

  it("detects unknown session errors", () => {
    expect(isOpenCodeUnknownSessionError("Session not found: s_123", "")).toBe(true);
    expect(isOpenCodeUnknownSessionError("", "unknown session id")).toBe(true);
    expect(isOpenCodeUnknownSessionError("all good", "")).toBe(false);
  });
});
