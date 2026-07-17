// @vitest-environment jsdom

// Real-surface regression for GLA-1462: a `queued` run rendered through the
// *actual* RunChatSurface (real IssueChatThread + real message builder, no
// stubbed thread) must read as a static queue-wait state — never as a live
// "Running" run and never as a completed "Run finished" run.

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveRunForIssue } from "../api/heartbeats";
import { RunChatSurface } from "./RunChatSurface";

// The thread pulls in the assistant-ui runtime and a handful of heavy leaf
// components. Stub only the infrastructure — the run-row rendering path
// (RunStatusBadge, message builder) stays real so the assertions exercise
// production code.
vi.mock("@assistant-ui/react", () => ({
  AssistantRuntimeProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useAui: () => ({ thread: () => ({ append: vi.fn(async () => undefined) }) }),
}));

vi.mock("./transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: () => ({
    transcriptByRun: new Map(),
    hasOutputForRun: () => false,
  }),
}));

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: () => null,
}));

vi.mock("./InlineEntitySelector", () => ({
  InlineEntitySelector: () => null,
}));

vi.mock("./Identity", () => ({
  Identity: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock("./OutputFeedbackButtons", () => ({
  OutputFeedbackButtons: () => null,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("./AgentIconPicker", () => ({
  AgentIcon: () => null,
}));

vi.mock("../hooks/usePaperclipIssueRuntime", () => ({
  usePaperclipIssueRuntime: () => ({}),
}));

// The run row links agents/runs via the company-aware `Link`, which needs a
// CompanyProvider. Swap it for a plain anchor so the test stays focused on the
// queued-run presentation without wiring the full company/router context.
vi.mock("@/lib/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/router")>();
  return {
    ...actual,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Link: ({ to, children, ...props }: any) => (
      <a href={typeof to === "string" ? to : "#"} {...props}>
        {children}
      </a>
    ),
  };
});

const queuedRun: LiveRunForIssue = {
  id: "run-queued-1",
  status: "queued",
  agentId: "agent-1",
  agentName: "CodexCoder",
  createdAt: new Date("2026-04-06T12:00:00.000Z").toISOString(),
  startedAt: null,
  finishedAt: null,
} as LiveRunForIssue;

describe("RunChatSurface queued run presentation (GLA-1462)", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    window.scrollTo = vi.fn();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("shows a static queue-wait state, never Running or Run finished", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <RunChatSurface run={queuedRun} transcript={[]} hasOutput={false} />
        </MemoryRouter>,
      );
    });

    // Visible queue-wait state via the amber run-status badge.
    const badge = container.querySelector('[data-testid="run-status-badge"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain("queued");
    // Amber (waiting), never blue (running/live).
    expect(badge?.className).toContain("text-amber-700");
    expect(badge?.className).not.toContain("text-blue-700");

    // No completion / live signal leaked into the surface.
    expect(container.textContent).not.toContain("Run finished");
    expect(container.textContent).not.toContain("Working...");
    expect(container.textContent).not.toContain("Live now");

    await act(async () => {
      root.unmount();
    });
  });
});
