import { memo, useMemo } from "react";
import type { TranscriptEntry } from "../adapters";
import type { LiveRunForIssue } from "../api/heartbeats";
import { IssueChatThread } from "./IssueChatThread";
import type { IssueChatLinkedRun } from "../lib/issue-chat-messages";
import { isRunLive, isRunQueued } from "../lib/run-queue-status";

const EMPTY_COMMENTS: [] = [];
const EMPTY_TIMELINE_EVENTS: [] = [];
const EMPTY_LIVE_RUNS: [] = [];
const EMPTY_LINKED_RUNS: [] = [];
const handleEmbeddedAdd = async () => {};

interface RunChatSurfaceProps {
  run: LiveRunForIssue;
  transcript: TranscriptEntry[];
  hasOutput: boolean;
  companyId?: string | null;
}

export const RunChatSurface = memo(function RunChatSurface({
  run,
  transcript,
  hasOutput,
  companyId,
}: RunChatSurfaceProps) {
  // Only a truly-live (running) run drives the live/streaming message path. A
  // queued run has produced no output and is surfaced through the static
  // linked-run path, where it renders as waiting rather than live or complete.
  const live = isRunLive(run.status);
  const queued = isRunQueued(run.status);
  const liveRuns = useMemo(() => (live ? [run] : EMPTY_LIVE_RUNS), [live, run]);
  const linkedRuns = useMemo<IssueChatLinkedRun[]>(
    () =>
      live
        ? EMPTY_LINKED_RUNS
        : [{
            runId: run.id,
            status: run.status,
            agentId: run.agentId,
            agentName: run.agentName,
            createdAt: run.createdAt,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
          }],
    [live, run],
  );
  const transcriptsByRunId = useMemo(
    () => new Map([[run.id, transcript as readonly TranscriptEntry[]]]),
    [run.id, transcript],
  );
  return (
    <IssueChatThread
      comments={EMPTY_COMMENTS}
      linkedRuns={linkedRuns}
      timelineEvents={EMPTY_TIMELINE_EVENTS}
      liveRuns={liveRuns}
      companyId={companyId}
      onAdd={handleEmbeddedAdd}
      showComposer={false}
      showJumpToLatest={false}
      variant="embedded"
      emptyMessage={live ? "Waiting for run output..." : queued ? "Waiting to start…" : "No run output captured."}
      enableLiveTranscriptPolling={false}
      transcriptsByRunId={transcriptsByRunId}
      hasOutputForRun={(runId) => runId === run.id && hasOutput}
      includeSucceededRunsWithoutOutput
    />
  );
});
