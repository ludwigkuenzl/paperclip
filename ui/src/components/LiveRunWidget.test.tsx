// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveRunWidget } from "./LiveRunWidget";

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForIssue: vi.fn(),
  activeRunForIssue: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../api/heartbeats", () => ({ heartbeatsApi: mockHeartbeatsApi }));

vi.mock("./transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: () => ({
    transcriptByRun: new Map(),
    hasOutputForRun: () => false,
  }),
}));

vi.mock("./RunChatSurface", () => ({
  RunChatSurface: () => <div>Run output</div>,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("LiveRunWidget", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockHeartbeatsApi.activeRunForIssue.mockResolvedValue(null);
    mockHeartbeatsApi.liveRunsForIssue.mockResolvedValue([
      {
        id: "run-queued",
        status: "queued",
        invocationSource: "assignment",
        triggerDetail: null,
        startedAt: null,
        finishedAt: null,
        createdAt: "2026-07-15T10:00:00.000Z",
        agentId: "agent-1",
        agentName: "Agent 1",
        adapterType: "codex_local",
        issueId: "issue-1",
      },
    ]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("labels a queue-only task as queued rather than live", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <LiveRunWidget issueId="issue-1" companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Queued Runs");
    expect(container.textContent).not.toContain("Live Runs");
    expect(container.querySelector('[data-testid="run-queue-wait-badge"]')).not.toBeNull();

    await act(async () => root.unmount());
  });
});
