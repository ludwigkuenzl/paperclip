// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveRunForIssue } from "../api/heartbeats";
import { RunChatSurface } from "./RunChatSurface";

vi.mock("./IssueChatThread", () => ({
  IssueChatThread: ({
    liveRuns,
    linkedRuns,
    emptyMessage,
  }: {
    liveRuns: LiveRunForIssue[];
    linkedRuns: Array<{ status: string }>;
    emptyMessage: string;
  }) => (
    <div
      data-testid="nux-thread"
      data-live-count={liveRuns.length}
      data-linked-count={linkedRuns.length}
      data-linked-status={linkedRuns[0]?.status ?? ""}
      data-empty-message={emptyMessage}
    >
      NUX thread
    </div>
  ),
}));

const run: LiveRunForIssue = {
  id: "run-1",
  status: "running",
  agentId: "agent-1",
  agentName: "Agent",
  createdAt: new Date(0).toISOString(),
  startedAt: new Date(0).toISOString(),
  finishedAt: null,
} as LiveRunForIssue;

function act(callback: () => void) {
  flushSync(callback);
}

async function renderSurface(surfaceRun: LiveRunForIssue = run) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<RunChatSurface run={surfaceRun} transcript={[]} hasOutput={false} />);
  });
  return {
    container,
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("RunChatSurface thread presentation", () => {
  it("renders the graduated issue thread without a chat-flag branch", async () => {
    const { container, cleanup } = await renderSurface();
    expect(container.querySelector('[data-testid="nux-thread"]')).not.toBeNull();
    await cleanup();
  });

  it("keeps a queued run on the static linked path instead of marking it live", async () => {
    const { container, cleanup } = await renderSurface({ ...run, status: "queued", startedAt: null });
    const thread = container.querySelector('[data-testid="nux-thread"]');
    expect(thread?.getAttribute("data-live-count")).toBe("0");
    expect(thread?.getAttribute("data-linked-count")).toBe("1");
    expect(thread?.getAttribute("data-linked-status")).toBe("queued");
    expect(thread?.getAttribute("data-empty-message")).toBe("Waiting to start…");
    await cleanup();
  });

  it("uses the historical path only after a run reaches a terminal status", async () => {
    const { container, cleanup } = await renderSurface({
      ...run,
      status: "succeeded",
      finishedAt: new Date(60_000).toISOString(),
    });
    const thread = container.querySelector('[data-testid="nux-thread"]');
    expect(thread?.getAttribute("data-live-count")).toBe("0");
    expect(thread?.getAttribute("data-linked-count")).toBe("1");
    expect(thread?.getAttribute("data-linked-status")).toBe("succeeded");
    await cleanup();
  });
});
